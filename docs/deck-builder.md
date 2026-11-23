# Deck builder

Planned 2026-11-23 with Ethan. Nothing here is built yet. This plan replaces the one-line "deck builder" entry in
[architecture.md](architecture.md) layer 8 and the "not planned yet" note in [next-steps.md](next-steps.md).

## What Ethan asked for

- **A searchable card list.** Fuzzy search covers card names and card text. Later, the search bar also takes terms
  like `def:>1000`, with a help menu that explains them.
- **Every card shows up, even the ones you can't add.** A card you can't add is dimmed and sorted after the ones you
  can, with the reason in red. For example: you already have the most this banlist allows (1, 2 or 3), this banlist
  bans it, or it isn't in the game yet.
- **Building is tied to challenges.** A challenge between two accounts gets a pre-duel stage where both players
  build or pick a deck for that challenge's rules. This is a first version. The rest of the challenge UX (open
  challenges in a list, notifications) comes much later.
- **Banlists work like decks.** There are default lists for different formats, and players can make their own.
- **A Side Deck now**, even though nothing uses it until best of 3, which is wanted later.
- **Decks are private by default, but can be shared.**
- **Any premade or shared deck can be the start of a new one.** You edit it and save a copy. A deck that isn't
  finished can't be used in a duel.

## The page

The layout follows the screenshot Ethan shared (Master Duel's builder) and today's deck page: three columns.

| Left | Middle | Right |
| --- | --- | --- |
| The card you're pointing at (`CardDetail`), with **+1** and **−1** buttons and the reason if you can't add it | The deck's name, then Main, Extra and Side as card grids with their counts. Problems with the deck as a whole are listed here, like "38 of 40 Main Deck cards" | The search bar, filter and sort buttons, then the results as a grid |

- Clicking a result adds it to the Main Deck, or to the Extra Deck if it's a Fusion, Synchro or Xyz Monster.
  Clicking a card in the deck removes it. You can also drag cards between the grid and each section, including Side.
  On a phone the columns become tabs and you tap and hold for the details, as on the duel board.
- Shift zooms the card and right-click pins its tooltip, the same as on the board.
- The deck saves itself as you edit it. The deck list is under **Decks** in the account menu, and **New deck** starts
  an empty one.
- **Results order:** cards you can add come first, then the rest. Within each group, the best search match comes
  first, or the chosen sort (name, ATK, DEF, Level) when there's no search text.

### Why you can't add a card

Each result is checked against the deck you're building and the banlist you're building for. The first reason that
applies is shown:

| Reason | Shown as |
| --- | --- |
| The card isn't in the game yet (not in `poolCardIds()`) | Not in the game yet |
| The banlist allows 0 | Forbidden under {banlist} |
| The deck already has as many copies as the banlist allows, across Main, Extra and Side | You have {n} of {n} |
| The section is full (60 Main, 15 Extra, 15 Side) | Main Deck is full |

A card that isn't in the game yet also has no downloaded image (we only download pool images), so it shows as a plain
frame with its name and type.

### Search

- **Runs in the browser.** The page loads one list of every card in our database (about 14,000) with the fields search
  needs: name, text, type, attribute, race, archetype, ATK, DEF, Level, and whether it's in the pool. It's cached and
  reloads only when the card import changes. Searching in the browser makes every keystroke instant, and the reasons
  update as you add cards without asking the server.
- **[MiniSearch](https://github.com/lucaong/minisearch)** does the fuzzy search over names and text, with names
  weighted higher. It's small, has no dependencies, and is fast on this size of list. Fuse.js was the other option, but
  it scans every card's full text on each search, which is slow at 14,000 cards.
- **Search terms (later step):** `atk:>1800`, `def:<=1000`, `level:4`, `attr:dark`, `type:dragon`, `kind:trap`,
  `arch:"blue-eyes"`, combined with the free text. Our own small parser turns them into filters, applied before
  MiniSearch ranks the rest. A **?** button by the search bar opens the help listing every term.

## Rules

One function in `shared` checks a deck: `checkDeck(deck, banlist, pool)`. It returns the problems with the deck as a
whole and, for any card, why it can't be added. The page uses it as you build. The server uses it when a duel is
joined, so a deck can never get into a duel illegally.

- Main Deck 40 to 60, Extra Deck 0 to 15, Side Deck 0 to 15.
- At most 3 copies of a card across all three, or fewer if the banlist says so.
- Every card must be in the pool.

### Finished decks

There isn't a separate draft area. Every deck saves as you go, and the decks list shows whether each one is legal under
each banlist. A deck that's illegal under the duel's banlist isn't offered for that duel. That covers the unfinished
deck (38 cards isn't legal anywhere), and also a deck that's fine under one list but not another. So there's no
"publish" step to remember, and no deck that's marked finished but is actually illegal.

### Banlists

A banlist is a name and a limit per card: 0, 1 or 2. Any card it doesn't list is allowed 3 copies.

- **Default lists** have no owner and are made from YGOPRODeck's `banlist_info` on every card import:
  **No list**, **TCG** (current), **OCG** (current) and **Goat**. YGOPRODeck has no older lists. A historical list,
  like the TCG list from 2002, would be an admin-made list.
- **Players' lists** work like decks: private by default, shareable by link, and you can copy any list you can see.
  The editor is the same card search. Each result gets a 0 / 1 / 2 / 3 picker in place of +1 and −1.
- Admins can edit the default lists.

## Decks and sharing

- A deck has an owner (none for a premade deck), a name, Main, Extra and Side lists, and a **shared** switch. A shared
  deck can be seen by anyone with its link, like a replay. Copying it needs an account.
- **Copy** on any deck you can see (premade, shared, or your own) makes a new deck of yours and opens it.
- **`.ydk` import and export**, the format most other Yu-Gi-Oh! tools use. Import makes a new deck. Cards that aren't
  in the pool still come in, and are flagged the same way as in search.

## The pre-duel stage

Today the challenger picks a deck when making the challenge, and the opponent picks one when accepting. With the deck
builder, a challenge records a **banlist** (its format), and choosing decks moves into a stage between accepting and
rock-paper-scissors:

1. The challenger makes the challenge and picks its banlist. TCG is the default.
2. The opponent accepts. The duel is now **preparing** (a new status between `waiting` and `active`).
3. Each player picks a deck: one of their own decks that's legal under the banlist, or a premade one. **Build one**
   opens the builder for that banlist, then returns to the duel. Each player sees whether the other is ready, but not
   their deck.
4. When both have picked and pressed Ready, the server checks both decks with `checkDeck` and the duel starts with
   rock-paper-scissors as it does now.

The duel's start event already records both deck lists, so after the start, a duel doesn't depend on the deck. Editing
or deleting the deck later changes nothing. `matches` keeps each deck's name for the duel lists. It no longer
references `decks`.

The AI opponent keeps using premade decks.

### Guests

Guests can't build decks (accounts.md). To keep duels against guests fair, the challenger chooses **Premade decks
only** or **Any legal deck** when making the challenge. A guest can only accept a premade-only challenge.

### The Side Deck

It's built, saved, checked and exported now, but nothing uses it in a duel. When best of 3 comes, siding happens
between games, in the same place as the pre-duel stage.

## Build order

Each step is a working product on its own.

1. **Decks.** The `decks` table gets an owner, Side Deck and the shared switch. The card catalog API, the builder page
   with search and reasons, `checkDeck` with the basic rules (no banlist yet), autosave, copy, sharing, and your decks
   in the account menu. Challenges and joins offer your legal decks as well as the premade ones. Premade-only stays
   the only option for guests.
2. **Banlists.** The `banlists` table, the four defaults from the card import, the banlist editor, and a banlist on
   each challenge that both decks are checked against.
3. **The pre-duel stage.** The `preparing` status, the deck picker and Ready in the duel page, Build one, and the
   premade-only switch for guests.
4. **Search terms** and the help menu.
5. **`.ydk` import and export.**
6. **Later, not in this plan:** best of 3 with siding, draft mode, and the challenge list and notifications.

## Decisions

| Question | Recommendation | Other options |
| --- | --- | --- |
| Cards from premade decks released after `POOL_YEAR` (like the 5D's and Xyz starters) | Buildable, since they're in the pool and their sheets are written. A copied premade deck stays legal | Only cards from 2002 and earlier: a copy of a later premade deck gets flagged |
| Draft area | No draft area. Decks save as you go, and only decks legal under the duel's banlist are offered | An explicit draft or finished state on each deck |
| Fair duels against guests | The challenger picks Premade only or Any legal deck. Guests can only accept Premade only | Guests can also build a deck in the pre-duel stage that only lasts for that duel |
| The default banlist for a challenge | TCG (current) | No list, or Goat, which is the closest to the 2002 card pool |
| Side Deck before best of 3 | Build and save it, but don't use it | Let the pre-duel stage swap Side Deck cards in, which doesn't do anything before game 2 |
| Who sees a shared deck | Anyone with the link, signed in or not. Copying it needs an account | Signed-in players only |
| Fuzzy search library | MiniSearch | Fuse.js (slower at 14,000 cards) |
