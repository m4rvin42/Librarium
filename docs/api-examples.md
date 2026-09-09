# API examples

Automation requests use a named scoped bearer credential created in Settings. `API_TOKEN` remains
available for backward compatibility but has administrator-level access and is deprecated for new
integrations.

    curl -H "Authorization: Bearer $ASSISTANT_TOKEN" "http://localhost:8787/api/v1/books?search=dune"
    curl -X POST -H "Authorization: Bearer $ASSISTANT_TOKEN" -H "Idempotency-Key: isbn-preview-9780441172719" -H "Content-Type: application/json" -d '{"isbn":"9780441172719"}' http://localhost:8787/api/v1/imports/isbn/preview

Administrative export still requires the legacy administrator token or a signed-in browser:

    curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/api/v1/export/json -o librarium.json

Errors use {"error":{"code":"NOT_FOUND","message":"Book not found"}}. Lists return items, page,
limit, and total. The complete contract and query options are at `/api/docs`; assistant-safe
operations are at `/api/assistant-docs` and `/api/docs/assistant.json`.

JSON import posts document, dryRun, and strategy (skip, merge, replace). Upload images with multipart, inspect GET /imports/:id, and approve with candidateIds.
