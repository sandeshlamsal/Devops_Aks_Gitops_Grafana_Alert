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

async function loginAs(username) {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  return (await r.json()).token;
}

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
  const token = await loginAs("admin");
  const r = await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const users = await r.json();
  assert.equal(users.length, 5);
  assert.ok(users.some((u) => u.username === "admin"));
  for (const u of users) assert.equal(u.password_hash, undefined);
});

test("GET /api/me returns the caller's own record, including is_admin", async () => {
  const adminToken = await loginAs("admin");
  const r1 = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).is_admin, true);

  const userToken = await loginAs("bwayne");
  const r2 = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${userToken}` } });
  assert.equal((await r2.json()).is_admin, false);
});

test("POST /api/users as a non-admin -> 403", async () => {
  const token = await loginAs("bwayne");
  const r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: "shouldnotexist", password: "password123" }),
  });
  assert.equal(r.status, 403);
});

test("POST /api/users as admin creates a user, hides password_hash", async () => {
  const token = await loginAs("admin");
  const r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: "newguy", password: "password123", full_name: "New Guy" }),
  });
  assert.equal(r.status, 201);
  const created = await r.json();
  assert.equal(created.username, "newguy");
  assert.equal(created.is_admin, false);
  assert.equal(created.password_hash, undefined);
});

test("POST /api/users with a short password -> 400", async () => {
  const token = await loginAs("admin");
  const r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: "shortpw", password: "abc" }),
  });
  assert.equal(r.status, 400);
});

test("POST /api/users with a duplicate username -> 409", async () => {
  const token = await loginAs("admin");
  const r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: "newguy", password: "password123" }),
  });
  assert.equal(r.status, 409);
});

test("PUT /api/users/:id as admin updates the target user", async () => {
  const token = await loginAs("admin");
  const list = await (await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const target = list.find((u) => u.username === "newguy");

  const r = await fetch(`${base}/api/users/${target.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ full_name: "Updated Name" }),
  });
  assert.equal(r.status, 200);
  const updated = await r.json();
  assert.equal(updated.full_name, "Updated Name");
  assert.equal(updated.username, "newguy", "unspecified fields stay unchanged");
});

test("PUT /api/users/:id as a non-admin -> 403", async () => {
  const adminToken = await loginAs("admin");
  const list = await (await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const target = list.find((u) => u.username === "newguy");

  const userToken = await loginAs("bwayne");
  const r = await fetch(`${base}/api/users/${target.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ full_name: "Nope" }),
  });
  assert.equal(r.status, 403);
});

test("DELETE /api/users/:id as admin removes the target user", async () => {
  const token = await loginAs("admin");
  const list = await (await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const target = list.find((u) => u.username === "newguy");

  const r = await fetch(`${base}/api/users/${target.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 204);

  const after = await (await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.ok(!after.some((u) => u.username === "newguy"));
});

test("DELETE /api/users/:id refuses to delete the last remaining admin", async () => {
  const token = await loginAs("admin");
  const list = await (await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const self = list.find((u) => u.username === "admin");

  const r = await fetch(`${base}/api/users/${self.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 409);
});
