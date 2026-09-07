# Deploying the published container image

Librarium release images are published to GitHub Container Registry as `ghcr.io/m4rvin42/librarium`.
Use a numbered release tag in deployments so an update is intentional. For example, `1.0` follows compatible patch releases; `v1.0.0` pins one exact release. `latest` is also published for evaluation, but is not recommended for long-lived deployments.

Create a directory outside this repository and add this `compose.yaml`:

```yaml
services:
  librarium:
    image: ghcr.io/m4rvin42/librarium:1.0
    restart: unless-stopped
    ports:
      - '8787:3000'
    env_file:
      - .env
    volumes:
      - librarium-data:/data
    healthcheck:
      test: ['CMD', 'node', 'dist/healthcheck.js']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  librarium-data:
```

Copy the project's `.env.example` beside the Compose file as `.env`. At minimum, set a strong `ADMIN_PASSWORD`; set `COOKIE_SECURE=true` when exposing Librarium through HTTPS. Do not commit this file, since it may contain credentials.

Start it with:

```sh
docker compose pull
docker compose up -d
```

The named volume preserves the SQLite database, images, imports, and backups at `/data`. On every start, Librarium creates its schema as needed and applies pending database migrations before accepting requests.

Before updating, make a backup from Settings. Change the image tag to the desired release, then run `docker compose pull` and `docker compose up -d`. Confirm the service with `docker compose ps` or `curl http://localhost:8787/api/v1/health`.

The package must be made public once in GitHub's package settings after its first publish. If it is kept private instead, authenticate the deployment host with a GitHub token that has `read:packages` before running `docker compose pull`.
