// user-management-app-api — Express service.
//   POST   /api/login       { username, password }  -> { token }   (JWT, 1h)
//   GET    /api/me          Authorization: Bearer <token>  -> own { id, username, full_name, email, is_admin }
//   GET    /api/users       Authorization: Bearer <token>  -> [{ id, username, full_name, email, is_admin, created_at }]
//   POST   /api/users       admin only  { username, password, full_name?, email?, is_admin? } -> created user
//   PUT    /api/users/:id   admin only  any subset of { username, password, full_name, email, is_admin } -> updated user
//   DELETE /api/users/:id   admin only  -> 204 (refuses to delete the last remaining admin)
//   GET    /api/healthz     -> 200
//   GET    /metrics         -> Prometheus metrics (scraped by the ServiceMonitor)
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const client = require("prom-client");
const { pool } = require("./db");
const log = require("./logger");

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret";
const APP_ENV = process.env.APP_ENV || "unknown";

const app = express();
app.use(express.json());

// --- metrics ---
client.collectDefaultMetrics();
const httpHist = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  // 0.3 = the latency SLO threshold (SRE/01-slis-and-slos.md) — without an explicit
  // bucket boundary here, prom-client's defaults have no le="0.3" to query, and the
  // latency SLI in SRE/01 is simply not computable.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2.5, 5],
});
app.use((req, res, next) => {
  const end = httpHist.startTimer();
  const startedAt = Date.now();
  res.on("finish", () => {
    const route = req.route ? req.route.path : req.path;
    end({ method: req.method, route, status: res.statusCode });
    // One structured log line per request, tagged with the active trace_id — this is
    // the line you'll find in Grafana's Explore (Loki) and jump from into Tempo.
    log.info("request", {
      method: req.method,
      route,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });
  next();
});

app.get("/api/healthz", (_req, res) => res.json({ ok: true, env: APP_ENV }));

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  try {
    const { rows } = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE username = $1",
      [username]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } catch (err) {
    log.error("login error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
});

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

// Fresh DB lookup, not a trust-the-JWT-claim shortcut — if an admin gets demoted their
// still-valid token stops working for mutations on their very next request, not just
// after it expires.
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user.sub]);
    if (!rows[0] || !rows[0].is_admin) return res.status(403).json({ error: "admin only" });
    next();
  } catch (err) {
    log.error("requireAdmin error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
}

app.get("/api/me", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, full_name, email, is_admin FROM users WHERE id = $1",
      [req.user.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    log.error("me error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
});

app.get("/api/users", auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, full_name, email, is_admin, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    log.error("users error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/users", auth, requireAdmin, async (req, res) => {
  const { username, password, full_name, email, is_admin } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, email, is_admin)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, full_name, email, is_admin, created_at`,
      [username, hash, full_name || null, email || null, !!is_admin]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "username already exists" });
    log.error("create user error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
});

app.put("/api/users/:id", auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { username, password, full_name, email, is_admin } = req.body || {};
  if (password && password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  try {
    const password_hash = password ? await bcrypt.hash(password, 10) : null;
    const { rows } = await pool.query(
      `UPDATE users SET
         username      = COALESCE($1, username),
         password_hash = COALESCE($2, password_hash),
         full_name     = COALESCE($3, full_name),
         email         = COALESCE($4, email),
         is_admin      = COALESCE($5, is_admin)
       WHERE id = $6
       RETURNING id, username, full_name, email, is_admin, created_at`,
      [username || null, password_hash, full_name || null, email || null, typeof is_admin === "boolean" ? is_admin : null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "username already exists" });
    log.error("update user error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
});

app.delete("/api/users/:id", auth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows: target } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [id]);
    if (!target[0]) return res.status(404).json({ error: "not found" });
    if (target[0].is_admin) {
      const { rows: adminCount } = await pool.query(
        "SELECT count(*)::int AS n FROM users WHERE is_admin = true"
      );
      if (adminCount[0].n <= 1) {
        return res.status(409).json({ error: "cannot delete the last remaining admin" });
      }
    }
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    res.status(204).end();
  } catch (err) {
    log.error("delete user error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = { app };

// Only bind a port when run directly (`node src/server.js` / the container CMD) — not
// when required by tests (test/server.test.js), which call app.listen(0) themselves.
if (require.main === module) {
  app.listen(PORT, () => console.log(`user-management-app-api listening on :${PORT} (env=${APP_ENV})`));
}
