# Playing in Discord

As of 2026-11-24. The site also runs as a Discord Activity: the same web app, opened by Discord inside a call or a DM and served through Discord's proxy. It is built for the app's testers only, so it never needs Discord's app verification.

Built so far: signing in inside the Activity, and Discord logins and account linking on the website. Planned next: a Tables page per server, live mini boards on the tables, and a pop-out layout.

## Who can play

- Until an Activity is verified, Discord shows it only to the app's owner, its developer team and its **App Testers** (up to 50, invited by email). Testers turn on Application Test Mode with the app's ID.
- Unverified Activities launch only in servers with **fewer than 25 members**, and in DMs and group DMs. Testers aren't exempt.
- Verification would make the Activity visible to everyone on Discord and needs Discord's review. It isn't planned (the card art belongs to Konami).

## How signing in works

1. Discord opens the site with `frame_id`, `instance_id` and other values in the address. `web/src/discord.ts` sees `frame_id`, loads Discord's Embedded App SDK and asks Discord to `authorize` the player (scope `identify`; Discord asks only the first time).
2. The web app sends the code and the instance ID to `POST /api/discord/session`. The server trades the code for an access token, reads who the player is, and then asks Discord, with the app's bot token, who is in that running instance (`GET /applications/{app}/activity-instances/{instance}`). Anyone can run Discord's login against the app outside Discord, so the server lets someone in only when Discord lists them inside a running copy of the Activity, which only testers can open.
3. The account is found or created by Discord user ID (`users.discord_id`). Testers are trusted like approved players: a new account starts approved, and a pending one is approved. An account an admin rejected stays rejected.
4. The server sets a signed `discord` cookie holding the account ID, marked `SameSite=None; Secure; Partitioned` as Discord's docs advise for iframes, so the API and the live duel streams work as they do on the website. The Activity signs in again each time it opens.

## Discord on the website, and linking

- The website's **Log in** page offers the usual login (Auth0) and **Log in with Discord**. A Discord login on the website is an ordinary Discord OAuth login (`/auth/discord/login` → `/auth/discord/callback`), and a new account from it starts **pending**, like any website signup. Only the Activity approves on its own.
- The account page lists both logins and can add the missing one. Adding Discord sends an Auth0 account through Discord's login. Adding the website login sends a Discord account through Auth0's login, which comes back to `/auth/link/finish`. The Activity can't show Auth0's login, so this is done on the website.
- If the added login already has its own account, the two become one (`linkAccounts` in `server/src/accounts.ts`). The Auth0 account stays, unless only the Discord account is approved. The other account's decks, banlists, duels and ruling reports move over, and it is deleted. Two accounts that dueled each other can't be joined, and neither can one that is already linked to a different login.
- The `discord` cookie holds the Discord user ID, not the account ID, so it keeps working after accounts are joined. On the website it is `SameSite=Lax`. Log out ends both logins.

Inside the Activity there is no Log out: closing the Activity is leaving. Guests don't exist there, since everyone has signed in with Discord.

## Networking

Discord serves the Activity from `https://<client id>.discordsays.com` and forwards requests through URL mappings. The one mapping `/` → `yugioh.p51.nl` covers the whole site, because the web app uses only relative URLs and the server hosts the card images itself. Anything on another host would be blocked by Discord's Content Security Policy unless it gets its own mapping.

## Setting up the Discord app

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **Create the app.** New Application. Optionally create a developer team first (Teams) and make it the owner.
2. **OAuth2:** add the redirect `https://yugioh.p51.nl/auth/discord/callback`, for Log in with Discord on the website (add `http://localhost:5173/auth/discord/callback` too for local work). The Activity itself needs no redirect. Copy the **Client ID** and **Client Secret**.
3. **Bot:** Reset Token and copy the **bot token**. The server uses it only to check activity instances; the bot never joins a server.
4. **Activities → URL Mappings:** root mapping, prefix `/`, target `yugioh.p51.nl`.
5. **Activities → Settings:** tick Enable Activities. Choose the supported platforms (web/desktop, iOS, Android). Enabling creates the "Launch" entry point command.
6. **Installation:** under Installation Contexts tick Guild Install (and User Install for DMs), then use the install link to add the app to the server you'll play in.
7. **App Testers:** invite the people who should play. Each accepts the email, then turns on Application Test Mode in Discord's Advanced settings with the app's ID.
8. Add to the server's `.env` and restart the app:

   ```
   DISCORD_CLIENT_ID=
   DISCORD_CLIENT_SECRET=
   DISCORD_BOT_TOKEN=
   ```

   Set all three or none. Without them the Activity and Log in with Discord are off, and the rest of the site is unaffected.

To launch: join a voice channel (or a DM call) in Discord, open the Activities (rocket) button, and pick the app.

## Still to check on the first real launch

Discord's docs don't say whether these work, so check them once deployed:

- The live duel stream (Server-Sent Events at `/api/duels/<id>/stream`) through Discord's proxy. Discord's docs mention only WebSockets for long-lived connections.
- The partitioned cookie in the iOS and Android apps.
- Whether someone who isn't a tester can join an instance a tester started (the server would refuse their sign-in either way).
