# API examples

Automation requests use Authorization: Bearer API_TOKEN.

    curl -H "Authorization: Bearer $API_TOKEN" "http://localhost:8787/api/v1/books?search=dune"
    curl -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" -d '{"isbn":"9780441172719"}' http://localhost:8787/api/v1/imports/isbn
    curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/api/v1/export/json -o librarium.json

Errors use {"error":{"code":"NOT_FOUND","message":"Book not found"}}. Lists return items, page, limit, and total. Query options: search, readingStatus, ownershipStatus, category, sort, order, page, and limit.

JSON import posts document, dryRun, and strategy (skip, merge, replace). Upload images with multipart, inspect GET /imports/:id, and approve with candidateIds.
