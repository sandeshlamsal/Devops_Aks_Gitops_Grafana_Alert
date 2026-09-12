// HTTP-level tests against the real Express app (no supertest dependency — Node 20
// ships a global fetch, so we just app.listen(0) and hit it). Same DB as db.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { migrate } = require("../src/migrate");
const { seedUsers } = require("../src/seed");
const { pool } = require("../src/db");
const { app } = require("../src/server");

let server;
let base;

test.before(async () => {
  await migrate({ reset: true });
  await seedUsers();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test("GET /api/healthz -> 200", async () => {
  const r = await fetch(`${base}/api/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
});

test("POST /api/login with valid credentials returns a JWT", async () => {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.ok(token && token.split(".").length === 3, "should look like a JWT");
});

test("POST /api/login with a wrong password -> 401", async () => {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "not-it" }),
  });
  assert.equal(r.status, 401);
});

test("POST /api/login for an unknown user -> 401 (not 500)", async () => {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nobody", password: "x" }),
  });
  assert.equal(r.status, 401);
});

test("GET /api/users with no token -> 401", async () => {
  const r = await fetch(`${base}/api/users`);
  assert.equal(r.status, 401);
});

test("GET /api/users with a garbage token -> 401", async () => {
  const r = await fetch(`${base}/api/users`, { headers: { Authorization: "Bearer garbage" } });
  assert.equal(r.status, 401);
});

test("GET /api/users with a valid token returns the seeded users, no password_hash", async () => {
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  const { token } = await login.json();

  const r = await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const users = await r.json();
  assert.equal(users.length, 5);
  assert.ok(users.some((u) => u.username === "admin"));
  for (const u of users) assert.equal(u.password_hash, undefined);
});
