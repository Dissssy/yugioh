# Review requests: sending rulings and duel problems to Claude

Status, 2026-11-24: plan. Ethan chose the site queue with an hourly check. The `RESET_SHEETS` replacement is built; the rest isn't.

An admin who sees something wrong in a duel (a ruling, or a move that was never offered) sends it to Claude with one click. A Claude thread in this project picks it up with the full context, finds the cause, fixes it in a pull request, and reports back on the request. This replaces pasting logs into a thread and the thread borrowing Ethan's browser sign-in.

## The pieces

### 1. The admin action

- **Send to Claude** on: a player report or appeal in the Rulings section, a line of a duel's Full log, and a duel as a whole. It asks for a note ("Pot of Greed was never offered at #212").
- It saves a row in `review_requests`: `id`, `match_id`, `seq` (nullable), `code` (card, nullable), `note`, `sent_by`, `status` (`open`, `claimed`, `fixed`, `wont_fix`), `claimed_at`, `result` (Claude's short finding) and `pr_url`.
- The admin page lists requests with their status and PR link.

### 2. The bundle

`GET /api/admin/reviews/:id/bundle` returns everything a thread needs in one JSON document:

- the request itself;
- the duel's full JSON report (`matchReport`: every event, judge transcripts included);
- at `seq` (or at the end of the duel): both seats' views with nothing hidden, the full `DuelState`, and the moves the engine offered each seat there, plus `blockedEffects` / `blockedAttacks` with their reasons. "Never offered" bugs show up here;
- for each card named by the request or touched near `seq`: its text, current sheet, and sheet revisions;
- the commit of the running image (from a `GIT_SHA` build arg), so the thread reads the code that actually ran.

### 3. Authentication: admin API keys

- Table `api_keys`: `id`, `name`, `hash` (SHA-256 of the key), `created_by`, `created_at`, `last_used_at`. The key is shown once at creation.
- The super admin creates and revokes keys on the admin page.
- `Authorization: Bearer <key>` on `/api/admin/*` acts as an admin: it can read logs and reports, edit sheets, and update review requests. It can't change roles or start AI duels (super-admin routes refuse keys).

### 4. Getting requests to a thread

The site holds the queue and a Claude thread polls it:

- A scheduled task in this project runs hourly. It calls `GET /api/admin/reviews?status=open`; with nothing open, the run ends there.
- For each request it calls `POST /api/admin/reviews/:id` with `status: claimed`, fetches the bundle, finds the cause, and opens a PR on the repository (engine fix, sheet fix, or both, with a test reproducing the bug from the bundle's state).
- A fix that changes only a sheet also goes live right away through `POST /api/admin/sheets/:code`; the PR makes it permanent in the repo.
- It finishes with `POST /api/admin/reviews/:id` carrying `status`, `result` and `pr_url`.

Needed in the cloud environment: `yugioh.p51.nl` on the network allowlist, and the key as an environment variable (like `JUDGE_ANTHROPIC_API_KEY`).

Why not a webhook: the cloud environment can't receive an arbitrary HTTP webhook into a project thread, so a push would need a relay anyway. GitHub issues could be that relay, but they would put duel details on GitHub, need a GitHub token on the server, and still be too small for a bundle. Polling hourly is simple, and the request itself shows on the admin page.

## Repo sheets vs. the database (built)

`RESET_SHEETS=true` used to wipe every stored sheet, revision and report at each start, so admin edits were lost on every deploy. It also broke running duels: duel `tznEic2SgbY_udh7` loaded in the gap between the wipe and the reimport, saw no sheet for any of its 34 cards, and logged `sheetUpdated` with no sheet for each of them (#116 to #149), so no effect could be activated for the rest of the duel.

Now `effect_sheets.file_hash` records the hash of the repo file each sheet was last imported from. At start, before serving, the server imports a repo file only when its hash differs from that record. So:

- a fix merged into the repo reaches the site on the next deploy;
- an admin edit or a live hotfix survives restarts until the repo changes that card;
- revisions and reports build up across deploys;
- a duel never loses a sheet: `sheetUpdated` always carries one, and a card missing from the database keeps the duel's copy.

The review loop moves live hotfixes into the repo, and `GET /api/admin/sheets?drifted=1` (sheets whose database copy differs from the image's repo file) lets a thread find any it missed.

## Build order

1. Replace `RESET_SHEETS` with the hash-based import (built), and fold the current admin edits into `server/effect-sheets/`.
2. API keys and `/api/admin/sheets?drifted=1`.
3. `review_requests`, Send to Claude, and the bundle.
4. The scheduled task in this project.

This is a first slice of the deferred headless mode / public API: the key scheme can later widen to player keys.
