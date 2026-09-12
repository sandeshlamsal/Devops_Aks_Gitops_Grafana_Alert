// Integration tests against a real Postgres (DATABASE_URL env — CI runs one as a
// service container; locally point it at any throwaway database). No mocking: these
// exercise the exact SQL that ships to prod.
//
// This file and server.test.js share ONE live database (there's no per-file
// isolation), and node:test runs test *files* concurrently by default — that races
// this file's schema resets against server.test.js's requests. `npm test` therefore
// runs with `--test-concurrency=1` (see package.json). Don't drop that flag.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { migrate } = require("../src/migrate");
const { seedUsers, USERS } = require("../src/seed");
const { pool } = require("../src/db");

test.before(async () => {
  await migrate({ reset: true }); // start every run from a clean schema
});

test.after(async () => {
  await pool.end();
});

test("migrate creates the users table", async () => {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS t");
  assert.ok(rows[0].t, "public.users should exist after migrate()");
});

test("migrate is idempotent (safe to re-run)", async () => {
  await assert.doesNotReject(() => migrate({ reset: false }));
});

test("seed inserts all demo users exactly once", async () => {
  const n1 = await seedUsers();
  assert.equal(n1, USERS.length);
  const n2 = await seedUsers(); // re-run: ON CONFLICT DO NOTHING
  assert.equal(n2, USERS.length, "seeding twice must not duplicate rows");
});

test("seeded users have a bcrypt hash that verifies against password123", async () => {
  const { rows } = await pool.query(
    "SELECT password_hash FROM users WHERE username = $1",
    ["admin"]
  );
  assert.equal(rows.length, 1);
  assert.ok(await bcrypt.compare("password123", rows[0].password_hash));
  assert.ok(!(await bcrypt.compare("wrong-password", rows[0].password_hash)));
});

test("--reset drops existing data before re-migrating", async () => {
  await pool.query("INSERT INTO users (username, password_hash) VALUES ('temp', 'x')");
  await migrate({ reset: true });
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
  assert.equal(rows[0].n, 0, "reset should leave an empty users table");
  await seedUsers(); // leave the DB seeded for any test run after this file
});
