// Fixtures. Idempotent: ON CONFLICT (username) DO NOTHING, so it is safe to run on
// every deploy. All demo users share the password `password123`.
// `seedUsers()` is exported so tests (test/db.test.js) can call it directly.
const bcrypt = require("bcryptjs");
const { pool } = require("./db");

const BASE_USERS = [
  { username: "admin",   full_name: "Ada Admin",      email: "admin@example.com",   is_admin: true },
  { username: "bwayne",  full_name: "Bruce Wayne",    email: "bruce@example.com",   is_admin: false },
  { username: "ckent",   full_name: "Clark Kent",     email: "clark@example.com",   is_admin: false },
  { username: "dprince", full_name: "Diana Prince",   email: "diana@example.com",   is_admin: false },
  { username: "bbanner", full_name: "Bruce Banner",   email: "bruce.b@example.com", is_admin: false },
];

// Fixtures that should only ever exist in dev, never qa/prod. Same image runs in all
// three environments — APP_ENV (set per overlay's patch.yaml on the migrate Job, same
// pattern as the api/ui containers) is what tells this code which environment it's
// actually running in.
const DEV_ONLY_USERS = [
  { username: "DevUser1", full_name: "Dev User One", email: "devuser1@example.com", is_admin: false },
];

const USERS = process.env.APP_ENV === "dev" ? [...BASE_USERS, ...DEV_ONLY_USERS] : BASE_USERS;

async function seedUsers() {
  const hash = await bcrypt.hash("password123", 10);
  const c = await pool.connect();
  try {
    for (const u of USERS) {
      await c.query(
        `INSERT INTO users (username, password_hash, full_name, email, is_admin)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO NOTHING`,
        [u.username, hash, u.full_name, u.email, u.is_admin]
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
