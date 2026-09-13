# apps/user-management-app — 3-service login app

Log in, then see the user list from Postgres. Three microservices, deployed by Flux +
Kustomize into **`user-management-app-dev-ns`**, **`-qa-ns`**, and **`-prod-ns`** — the
only app in this repo (see the root README §11 for what a second app/cluster would add).

This file is the engineering README (build/deploy/test). For how to actually *use* the
app — logging in, what admins vs. regular users can do — see
**[APP_README.md](APP_README.md)**.

```
browser ──▶ user-management-app-ui  (React build, served by nginx)
                 │  nginx proxies /api/* ──▶ user-management-app-api  (Node/Express)
                 │                                │  pg
                 │                                ▼
                 │                        user-management-app-db  (CloudNativePG Postgres)
                 │                          ▲        ▲
                 │             migrate Job ─┘        └─ reset CronJob (suspended)
                 ▼
        LoadBalancer + Azure DNS label
        user-management-<dev|qa|prod>.eastus2.cloudapp.azure.com
```

| Service | Image | Tech | Talks to |
|---|---|---|---|
| `user-management-app-ui` | `user-management-app-ui:<tag>` | React (Vite) + nginx | proxies `/api` → `user-management-app-api:8080` |
| `user-management-app-api` | `user-management-app-api:<tag>` | Node 20 + Express + `pg` + `bcryptjs` + `jsonwebtoken` | `user-management-app-db-rw:5432` |
| `user-management-app-db` | CNPG default | Postgres via CloudNativePG `Cluster` CR | — |

`<tag>` is `dev-<run_number>` in dev (`ci.yml`'s `bump-dev` job keeps it current on
every push to `main`), `vX.Y.Z` in qa/prod (promoted by hand — see the root README's
[CI/CD pipeline](../../README.md#6-cicd-pipeline) section).

---

## Endpoints / FQDNs

Only the UI is public (LoadBalancer + Azure DNS label). API and DB are ClusterIP —
reach the API through the UI's `/api` proxy, or `kubectl port-forward`.

| Service | dev | qa | prod |
|---|---|---|---|
| **UI** (public, `LoadBalancer:80`) | http://user-management-dev.eastus2.cloudapp.azure.com | http://user-management-qa.eastus2.cloudapp.azure.com | http://user-management-prod.eastus2.cloudapp.azure.com |
| API — via UI proxy | `…/api/*` | `…/api/*` | `…/api/*` |
| API — in-cluster (`ClusterIP:8080`) | `user-management-app-api.user-management-app-dev-ns.svc.cluster.local:8080` | `…-qa-ns…` | `…-prod-ns…` |
| DB primary — in-cluster (`ClusterIP:5432`) | `user-management-app-db-rw.user-management-app-dev-ns.svc.cluster.local:5432` | `…-qa-ns…` | `…-prod-ns…` |
| DB read-only / any replica | `…-db-ro…` · `…-db-r…` | same pattern | same pattern |

```bash
# API without the UI:
kubectl -n user-management-app-dev-ns port-forward svc/user-management-app-api 8080:8080   # → http://localhost:8080/api/healthz
# DB shell:
kubectl -n user-management-app-dev-ns exec -it user-management-app-db-1 -- psql -U appuser -d user_management_app
```

---

## API

| Route | Auth | Returns |
|---|---|---|
| `POST /api/login` `{username,password}` | — | `{ token }` — JWT, 1 h, signed with `JWT_SECRET` |
| `GET /api/me` | any logged-in user | own `{id,username,full_name,email,is_admin}` |
| `GET /api/users` | any logged-in user | `[{id,username,full_name,email,is_admin,created_at}]` |
| `POST /api/users` `{username,password,full_name?,email?,is_admin?}` | **admin only** | `201` + created user, `400` short password, `409` duplicate username |
| `PUT /api/users/:id` any subset of `{username,password,full_name,email,is_admin}` | **admin only** | `200` + updated user — omitted fields are left unchanged |
| `DELETE /api/users/:id` | **admin only** | `204`, or `409` if `:id` is the last remaining admin |
| `GET /api/healthz` | — | `{ok:true,env}` |
| `GET /metrics` | — | Prometheus metrics (scraped by a `ServiceMonitor`) |

**Admin gating** (`requireAdmin` in `server.js`) does a **fresh DB lookup** on every
mutating request rather than trusting a claim baked into the JWT — demote an admin and
their already-issued, still-valid token stops working for writes on its very next
request, not just after it expires. The seeded `admin` user is the only admin by
default (`api/src/seed.js`); everyone else starts as a regular user.

**Config (env):** `DATABASE_URL` = `uri` key of the CNPG-generated Secret
`user-management-app-db-app`; `JWT_SECRET` = `secret` key of `user-management-app-jwt`
(from OpenBao via ESO); `APP_ENV` = `dev` / `qa` / `prod` (overlay patch); `PORT` = `8080`.

---

## UI

A static React SPA served by nginx — normally that would mean baking any
environment-specific text in at build time, which breaks this repo's "build once,
promote the same artifact everywhere" model (dev/qa/prod would each need their own
build). Instead, the sign-in/users page heading ("Sign in DEV env", in red) is set at
**container start**, not build time:

1. `ui/docker-entrypoint.d/40-generate-env.sh` runs automatically when the container
   starts (same mechanism nginx's official image already uses for `nginx.conf`'s
   `${API_HOST}` templating) and writes `/usr/share/nginx/html/env.js` from the
   container's `APP_ENV` env var.
2. `index.html` loads that file before the React bundle.
3. `App.jsx` reads `window.APP_ENV` at render time.

Same built image, different heading per environment — `APP_ENV`'s existing pattern
(see the API config above), applied to page content instead of a backend response.
`APP_ENV` is wired the same way for the `ui` container as the `api` one: a `base`
default in `k8s/base/ui.yaml`, overridden per overlay in each `patch.yaml`.

Verify it yourself against any environment: `curl http://<env-url>/env.js`.

---

## Database — CloudNativePG

`k8s/base/db-cluster.yaml` is a `postgresql.cnpg.io/v1` `Cluster`: 1 instance (2 for the
API pod, not the DB, in prod's patch — see `k8s/overlays/prod/patch.yaml`), 1 Gi PVC,
`initdb` creates database `user_management_app` owned by role `appuser`. The operator
(`infrastructure/cnpg/`) then provides:

- Secret **`user-management-app-db-app`** — `username / password / dbname / host / port / uri / …`
  (app credentials are **generated by CNPG**, never in git)
- Services **`user-management-app-db-rw`** (primary), `-ro`, `-r`

**Per-environment user isolation — already fully in place.** Each overlay applies its
own `db-cluster.yaml` under its own namespace
(`user-management-app-{dev,qa,prod}-ns`), so CloudNativePG creates a **completely
separate Postgres instance per environment** — separate PVC, separate data, separate
everything. A user added, edited, or deleted in qa can never appear in — or disappear
from — dev or prod; they're not different tables in one shared database, they're
different databases entirely, on different disks. This was already true from day one
(login itself always worked this way); it isn't something the add/update/delete
feature had to earn.

---

## Migrations & fixtures

- **Schema** — plain numbered SQL in `api/migrations/*.sql`, applied by
  `api/src/migrate.js` (a ~50-line forward-only runner; tracks applied files in
  `schema_migrations`, one txn each). Add a migration = drop a new `NNN_name.sql` and
  rebuild the API image. `migrate({reset})` is exported so tests call it directly.
- **Fixtures** — `api/src/seed.js` inserts 5 demo users
  (`admin`, `bwayne`, `ckent`, `dprince`, `bbanner`), all password **`password123`**,
  `ON CONFLICT (username) DO NOTHING` → safe to re-run. `seedUsers()` is exported too.
- **On every deploy** — `k8s/base/db-migrate-job.yaml` (`Job user-management-app-db-migrate`)
  runs `node src/migrate.js && node src/seed.js`. It carries
  `kustomize.toolkit.fluxcd.io/force: enabled`, so Flux **recreates** it whenever its
  spec changes (new image / migration); it retries (`backoffLimit: 20`) until the DB
  answers; `ttlSecondsAfterFinished: 600` cleans it up.

### Reset a database (one namespace)

`k8s/base/db-reset-cronjob.yaml` ships a **suspended** `CronJob user-management-app-db-reset`
(never-fires schedule). Trigger an on-demand run:

```bash
NS=user-management-app-dev-ns    # or -qa-ns / -prod-ns
kubectl -n $NS create job db-reset-$(date +%s) --from=cronjob/user-management-app-db-reset
kubectl -n $NS get jobs -l job-name --sort-by=.metadata.creationTimestamp
kubectl -n $NS logs -f job/db-reset-<name>
```

It runs `node src/migrate.js --reset && node src/seed.js` →
`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then re-migrate + re-seed. Only that
namespace's DB is touched. This is also the fastest fix for "the DB is in a bad state" —
see the root README's [Rollback](../../README.md#10-rollback) section.

---

## Unit & integration tests

`api/test/` — Node's built-in `node --test` (zero extra dependencies), against a real
Postgres, no mocking:

| File | Covers |
|---|---|
| `test/db.test.js` | `migrate()`, `migrate({reset:true})`, `seedUsers()` idempotency, bcrypt hash verification |
| `test/server.test.js` | the actual Express `app` via `app.listen(0)` + `fetch` — auth (`/api/healthz`, `/api/login`, token validation), `/api/me`, and the full add/update/delete surface (see below) |

```bash
cd apps/user-management-app/api
npm install
DATABASE_URL=postgres://appuser:pw@localhost:5432/user_management_app JWT_SECRET=test-secret npm test
```

`npm test` runs `node --test --test-concurrency=1` — the two files share one live
database and node:test runs test *files* concurrently by default, which races
`db.test.js`'s schema resets against `server.test.js`'s requests. Don't drop that flag.

**This is what `ci.yml` runs, with a Postgres service container, before any image is
built** — a code change that breaks a test never produces an image (root README §6).

### Verifying add/update/delete (`002_user_roles.sql` + the admin-gated routes)

Three layers of verification, all real, none mocked — the standard for this repo (root
README's "test locally, then deploy" rule):

**1. Automated suite** — 9 new `node:test` cases in `test/server.test.js`, all passing
against a real ephemeral Postgres:

```
✔ GET /api/me returns the caller's own record, including is_admin
✔ POST /api/users as a non-admin -> 403
✔ POST /api/users as admin creates a user, hides password_hash
✔ POST /api/users with a short password -> 400
✔ POST /api/users with a duplicate username -> 409
✔ PUT /api/users/:id as admin updates the target user
✔ PUT /api/users/:id as a non-admin -> 403
✔ DELETE /api/users/:id as admin removes the target user
✔ DELETE /api/users/:id refuses to delete the last remaining admin
ℹ tests 21   ℹ pass 21   ℹ fail 0
```

**2. Manual curl verification against a standalone server** (throwaway Postgres,
`node src/server.js` directly) — confirms the exact HTTP status codes and response
shapes, including the two cases the automated suite exercises differently:

```bash
$ curl -s http://localhost:8099/api/me -H "Authorization: Bearer $ADMIN_TOKEN"
{"id":1,"username":"admin","full_name":"Ada Admin","email":"admin@example.com","is_admin":true}

$ curl -s -X POST .../api/users -H "Authorization: Bearer $NONADMIN_TOKEN" -d '{"username":"newguy","password":"password123"}'
# -> 403

$ curl -s -X POST .../api/users -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"username":"newguy",...}'
{"id":6,"username":"newguy","full_name":"New Guy","email":"new@example.com","is_admin":false,"created_at":"..."}

$ curl -s -X DELETE .../api/users/1 -H "Authorization: Bearer $ADMIN_TOKEN"   # id 1 = the only admin
{"error":"cannot delete the last remaining admin"}
```

**3. Full `docker-compose` stack** — the actual built images, the actual `migrate` Job
(applies `002_user_roles.sql`), the actual UI bundle, hit end to end:

```bash
$ docker compose logs migrate --tail 5
migrate-1  | applying 002_user_roles.sql
migrate-1  | migrations up to date
migrate-1  | seed complete — 5 users

$ curl -s -X POST http://localhost:8080/api/users -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"username":"compose-test","password":"password123","full_name":"Compose Test"}'
# -> 201, id 6

$ curl -s -X PUT http://localhost:8080/api/users/6 -d '{"full_name":"Compose Test Updated"}'
{"id":6,...,"full_name":"Compose Test Updated",...}

$ curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:8080/api/users/6
204
```

Plus a bundle-content check that the UI's new controls actually shipped (not just that
the source file changed):

```bash
$ curl -s http://localhost:8081/assets/index-*.js | grep -oE 'Add user|api/me|is_admin|Delete user'
Add user
api/me
Delete user
is_admin
```

---

## Local Docker Desktop test

Run the whole stack — the exact images that go to AKS, with the exact env var names the
k8s manifests use — before touching the cluster:

```bash
cd apps/user-management-app
cp .env.example .env          # edit if you want different local values
docker compose up --build -d
docker compose logs -f migrate      # watch: applying 001_users.sql / seed complete — 5 users
open http://localhost:8081          # log in admin / password123
```

```bash
# same flow via curl:
curl -s http://localhost:8081/api/healthz
TOKEN=$(curl -s -X POST http://localhost:8081/api/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"password123"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s http://localhost:8081/api/users -H "Authorization: Bearer $TOKEN"

docker compose down -v          # stop + wipe the local db volume when done
```

`docker-compose.yml` builds from the same `api/Dockerfile` / `ui/Dockerfile` used for
AKS, runs `db` (postgres:16) → `migrate` (one-shot, same image as `api`) → `api` → `ui`,
wired entirely through `.env` (see `.env.example` — the table there maps every var to
its AKS equivalent: `DATABASE_URL`, `JWT_SECRET`, `APP_ENV`, `API_HOST`). Promoting to a
cluster only ever changes *where the value comes from*, never the app.

The same `docker compose up` also brings up a full local observability stack —
Prometheus, Loki+Alloy, Tempo, and a real Grafana at http://localhost:3000 — so you can
see your own metrics, logs, and traces before any of it goes near AKS. Guided
walkthrough, real captured examples: **[docs/local-observability.md](docs/local-observability.md)**.

---

## Build the images

```bash
az acr build --registry sanaksregistry --image user-management-app-api:v1 ./apps/user-management-app/api
az acr build --registry sanaksregistry --image user-management-app-ui:v1  ./apps/user-management-app/ui
```

In practice you don't run this by hand — `ci.yml` builds+pushes `dev-<N>` /
`main-<sha>` tags on every push to `main`, and `release.yml` builds `vX.Y.Z` tags on a
git tag push. See the root README's [CI/CD pipeline](../../README.md#6-cicd-pipeline).

---

## Deploy (Flux)

Reconciled by `clusters/dev/user-management-app-{dev,qa,prod}.yaml`
(`dependsOn: [cnpg-operator, secrets]`), **all shipping `suspend: true`** — nothing
deploys until armed by a `promote-*` GitHub Actions workflow. Add to the
`az k8s-configuration flux create`:

```bash
  --kustomization name=cnpg-operator            path=./infrastructure/cnpg                        prune=true \
  --kustomization name=user-management-app-dev  path=./apps/user-management-app/k8s/overlays/dev  prune=true dependsOn=["cnpg-operator","secrets"] \
  --kustomization name=user-management-app-qa   path=./apps/user-management-app/k8s/overlays/qa   prune=true dependsOn=["cnpg-operator","secrets"] \
  --kustomization name=user-management-app-prod path=./apps/user-management-app/k8s/overlays/prod prune=true dependsOn=["cnpg-operator","secrets"]
```

Also: seed the JWT secret in OpenBao and let the `eso-monitoring` policy read
`kv/data/user-management-app/*` (root README §3.2 / `infrastructure/secrets/README.md`):

```bash
bao policy write eso-monitoring - <<'EOF'
path "kv/data/monitoring/*"          { capabilities = ["read"] }
path "kv/data/user-management-app/*" { capabilities = ["read"] }
EOF
bao kv put kv/user-management-app/jwt-dev  secret="$(openssl rand -hex 32)"
bao kv put kv/user-management-app/jwt-qa   secret="$(openssl rand -hex 32)"
bao kv put kv/user-management-app/jwt-prod secret="$(openssl rand -hex 32)"
```

And create the `flux-applier` SA + binding in `user-management-app-dev-ns`,
`-qa-ns`, `-prod-ns`, `cnpg-system` (root README §3.6).

---

## E2E test (verified on AKS)

```bash
# --- cluster objects ---
kubectl get pods -n user-management-app-dev-ns
#   user-management-app-api-*  1/1   user-management-app-ui-*  1/1   user-management-app-db-1  1/1   user-management-app-db-migrate-*  Completed
kubectl get cluster -n user-management-app-dev-ns            # user-management-app-db → "Cluster in healthy state"
kubectl get externalsecret -n user-management-app-dev-ns     # user-management-app-jwt → SecretSynced=True
kubectl logs -n user-management-app-dev-ns job/user-management-app-db-migrate
#   applying 001_users.sql / migrations up to date / seed complete — 5 users

# --- the app, through the UI's LoadBalancer + Azure DNS name ---
H=user-management-dev.eastus2.cloudapp.azure.com          # or -qa / -prod

curl -s http://$H/api/healthz                      # {"ok":true,"env":"dev"}

TOKEN=$(curl -s -X POST http://$H/api/login -H 'Content-Type: application/json' \
        -d '{"username":"admin","password":"password123"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

curl -s http://$H/api/users -H "Authorization: Bearer $TOKEN"
#   [{"id":1,"username":"admin",...}, ... 5 rows]

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://$H/api/login \
     -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}'   # 401
curl -s -o /dev/null -w '%{http_code}\n' http://$H/api/users                            # 401 (no token)
```

Verified end-to-end in dev and qa, plus the reset job (drops the schema, re-migrates,
re-seeds back to exactly 5 users). Remember: dev/qa/prod ship **suspended** — run the
matching `promote-*` GitHub Actions workflow first (root README §6) or nothing above
will have anything to talk to.

> **DNS label gotcha:** Azure rejects public-IP domain labels containing reserved words
> — `userlogin-*` fails with `DomainNameLabelReserved` ("login"). This repo uses
> `user-management-dev` / `-qa` / `-prod`. Pick a label without `login`/trademark-ish words.
