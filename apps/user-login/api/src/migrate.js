// Tiny forward-only migration runner — no external migration tool.
// Applies every apps/user-login/api/migrations/*.sql not yet recorded in
// schema_migrations, in filename order, each in its own transaction.
//
//   node src/migrate.js            apply pending migrations
//   node src/migrate.js --reset    drop & recreate the `public` schema first (full reset)
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const reset = process.argv.includes("--reset");

async function main() {
  const c = await pool.connect();
  try {
    if (reset) {
      console.log("--reset: DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await c.query("DROP SCHEMA public CASCADE");
      await c.query("CREATE SCHEMA public");
    }
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const applied = new Set(
      (await c.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)
    );
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      console.log(`applying ${f}`);
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [f]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${err.message}`);
      }
    }
    console.log("migrations up to date");
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
