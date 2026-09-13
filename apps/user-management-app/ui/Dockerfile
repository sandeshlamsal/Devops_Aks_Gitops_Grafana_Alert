# Multi-stage: build the React bundle, then serve it with nginx.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
# picks up OS package security patches released for this alpine branch since the base
# image layer was last built (real HIGH CVEs in libssl3/libcrypto3 found on first
# real deploy's trivy scan — see api/Dockerfile's comment for the same fix there).
RUN apk update && apk upgrade --no-cache
# nginx.conf is a template; entrypoint substitutes ${API_HOST} from the env at start.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# runs at container start, before nginx starts — writes env.js from $APP_ENV
COPY docker-entrypoint.d/40-generate-env.sh /docker-entrypoint.d/40-generate-env.sh
RUN chmod +x /docker-entrypoint.d/40-generate-env.sh
ENV API_HOST=user-management-app-api:8080
EXPOSE 80
