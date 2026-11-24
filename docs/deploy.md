# Deploying with Docker

As of 2026-11-18. Production runs at https://yugioh.p51.nl on the home server (Void Linux, 192.168.1.200): one app container from the image below, using the host's shared Postgres 18, behind the host's Caddy.

## How the image gets built

[.github/workflows/docker.yml](../.github/workflows/docker.yml) builds the [Dockerfile](../Dockerfile) on every push to `main` and pushes it to `ghcr.io/dissssy/yugioh` with the tags `latest` and `sha-<commit>`. Pull requests build the image without pushing, so a broken Dockerfile shows up before merge. The image is for linux/amd64.

The image builds the web app, then runs the server's TypeScript directly with Node 22, serving the API and the built web app on port 3000 as the unprivileged `node` user.

## Database

The shared Postgres runs as compose project `/git/postgres` (service `db`, Docker network `postgres`). `/git/postgres/accounts.sh` creates the non-superuser login `yugioh`, which owns the database `yugioh`, and writes its credentials (PG* vars and `DATABASE_URL`, host `db`) to `/srv/secrets/postgres/yugioh.env`. [compose.yaml](../compose.yaml) loads that file and joins the `postgres` network; credentials are never baked into the image.

## First start on the server

1. Put [compose.yaml](../compose.yaml) in `/git/yugioh`, with a `.env` next to it (`chmod 600`):

   ```
   BASE_URL=https://yugioh.p51.nl
   SESSION_SECRET=        # openssl rand -hex 32
   AUTH0_ISSUER_BASE_URL=https://YOUR_TENANT.auth0.com
   AUTH0_CLIENT_ID=
   AUTH0_CLIENT_SECRET=
   ADMIN_EMAIL=
   ANTHROPIC_API_KEY=     # card effects and appeals; see effects.md
   DISCORD_CLIENT_ID=     # optional, all three or none: the Discord Activity; see discord.md
   DISCORD_CLIENT_SECRET=
   DISCORD_BOT_TOKEN=
   VAPID_PUBLIC_KEY=      # optional, both or neither: notifications with the site closed (Web Push);
   VAPID_PRIVATE_KEY=     # make them once with `npx web-push generate-vapid-keys`, and keep them (see ux-niceties.md)
   ```

   compose.yaml sets `PORT` and `CARD_IMAGE_DIR` itself. Auth0 setup is in [accounts.md](accounts.md).
2. `docker compose up -d`.
3. Caddy: add `/etc/caddy/available/yugioh.p51.nl.caddy`, symlink it into `/etc/caddy/enabled/`, and reload Caddy:

   ```
   yugioh.p51.nl {
   	reverse_proxy localhost:3020
   }
   ```

   DNS: `yugioh.p51.nl` is a CNAME to `p51.nl` in Cloudflare, not proxied, so Caddy gets its own certificate.

On start the app applies database migrations, then imports cards from YGOPRODeck (about 14,700 cards and the deck images, roughly 30 seconds the first time) and any effect sheet from `server/effect-sheets/` the database lacks, and repeats that sync daily. It needs outbound HTTPS for this.

## Updating

`docker compose pull && docker compose up -d`. To run a specific build, change the image tag in compose.yaml to `sha-<commit>`.

## What to keep

- The `yugioh` database in the shared Postgres, including the event log that live duels are rebuilt from after a restart. It is backed up with the rest of that cluster.
- The `yugioh_card-images` volume: downloaded card images. Losing it only costs a re-download.

## Rules

- **One app container.** Live duels are held in the server's memory, so never run replicas or scale the `app` service.
- **Reverse proxy.** The app listens on `127.0.0.1:3020` on the host. Caddy passes `Host` and `X-Forwarded-Proto` (the app trusts these from private addresses only), streams Server-Sent Events without buffering, and has no idle read timeout by default, so the duel streams at `/api/duels/<id>/stream` need no extra settings. The app sends a keepalive every 25 seconds.
