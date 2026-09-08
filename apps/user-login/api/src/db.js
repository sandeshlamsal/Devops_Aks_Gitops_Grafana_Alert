// Single shared pg pool. Connection string comes from DATABASE_URL, which in-cluster is
// the `uri` key of the CloudNativePG-generated secret `userlogin-db-app`.
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30000 });

pool.on("error", (err) => console.error("pg pool error", err));

module.exports = { pool };
