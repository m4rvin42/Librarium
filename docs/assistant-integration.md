# Private assistant integration

Librarium provides two machine interfaces backed by the same validation and authorization rules:

- REST/OpenAPI at `/api/v1`, with the curated specification at `/api/docs/assistant.json`.
- Stateless Streamable HTTP MCP at `/api/v1/mcp`.

Create a named credential in **Settings → Assistant credentials**. Tokens are displayed once,
stored as hashes, independently revocable, and restricted to the selected scopes. Do not give an
assistant the administrator password. The legacy `API_TOKEN` remains compatible but is not
recommended for new integrations.

## Recommended scopes

- Lookup and recommendations: `library:read`.
- Personal notes: add `notes:read` and/or `notes:write` only when required.
- Catalog edits: `books:write`.
- Reading logs: `reading:write`.
- ISBN and external discovery candidates: `imports:write`.
- Moving books to trash: `books:delete`.

Settings, backup/restore, credentials, raw images, and provider keys are never available to scoped
assistant credentials.

## MCP

Use the public HTTPS URL of the instance as the MCP server URL:

    https://librarium.example/api/v1/mcp

Send the generated token as bearer authorization. When configuring an MCP-capable model, require
approval for `confirm_action`, `prepare_delete_book`, and `prepare_permanent_delete`. A private or
on-premises instance can instead be reached through a secure MCP tunnel or an equivalent private
network path.

The server advertises only tools allowed by the current credential. Read tools include catalog
search, summaries, facets, reading history, and explainable recommendations. Write tools include
book edits and reading logs. Discovery results and AI-derived data always remain import candidates
until an approval confirmation is executed.

## Recommendations and privacy

Local FTS search and deterministic ranking are the default. OpenAI reranking must first be enabled
in Settings and then explicitly requested with `"rerank":"openai"`. It sends only bibliographic
metadata and the stored book rating, uses a non-stored structured response, and never sends notes,
reading-session text, credentials, local paths, or images. If reranking fails, Librarium returns the
local order with a warning.

External recommendations are disabled by default. `"includeExternal":true` searches configured
metadata providers only after the owned catalog and creates reviewable discovery candidates; it
does not add books to the catalog.

## Confirmed writes

Deletes, permanent deletes, bulk edits, and import approvals use two calls:

1. `POST /api/v1/confirmations` with the requested action returns an exact summary and a confirmation
   ID valid for ten minutes.
2. After the user approves that summary, `POST /api/v1/confirmations/{id}/execute` executes it once.

Confirmations are bound to the credential that created them. Assistant create and edit requests
also require a unique `Idempotency-Key` header so retries cannot duplicate work.
