# syntax=docker/dockerfile:1

# ---- build stage: install production dependencies only ----
FROM node:26-alpine AS deps
RUN echo "os-refresh 2026-11-26" && apk upgrade --no-cache
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage ----
FROM node:26-alpine
RUN echo "os-refresh 2026-11-26" && apk upgrade --no-cache \
 && addgroup -S app && adduser -S -G app app

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/database

# Explicit copies only: never ship the local node_modules, database or .env.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js ./
COPY src ./src
COPY js ./js
COPY css ./css
COPY index.html login.html dashboard.html display.html ./
COPY README.md API.md TESTING.md ./

RUN mkdir -p /app/database && chown -R app:app /app

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
