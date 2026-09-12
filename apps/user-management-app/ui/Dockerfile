# Multi-stage: build the React bundle, then serve it with nginx.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
# nginx.conf is a template; entrypoint substitutes ${API_HOST} from the env at start.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV API_HOST=user-management-app-api:8080
EXPOSE 80
