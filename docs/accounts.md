# Accounts, approval and guests

As of 2026-11-18. This is the website shell that sits outside the duel engine: login, admin approval, and guests (people without an account who play through a challenge link). The engine never sees any of it.

## Access model

| Visitor | Can |
| --- | --- |
| Anonymous | See public pages, the premade decks, and any duel they have the link to. Can accept an open challenge as a guest. |
| Guest | Someone who accepted a challenge link without logging in, under a name they chose. Sees and plays their duels and can accept other challenge links, like an account. Can't create challenges or build decks. |
| Pending account | Logged in through Auth0, waiting for the admin. Can look but not play. |
| Approved account | Everything, including creating challenges. |
| Admin | Approves or rejects accounts. The account whose **verified** email equals `ADMIN_EMAIL` is the admin and is always approved. |

## Names

Other people only ever see an account's **username**, never its email. A new account gets a random one built from Yu-Gi-Oh words, like `Mystic_Kuriboh_4821`, and can change it from the home page as often as it likes. Usernames are 3 to 32 letters, digits, `_` or `-`, and unique regardless of case. Only the admin sees emails, on the accounts page, so they can tell who is asking to join.

Guests pick any name, so wherever other players see it, it reads `<name> (guest)`, which keeps a guest from passing as an account. A duel keeps the names the players had when it started.

A challenge link is the invite. Opening one signed out offers two ways in: log in (which comes back to the same link), or give a name and play as a guest. The guest is created in the same transaction that takes the seat, so a visitor who finds the seat already taken leaves nothing behind; they are told the duel already has two players.

A guest lasts while any of their duels is waiting or in progress, and for a day after their last duel finishes, so they can still see the final board. An hourly cleanup then deletes them. A guest stuck in an abandoned duel lasts as long as that duel does.

If a guest logs in on the same browser to an approved account, their seats move to the account and the guest is deleted. A pending account doesn't take the seats yet; that happens on the first request after the admin approves it. A seat in a duel the account itself created stays with the guest, since one player can't hold both seats.

## How it works

- **Login:** [express-openid-connect](https://github.com/auth0/express-openid-connect), Auth0's library for server-rendered apps. The session is an encrypted cookie on the site's own domain, so the API and the duel event streams authenticate with the same cookie and the browser never handles tokens.
- **Accounts:** on each login the server creates or refreshes the `users` row keyed by Auth0's `sub`. New rows start `pending` with a random username. Only `sub` and the email are read from the login; the email is used for the admin check and shown only to the admin.
- **Guests:** a `guests` row (random token and name) and a signed `guest` cookie holding the token. The row is checked on every request, so deleting it ends the guest's access at once. Duel seats are `user:<id>` or `guest:<id>`.
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
