# Cards, decks and duels

As of 2026-11-18. This is build layer 1 of [architecture.md](architecture.md): a vanilla duel between two browsers over a link, with no LLM yet.

## Card data

`server/src/cards.ts` copies YGOPRODeck into our own Postgres; the game never calls their API while playing.

- **When:** the server syncs at startup and then once a day. It first asks `checkDBVer.php` for YGOPRODeck's database version and only re-imports when that changed, so a sync is one tiny request most days. `npm run cards:import` runs a sync by hand; add `-- --force` to re-import regardless.
- **What:** every card (about 14,700) goes into the `cards` table with its text, stats and a sha256 of the text (`text_hash`), which later tells us when errata means an effect sheet must be recompiled. The full API record, minus prices, is kept in `raw`.
- **Images:** only for cards in a deck, full size and small, saved under `CARD_IMAGE_DIR` (default `data/card-images/`) and served from `/card-images/`. Keep that folder on persistent storage in production.
- **Terms:** YGOPRODeck asks clients to store data locally, stay under 20 requests a second, and re-host images rather than hotlink them. The sync does all three (images download one at a time with a short pause).

## Premade decks

The two starter decks are built from YGOPRODeck's set data on every import, so no list is typed by hand: one copy of each card printed in the set, in set-number order.

| Deck | YGOPRODeck set | Main | Extra |
| --- | --- | --- | --- |
| Yu-Gi-Oh! 5D's Starter Deck (2008) | Starter Deck: Yu-Gi-Oh! 5D's (5DS1) | 40 | 3 Synchro |
| Starter Deck: Dawn of the Xyz | Starter Deck: Dawn of the Xyz (YS11) | 40 | 3 Xyz |

They are rows in `decks` with a `slug` and no owner. Cards keep their current official text. `/decks/:id` on the site shows each list.

## The engine

`engine/` is a library with no knowledge of the server or accounts.

- **Event-sourced.** A duel is a list of events (`engine/src/types.ts`). `evolve` folds one event into the state; `replay` folds a whole log. The first event, `duelStarted`, holds the shuffled decks and a snapshot of every card's data, so a replay never depends on later errata or on the database.
- **decide** turns a player's intent into events or refuses it with a reason a player can read. It checks every rule itself and never trusts the client. The intent is stored as an event too, ready for contests later.
- **legalActions** lists what a player may do right now. The board only offers these, and the server checks again.
- **viewFor** builds one player's view. Cards the player can't see are sent without an ID or card data, and instance IDs are random, so the browser can't learn a hidden card. The duel log is rendered in the same pass and names no hidden card.

Rules covered in layer 1: opening hands of five, the first player skips their first draw and Battle Phase, one Normal Summon or Set per turn, tributes for Level 5 and up, Flip Summons, one position change per turn (not on the turn a monster arrived or after it attacked), Setting Spells and Traps, battle against attack and defense position (face-down monsters are flipped), battle damage, the six-card hand limit, and winning by LP 0, deck-out or surrender.

Not yet: card effects. Effect monsters fight as plain bodies with their printed ATK and DEF; Spells and Traps can be Set but not activated; Extra Deck monsters stay in the Extra Deck. Layers 2 and 3 add these.

## How a duel runs

1. An approved user picks a deck and creates a challenge, which opens `/duel/:id`. They send that link to their opponent.
2. An approved user opens the link and picks a deck. Someone without an account first opens one of the challenger's invite links; the challenge then shows on their home page. A guest can only accept challenges from the person who invited them.
3. Accepting deals the opening hands and starts the duel. Who goes first is a coin toss.
4. Each browser listens on `GET /api/duels/:id/stream` (Server-Sent Events) and gets its own view on connect and after every change. Moves go to `POST /api/duels/:id/intents`; a refused move answers 422 with the reason.

The server is the only authority. Live duels are held in memory and rebuilt from `match_events` on first use, and each duel handles one intent at a time. That assumes a single server process, which is how the site runs today.
