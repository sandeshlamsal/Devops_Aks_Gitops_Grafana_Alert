-- Backfill for databases where "admin" already existed before 002_user_roles.sql ran:
-- ALTER TABLE ... ADD COLUMN defaults every existing row (including "admin") to false,
-- and seedUsers()'s `ON CONFLICT (username) DO NOTHING` never touches a row that's
-- already there. Without this, any environment that had already seeded its users
-- before 002 shipped ends up with an "admin" user that isn't actually an admin —
-- exactly what happened on dev. Harmless no-op on a database where 002 already
-- inserted "admin" with is_admin=true directly (nothing to change).
UPDATE users SET is_admin = true WHERE username = 'admin';
