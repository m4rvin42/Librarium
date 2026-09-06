# Librarium

Librarium is a private, self-hosted catalog for physical and digital books. It supports manual entry, ISBN imports, image review, reading history, search, and portable backups. The React UI and REST API run in one Fastify container; SQLite and managed files live in one persistent volume.

Screenshot placeholder: dashboard and mobile import-review screenshots will accompany the first branded release.

## Architecture

- React, React Router, and React Query compile to static assets served by Fastify.
- Fastify exposes /api/v1, OpenAPI at /api/docs, cookie sessions, and bearer-token access.
- SQLite uses WAL and foreign keys. Authors/categories are normalized; sessions and image candidates are separate records.
- ISBN metadata uses configurable Open Library and Google Books providers with timeouts, retries, fallback, and caching.
- Sharp normalizes images and ZXing checks barcodes before optional server-side OpenAI analysis. Candidates always require approval.

See [architecture details](docs/architecture.md).

## Docker deployment

1. Copy .env.example to .env.
2. Set a strong ADMIN_PASSWORD and, for API use, a random API_TOKEN.
3. Optionally set OPENLIBRARY_CONTACT_EMAIL and GOOGLE_BOOKS_API_KEY. Set SETTINGS_ENCRYPTION_KEY to manage the Google key in Settings. Image recognition also needs OPENAI_API_KEY and OPENAI_VISION_MODEL.
4. Run: docker compose up -d --build
5. Open http://localhost:8787 and sign in as ADMIN_USERNAME (default admin).

The volume contains /data/librarium.sqlite, /data/images, /data/imports, and /data/backups. Inspect with docker compose ps and docker compose logs -f librarium.

## Development

Node.js 22 is required. Run npm ci, copy .env.example to .env, point DATABASE_PATH and DATA_DIRECTORY at local writable paths, then run npm run db:migrate, npm run db:seed, and npm run dev. Vite runs at http://localhost:5173 and proxies Fastify on port 3000.

Verify with npm run lint, npm run typecheck, npm test, and npm run build.

## Configuration

| Variable                        | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| PORT                            | Internal HTTP port                           |
| DATABASE_PATH / DATA_DIRECTORY  | SQLite and managed-file paths                |
| TZ                              | Container timezone                           |
| ADMIN_USERNAME / ADMIN_PASSWORD | Single administrator; password is required   |
| API_TOKEN                       | Optional bearer token for n8n/mobile clients |
| COOKIE_SECURE                   | Set true when served through HTTPS           |
| OPENAI_API_KEY                  | Server-only key                              |
| OPENAI_VISION_MODEL             | Vision-capable Responses API model           |
| OPENAI_METADATA_MODEL           | Web-search ISBN fallback model; defaults to vision model |
| OPENAI_IMAGE_ANALYSIS_ENABLED   | Feature switch                               |
| METADATA_PROVIDERS              | Comma-separated order, e.g. openlibrary,googlebooks |
| OPENLIBRARY_CONTACT_EMAIL       | Identifies metadata requests                 |
| GOOGLE_BOOKS_API_KEY            | Google Books API key; recommended for quota  |
| SETTINGS_ENCRYPTION_KEY         | Base64-encoded 32-byte key for encrypted UI credentials |
| MAX_IMAGE_SIZE_MB               | Per-image upload limit                       |

Without OpenAI credentials, manual and ISBN workflows remain usable. Selecting OpenAI web search as a metadata provider sends the ISBN query to OpenAI and its search service.

## Workflows

Use **Add books** for manual data, an ISBN, pasted ISBNs, or camera/file images. ISBN checksums are validated and duplicates conflict. Images are orientation-corrected, metadata-stripped, resized, and scanned locally. AI output is Zod-validated and kept on the review screen; ambiguous title matches require edition selection. Existing books can be enhanced with barcode, spine, copyright-page, or cover photos; detected fields remain reviewable and a chosen local cover overrides remote cover art. When adding a local cover, **Automatically straighten cover** uses the configured OpenAI vision model to suggest its corners; review and adjust all four points before confirming the corrected image.

Interactive API documentation is at /api/docs. n8n example:

    GET http://librarium:3000/api/v1/books?search=asimov
    Authorization: Bearer <API_TOKEN>

Cookie mutations require the CSRF token returned by login or /auth/me; bearer requests do not. See [API examples](docs/api-examples.md) and [n8n integration](docs/n8n-integration.md).

## Backup, updates, troubleshooting, and privacy

Settings downloads versioned JSON or a consistent SQLite snapshot. JSON import validates the document, supports dry runs, and accepts skip, merge, or replace. SQLite restore requires explicit confirmation, validates schema/integrity, and makes an automatic backup. See [backup and restore](docs/backup-and-restore.md).

Before updating, download a backup, then run git pull and docker compose up -d --build. Migrations run at startup.

- Login 503 means ADMIN_PASSWORD is empty.
- Unknown ISBNs may be absent from both configured providers; add them manually.
- Configure OPENLIBRARY_CONTACT_EMAIL if Open Library is throttled. Google Books is used as the next configured fallback.
- Provider order can be changed in Settings. Keys saved there are encrypted with SETTINGS_ENCRYPTION_KEY and never displayed; clearing the saved key falls back to GOOGLE_BOOKS_API_KEY.
- For health failures run docker compose exec librarium node dist/healthcheck.js and check volume permissions.

Image analysis sends normalized images to OpenAI and may expose faces, rooms, labels, or other private details. Crop first and review OpenAI data-control terms. Barcode-only images do not call OpenAI. Credentials, cookies, and image bodies are redacted from logs.
