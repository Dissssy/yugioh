# Accounts, approval and invites

As of 2026-11-18. This is the website shell that sits outside the duel engine: login, admin approval, and invite links for people without an account. The engine never sees any of it.

## Access model

| Visitor | Can |
| --- | --- |
| Anonymous | See public pages only (read-only). |
| Guest | Someone who opened an invite link. Plays as that user's guest until the invite expires or is revoked. No deck building. |
| Pending account | Logged in through Auth0, waiting for the admin. Same as anonymous. |
| Approved account | Everything, including creating invite links. |
| Admin | Approves or rejects accounts. The account whose **verified** email equals `ADMIN_EMAIL` is the admin and is always approved. |

Invite links are single-use and last 7 days. The first browser that uses a link becomes the guest; anyone else who opens it is told it was used. An invite stops working if its creator is rejected. A guest sees their inviter's open challenges on their home page and can accept them (see [duels.md](duels.md)).

## How it works

- **Login:** [express-openid-connect](https://github.com/auth0/express-openid-connect), Auth0's library for server-rendered apps. The session is an encrypted cookie on the site's own domain, so the API and the duel event streams authenticate with the same cookie and the browser never handles tokens.
- **Accounts:** on each login the server creates or refreshes the `users` row keyed by Auth0's `sub`. New rows start `pending`.
- **Guests:** a signed `guest` cookie holds the invite token. It is checked against the database on every request, so revoking the invite ends the guest's access at once.
- **Layout:** npm workspaces. `server/` (Express 5, Drizzle ORM, Postgres), `web/` (React, Vite, React Router, TanStack Query), `shared/` (types used by both). The server runs TypeScript directly with Node's built-in type stripping, so it has no build step. In production it also serves the built web app from `web/dist`.

## Running locally

1. `docker compose -f compose.dev.yaml up -d` starts Postgres with a `yugioh` and a `yugioh_test` database.
2. `cp .env.example .env` and fill it in (Auth0 below). For local work set `BASE_URL=http://localhost:5173`.
3. `npm install`, then `npm run dev`. Open http://localhost:5173. Migrations run when the server starts.
4. `npm test` runs the server tests against `yugioh_test`, with a mock OpenID provider standing in for Auth0, so they need no Auth0 tenant.

After changing `server/src/db/schema.ts`, run `npm run db:generate` and commit the new file under `server/drizzle/`.

## Auth0 setup

1. In the Auth0 dashboard, create an application of type **Regular Web Application**.
2. Under its settings, set:
   - Allowed Callback URLs: `https://yugioh.p51.nl/auth/callback, http://localhost:5173/auth/callback`
   - Allowed Logout URLs: `https://yugioh.p51.nl, http://localhost:5173`
3. Copy the Domain, Client ID and Client Secret into `.env` as `AUTH0_ISSUER_BASE_URL` (with `https://`), `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.
4. Set `ADMIN_EMAIL` to your own email. Your login must report it as verified: Google and other social logins do; for username and password logins, verify the email first.

## Production

See [deploy.md](deploy.md). Changing `SESSION_SECRET` logs everyone out.
