# Librarium agent guide

Use Node.js 22. Install with `npm ci`. The repository is an npm-workspace monorepo.

Before handing off changes, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. For deployment changes also run `docker compose config` and a container health smoke test.

Shared request schemas and ISBN logic belong in `packages/shared`. API routes belong below `/api/v1`; errors must use `{ "error": { "code", "message" } }`. Keep multi-table writes transactional. Never expose or log credentials, tokens, cookies, OpenAI keys, or image bytes. AI detections must remain import candidates until explicit approval.

Schema changes require an idempotent SQL migration plus matching Drizzle schema changes. Preserve existing database compatibility and test migrations against a copy.
