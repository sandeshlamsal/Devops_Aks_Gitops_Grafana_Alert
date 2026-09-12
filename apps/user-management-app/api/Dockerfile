# One image serves three roles (chosen by the container command):
#   default            -> node --require ./src/tracing.js src/server.js   (the API, traced)
#   migrate job        -> node src/migrate.js && node src/seed.js         (no tracing needed)
#   reset cronjob      -> node src/migrate.js --reset && node src/seed.js
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY migrations ./migrations
EXPOSE 8080
USER node
CMD ["node", "--require", "./src/tracing.js", "src/server.js"]
