#!/bin/sh
# Runs automatically at container start (nginx's official entrypoint sources every
# *.sh in this directory before starting nginx). Writes a tiny env.js the built React
# bundle fetches at page-load, so the same built image shows "DEV"/"QA"/"PROD" per
# environment without ever being rebuilt — same pattern as this file's sibling
# nginx.conf.template using ${API_HOST}, just for content instead of nginx config.
set -e
echo "window.APP_ENV = \"${APP_ENV:-local}\";" > /usr/share/nginx/html/env.js
