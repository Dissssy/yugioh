# Deploying with Docker

As of 2026-11-18. Production runs at https://yugioh.p51.nl from two containers: the app image and Postgres.

## How the image gets built

[.github/workflows/docker.yml](../.github/workflows/docker.yml) builds the [Dockerfile](../Dockerfile) on every push to `main` and pushes it to `ghcr.io/dissssy/yugioh` with the tags `latest` and `sha-<commit>`. Pull requests build the image without pushing, so a broken Dockerfile shows up before merge. The image is for linux/amd64.

The image builds the web app, then runs the server's TypeScript directly with Node 22, serving the API and the built web app on port 3000 as the unprivileged `node` user.

## First start on the server

1. Put [compose.yaml](../compose.yaml) in a folder on the server, with a `.env` next to it:

   ```
   BASE_URL=https://yugioh.p51.nl
   SESSION_SECRET=        # openssl rand -hex 32
   AUTH0_ISSUER_BASE_URL=https://YOUR_TENANT.auth0.com
   AUTH0_CLIENT_ID=
   AUTH0_CLIENT_SECRET=
   ADMIN_EMAIL=
   POSTGRES_PASSWORD=     # openssl rand -hex 16
   ```

   compose.yaml sets `DATABASE_URL`, `PORT` and `CARD_IMAGE_DIR` itself. Auth0 setup is in [accounts.md](accounts.md).
2. If the GHCR package is private, log in once with a GitHub token that has `read:packages`: `docker login ghcr.io -u Dissssy`.
3. `docker compose up -d`.

On start the app applies database migrations, then imports cards from YGOPRODeck (about 14,700 cards and the deck images, roughly 30 seconds the first time) and repeats that sync daily. It needs outbound HTTPS for this.

## Updating

`docker compose pull && docker compose up -d`. To run a specific build, change the image tag in compose.yaml to `sha-<commit>`.

## What to keep

Two named volumes hold everything that must survive a redeploy:

- `yugioh_pgdata`: the database, including the event log that live duels are rebuilt from after a restart.
- `yugioh_card-images`: downloaded card images. Losing it only costs a re-download.

## Rules

- **One app container.** Live duels are held in the server's memory, so never run replicas or scale the `app` service.
- **Reverse proxy.** The app listens on `127.0.0.1:3000` on the host and expects a proxy in front that terminates HTTPS for yugioh.p51.nl. If your proxy runs in Docker, put it on a shared network with the `app` service and drop the `ports` entry instead. The proxy must:
  - pass `Host` and `X-Forwarded-Proto` (the app trusts these from private addresses only);
  - not buffer `/api/duels/<id>/stream` (the app sends `X-Accel-Buffering: no`, which nginx respects; other proxies may need it set by hand), since duel updates are Server-Sent Events;
  - allow idle reads of at least 60 seconds on those streams; the app sends a keepalive every 25 seconds.
