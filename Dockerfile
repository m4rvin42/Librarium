# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/librarium.sqlite DATA_DIRECTORY=/data
WORKDIR /app
RUN groupadd --system --gid 10001 librarium && useradd --system --uid 10001 --gid librarium --home /app librarium && mkdir -p /data && chown librarium:librarium /data
COPY --from=build --chown=librarium:librarium /app/node_modules ./node_modules
COPY --from=build --chown=librarium:librarium /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=librarium:librarium /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=librarium:librarium /app/apps/api/dist ./dist
COPY --from=build --chown=librarium:librarium /app/apps/api/src/schema.sql ./dist/schema.sql
COPY --from=build --chown=librarium:librarium /app/dist/public ./dist/public
COPY --from=build --chown=librarium:librarium /app/package.json ./package.json
USER librarium
EXPOSE 3000
CMD ["node","dist/server.js"]
