# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM dependencies AS verify
COPY . .
RUN npm run lint
RUN npm run typecheck
RUN npm test
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=development
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/librarium.sqlite DATA_DIRECTORY=/data
WORKDIR /app
RUN groupadd --system --gid 10001 librarium && useradd --system --uid 10001 --gid librarium --home /app librarium && mkdir -p /data && chown librarium:librarium /data
COPY --from=verify --chown=librarium:librarium /app/node_modules ./node_modules
COPY --from=verify --chown=librarium:librarium /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=verify --chown=librarium:librarium /app/packages/shared/dist ./packages/shared/dist
COPY --from=verify --chown=librarium:librarium /app/apps/api/dist ./dist
COPY --from=verify --chown=librarium:librarium /app/apps/api/src/schema.sql ./dist/schema.sql
COPY --from=verify --chown=librarium:librarium /app/apps/api/migrations ./dist/migrations
COPY --from=verify --chown=librarium:librarium /app/dist/public ./dist/public
COPY --from=verify --chown=librarium:librarium /app/package.json ./package.json
USER librarium
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node","dist/healthcheck.js"]
CMD ["node","dist/server.js"]
