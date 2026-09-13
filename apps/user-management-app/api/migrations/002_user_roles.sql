-- Adds the admin flag that gates POST/PUT/DELETE /api/users (see requireAdmin in
-- server.js). Everyone can still view the list (GET /api/users, unchanged); only
-- admins can create, update, or delete a user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
