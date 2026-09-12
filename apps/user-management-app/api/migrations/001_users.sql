-- users table: what login checks against and what /api/users lists.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
