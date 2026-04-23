FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && npm run build:server

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/release/server.cjs ./release/server.cjs
COPY --from=build /app/db.json ./db.json

# Runtime writable folders
RUN mkdir -p /app/uploads /app/exports

EXPOSE 3000

CMD ["node", "release/server.cjs"]
