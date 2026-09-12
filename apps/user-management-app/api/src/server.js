// user-management-app-api — Express service.
//   POST /api/login    { username, password }  -> { token }   (JWT, 1h)
//   GET  /api/users    Authorization: Bearer <token>  -> [{ id, username, full_name, email, created_at }]
//   GET  /api/healthz  -> 200
//   GET  /metrics      -> Prometheus metrics (scraped by the ServiceMonitor)
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const client = require("prom-client");
const { pool } = require("./db");

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
});
app.use((req, res, next) => {
  const end = httpHist.startTimer();
  res.on("finish", () =>
    end({ method: req.method, route: req.route ? req.route.path : req.path, status: res.statusCode })
  );
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
    console.error("login error", err);
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

app.get("/api/users", auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, full_name, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error("users error", err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = { app };

// Only bind a port when run directly (`node src/server.js` / the container CMD) — not
// when required by tests (test/server.test.js), which call app.listen(0) themselves.
if (require.main === module) {
  app.listen(PORT, () => console.log(`user-management-app-api listening on :${PORT} (env=${APP_ENV})`));
}
