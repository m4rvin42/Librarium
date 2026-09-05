# n8n integration

Set API_TOKEN to a random value and restart. In an n8n HTTP Request node choose bearer authentication, JSON response, and the internal network URL.

    GET http://librarium:3000/api/v1/books?search=asimov
    Authorization: Bearer <API_TOKEN>

For ISBN import POST to http://librarium:3000/api/v1/imports/isbn with JSON {"isbn":"{{$json.isbn}}"}. Status 201 means created, 409 duplicate, and 404 metadata unavailable. Never place the admin password or OpenAI key in workflows.
