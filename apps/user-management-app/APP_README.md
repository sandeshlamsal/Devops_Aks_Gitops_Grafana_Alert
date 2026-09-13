# User Management App — how to use it

This is the user-facing guide: how to log in, what you can do once you're in, and what
changes between environments. For how the app is *built and deployed*, see
[README.md](README.md) — this file is only about using the app itself.

## Logging in

The app runs in three separate environments, each with its **own URL, own database,
own users** — logging into one has no effect on the others:

| Environment | URL |
|---|---|
| dev | http://user-management-dev.eastus2.cloudapp.azure.com |
| qa | http://user-management-qa.eastus2.cloudapp.azure.com |
| prod | http://user-management-prod.eastus2.cloudapp.azure.com |

Every environment ships with the same 5 demo accounts, all sharing the password
`password123`:

| Username | Full name | Admin? |
|---|---|---|
| `admin` | Ada Admin | **yes** |
| `bwayne` | Bruce Wayne | no |
| `ckent` | Clark Kent | no |
| `dprince` | Diana Prince | no |
| `bbanner` | Bruce Banner | no |

**dev only** also seeds one extra fixture, `DevUser1` (not an admin) — a dev-only test
account that will never appear in qa or prod, no matter how many times any environment
is destroyed and recreated. Same image runs everywhere; the seeding logic checks which
environment it's actually running in (`api/src/seed.js`'s `DEV_ONLY_USERS`) rather than
this being a different build per environment.

The sign-in page heading tells you which environment you're on at a glance — **"Sign
in DEV env"**, **"Sign in QA env"**, or **"Sign in PROD env"**, in red — so it's never
ambiguous which one you're looking at, even with all three open in different tabs.

Once logged in, you'll see **"Logged in as `<username>`"** (with **"(admin)"** next to
it if you're an admin) and the time you signed in, just under the page heading.

A login session lasts **1 hour**, then you'll need to log in again.

## What a normal (non-admin) user can do

- Log in and log out
- View the full list of users — id, username, name, email, admin status, and when
  they were created

That's it. Add/edit/delete controls simply don't appear for a non-admin account — it's
not that the buttons are disabled, they're not rendered at all.

## What an admin can do

Everything a normal user can, plus:

- **Add a user** — a form at the bottom of the page (username, password, full name,
  email). Password must be at least 8 characters.
- **Edit a user** — click **Edit** on their row to change their username, full name,
  email, or admin status in place. Leave the password field blank to keep their
  current password unchanged.
- **Delete a user** — click **Delete** on their row. You'll get a confirmation prompt
  first ("Delete user "X"? This cannot be undone.") — there is no undo after that.

**One safety rule that always applies, in every environment**: the app will refuse to
delete the last remaining admin. If you're the only admin, you can't delete your own
account (or demote yourself away from `is_admin` via edit — actually revoking your own
admin flag via Edit *is* currently possible; deleting the account is what's blocked).
This exists so an environment can never end up with zero admins and no way to create
or fix anyone through the app itself.

## Why isolation matters here

Adding, editing, or deleting a user in one environment **cannot** affect the others —
dev, qa, and prod each run their own separate database. Practice freely in dev; qa and
prod are unaffected by anything you do there.
