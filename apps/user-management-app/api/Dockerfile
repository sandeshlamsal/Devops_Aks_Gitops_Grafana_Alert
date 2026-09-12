# One image serves three roles (chosen by the container command):
#   default            -> node --require ./src/tracing.js src/server.js   (the API, traced)
#   migrate job        -> node src/migrate.js && node src/seed.js         (no tracing needed)
#   reset cronjob      -> node src/migrate.js --reset && node src/seed.js
#
# Multi-stage: `npm install` happens in a throwaway builder stage. The final stage
# copies only node_modules/src/migrations across and deletes npm/npx themselves —
# node:20-alpine's bundled npm CLI vendors its own old copies of tar/glob/minimatch/
# pacote/sigstore/ip-address (npm needs those for package installs, registry auth,
# etc.) which showed up as unrelated CVEs in `release.yml`'s trivy scan, including one
# CRITICAL (tar). None of that is reachable at runtime — the container only ever runs
# `node`, never `npm` — so removing it is a straight risk-reduction with no downside.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine
# apk upgrade picks up any OS package security patches released for this alpine branch
# since the base image layer was last built (caught real HIGH CVEs in libssl3/libcrypto3
# on first real deploy — kustomize build/local tests can't catch this, only a scanner
# run against an actual built image can).
RUN apk update && apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
EXPOSE 8080
USER node
CMD ["node", "--require", "./src/tracing.js", "src/server.js"]
