# Architecture

The browser and API share an origin. Fastify serves the Vite build and /api/v1; hooks apply rate limits, security headers, session/bearer authentication, and CSRF checks. Shared Zod schemas define runtime contracts.

SQLite is embedded with WAL and foreign keys. Books contain edition and ownership fields. Author and category join tables normalize many-to-many data. Reading sessions permit repeat reads. Import batches, images, and candidates create an approval boundary between untrusted analysis and the library. Multi-table writes use transactions.

The metadata module maps Open Library, Google Books, and an optional OpenAI web-search result into provider-neutral records, with request identity, abort timeouts, backoff, fallback, and cache expiry. OpenAI receives only the ISBN query, returns strict structured metadata, and must confirm the exact ISBN before a result is accepted. Provider order comes from deployment configuration or encrypted administrator settings; credentials remain server-side.

Image flow: multipart limits → Sharp decode/orient/resize/JPEG normalization → ZXing barcode → exact ISBN metadata, or OpenAI Responses structured output → Zod validation → metadata verification → review → explicit approval. The OpenAI key remains server-side.

Production uses a multi-stage Node 22 image. The final non-root process owns only /data; the health check exercises Fastify and database startup.
