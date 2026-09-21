# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for common platforms, but keep the
# toolchain available so an unusual architecture can still compile it.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache python3 make g++ \
    && addgroup -S app && adduser -S app -G app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apk del python3 make g++

COPY --from=build /app/dist ./dist

# Database, uploads, and exports all live under /app/data.
RUN mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.mjs"]
