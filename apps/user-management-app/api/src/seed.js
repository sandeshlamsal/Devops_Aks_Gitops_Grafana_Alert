// Fixtures. Idempotent: ON CONFLICT (username) DO NOTHING, so it is safe to run on
// every deploy. All demo users share the password `password123`.
// `seedUsers()` is exported so tests (test/db.test.js) can call it directly.
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

const USERS = [
  { username: "admin",   full_name: "Ada Admin",      email: "admin@example.com" },
  { username: "bwayne",  full_name: "Bruce Wayne",    email: "bruce@example.com" },
  { username: "ckent",   full_name: "Clark Kent",     email: "clark@example.com" },
  { username: "dprince", full_name: "Diana Prince",   email: "diana@example.com" },
  { username: "bbanner", full_name: "Bruce Banner",   email: "bruce.b@example.com" },
];

async function seedUsers() {
  const hash = await bcrypt.hash("password123", 10);
  const c = await pool.connect();
  try {
    for (const u of USERS) {
      await c.query(
        `INSERT INTO users (username, password_hash, full_name, email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        [u.username, hash, u.full_name, u.email]
      );
    }
    const { rows } = await c.query("SELECT count(*)::int AS n FROM users");
    console.log(`seed complete — ${rows[0].n} users`);
    return rows[0].n;
  } finally {
    c.release();
  }
}

module.exports = { seedUsers, USERS };

if (require.main === module) {
  seedUsers()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
