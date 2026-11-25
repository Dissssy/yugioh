# The card pool

Status, 2026-11-25. The pool is the set of cards the site supports, and players build decks from it. It grows down
the list of English TCG sets by release date, oldest first, one set at a time, each by the process below.

## The set list

`server/card-sets.json` holds every English TCG set from 2002 to 2026 in release order (542 sets), parsed from a
"sets by release date" page Ethan supplied. Each entry has the set's list code, name, kind, release date and the
YGOPRODeck set it maps to. The list gives only the names and the order; card data always comes from YGOPRODeck.
528 sets map to a YGOPRODeck set. Those that don't are sub-decks of a box that YGOPRODeck lists as one set (Yugi's
Legendary Decks, Legendary Decks II, Legendary Dragon Decks), a few promos, and Speed Duel GX: Midterm Destruction.
Promo mappings are approximate and get checked when their year comes up.

`POOL_THROUGH` in `server/src/cards.ts` names the last set in the pool. Every card printed in that set or an earlier
one is in the pool, along with the premade decks' cards. Pool cards get effect sheets (`npm run sheets:compile`
compiles only cards without a current sheet, so a set adds sheets only for the cards that are new to the pool) and
images. `server/scripts/fixture.ts` rebuilds the tests' card fixture from the same list.

## Free cards and POOL_YEAR

Some cards need no written sheet. Normal Monsters have none, and `server/src/simple-sheets.ts` writes the sheet of a card
whose whole text is one of a few fixed wordings: an Extra Deck monster that lists only its materials, an Equip or Field
Spell that only changes ATK/DEF (or gives piercing), a monster that only does either, and a Normal Spell that only
deals damage, gains LP or draws. That covers 112 cards of the whole list, 37 of them by 2002. A test checks that code
writes the same sheet as the model or the admin did for every card both have.

These free cards join the pool ahead of their set once they are printed in a set released in or before `POOL_YEAR`
(2002 for now; it moves up a year at a time). `npm run sheets:generate` writes their files, keeping any current
sheet written another way, and the compile and the todo list skip them.

## Writing sheets in a thread

Sheets can be written by Claude in a Claude Code thread instead of the paid compile, so the API budget stays with the
game. `npm run sheets:todo <dir>` writes the pool cards that still need a sheet (`cards.json`, with each card's text
hash) and the instructions (`instructions.md`: the file format and the same prompt the compile uses). The thread writes
`server/effect-sheets/<code>.json` for each, with `"model": "claude-code"`, and `npm run sheets:check` validates every
pool sheet (schema, text hash, speed, kinds, Extra Deck materials) and exits non-zero on a problem.

## Adding a set

Ethan's rule (2026-11-24): a set is merged only when every card in it is ready for play, so the site never offers a
card that a test duel then shows to be broken. All the work for one set goes into one pull request (or a stack that
merges together), and it stays a draft until the last step is done.

1. **Sort.** Set `POOL_THROUGH` to the set and run `npm run sheets:generate`, then `npm run sheets:status -- <code>`.
   Normal Monsters need nothing, and code writes the sheets of the simple cards (`generated`). Every other new card
   shows as `missing`.
2. **Draft.** `npm run sheets:todo <dir>` lists the missing cards with the instructions. Write each card's sheet in
   the thread (`"model": "claude-code"`), scripting all the existing vocabulary allows. Note every effect it doesn't,
   and what it would need: that is the set's gap list. Such an effect keeps `script: null` (the judge rules on it)
   for now.
3. **Engine.** Close the gaps as generic vocabulary (engine types, sheet schema, compile prompt, the judge's script
   runner), quickest first. For anything that stays with the judge, make sure the judge's tools can carry out what
   the card does, and add eval cases for each new mechanic and each card the judge keeps.
4. **Finish.** Script the gap cards with the new vocabulary. A Starter or Structure Deck also goes into
   `PREMADE_DECKS`. Regenerate the test fixture (`server/scripts/fixture.ts`).
5. **Done when** `npm run sheets:status -- <code>` shows nothing `missing` or `inert`, `npm run sheets:check` is clean,
   typecheck and tests pass, and the set's section below lists every card still `judged`, with the reason. Then the
   pull request is marked ready.

`sheets:status` sorts each card of the set as `normal`, `generated`, `scripted`, `judged` (an effect has no script,
so the judge rules on it), `inert` (a continuous effect with nothing filled in: it does nothing) or `missing` (no
current sheet), and marks the cards that are new to the pool.

## New cards per year

Counted at each card's first printing in the list, without the 156 cards the four premade decks already had
(2026-11-23 snapshot of YGOPRODeck). Normal Monsters need no sheet.

| Year | New cards | Need a sheet |
|---|---|---|
| 2002 | 600 | 357 |
| 2003 | 534 | 479 |
| 2004 | 385 | 358 |
| 2005 | 273 | 245 |
| 2006 | 233 | 221 |
| 2007 | 438 | 427 |
| 2008 | 466 | 462 |
| 2009 | 454 | 449 |
| 2010 | 550 | 546 |
| 2011 | 583 | 576 |
| 2012 | 518 | 509 |
| 2013 | 604 | 582 |
| 2014 | 545 | 539 |
| 2015 | 627 | 621 |
| 2016 | 657 | 655 |
| 2017 | 641 | 633 |
| 2018 | 659 | 655 |
| 2019 | 758 | 746 |
| 2020 | 735 | 726 |
| 2021 | 632 | 629 |
| 2022 | 688 | 685 |
| 2023 | 678 | 675 |
| 2024 | 495 | 494 |
| 2025 | 545 | 543 |
| 2026 | 602 | 597 |

About 14,000 cards in all. A sheet costs about $0.12 to compile, so 2002 is about $44 and the whole list roughly
$1,600 (Skill Cards, which Speed Duels use, are counted but may never be compiled).

## Sets so far

### Legend of Blue Eyes White Dragon (LOB)

121 cards, 50 with effects. Built for it:

- **The Field Zone.** `spellTraps` has a sixth entry, `FIELD_ZONE` (5). A Field Spell is Set or activated only
  there, and one already there goes to the GY first. Field Spells stay on the field and apply their continuous
  effects like any other face-up Spell.
- **Fusion Summons.** A Fusion Monster's sheet lists its materials (`{"summon": "fusion", "materials": [...]}`, each
  an exact card name or a card filter). The step `fusion_summon` (Polymerization) has the player pick a Fusion
  Monster their materials allow, then each material in turn (only those that still leave a full set and a zone), then
  its position and zone. The materials go to the GY, and the monster counts as properly Summoned. `fusion` is a
  Summon kind, matched by `special` like Synchro and Xyz.
- **Winning hands.** The continuous effect `win_with_hand` works from the hand: a player holding every card it names
  wins the Duel (`DuelResult.reason` `handWin`). It is checked whenever a card reaches a hand (Exodia).
- **Forced battle positions.** The continuous effect `force_position` keeps the face-up monsters it covers in one
  battle position: after every event, any that isn't is changed (Dragon Capture Jar). This happens as the state
  folds, so no event is logged for it.

The compile cost $15.42 (about $0.31 a sheet at high effort, more than the last compile, because the compile prompt
has grown). Audit of the 50 sheets: four Equip and Field Spells (Sogen, Beast Fangs, Follow Wind, Silver Bow and
Arrow) came back with an invalid continuous part and were filled in by hand, as was Dragon Capture Jar's. Armed
Ninja, Reaper of the Cards and Hane-Hane go to the judge (revealing a Set card isn't vocabulary yet; Hane-Hane's
return to the hand was a compile miss). New eval cases cover Polymerization, Sogen and Dragon Capture Jar.

### Promos: Dark Duel Stories and Forbidden Memories (DDS, FMR)

Five cards, written in a thread rather than compiled. Salamandra, Metalmorph and Harpie's Pet Dragon are scripted.
Acid Trap Hole and Red-Eyes Black Metal Dragon go to the judge: flipping a monster and then deciding by its DEF isn't
vocabulary yet, and Special Summon procedures only start from the hand, not the Deck. Metalmorph's damage-calculation
gain is also left to the judge, and the Harpie's Pet Dragon count matches any card whose name contains "Harpie Lady".

The compile used to drop Flip effects' scripts; `flip` is now a scripted kind.

### Starter Deck: Yugi (SDY)

The first set done by the process above. 50 cards: 25 Normal Monsters, 2 written by code, 23 scripted, none left to
the judge. It is also a premade deck, "Starter Deck: Yugi (2002)". YGOPRODeck lists the deck's European reprints
(SDY-E001 ...) under the same set, so a premade deck now counts each card's copies within one family of set codes.

Built for it:

- **`shield`** (Waboku): for the rest of the turn the player takes no battle damage and/or their monsters can't be
  destroyed by battle, whichever monsters they control.
- **`reverse_stat_changes`** (Reverse Trap): until the End Phase, every ATK/DEF addition subtracts and every
  subtraction adds.
- **`allow_tribute`** (Soul Exchange): the player may Tribute that opponent's monster this turn, and must when they
  Tribute.
- **`normal_summon`** (Ultimate Offering): Normal Summon or Set a monster from the hand right away, on top of the usual
  one. Ultimate Offering has two quick effects, one for each window its text gives.
- **`monster_sent_this_turn`** (Last Will): a monster of the player's went from their field to their GY this turn.
- A `damage_step_end` trigger's filter now checks the attacker (Wall of Illusion: "attacked by a monster").

Known differences from the official rulings:

- Last Will Special Summons as it resolves, not at any time later in the turn.
- Reverse Trap also reverses a halving that a `gain_stats` step made (Half Shut), which it shouldn't.
- Wall of Illusion triggers at the end of the Damage Step, so it doesn't return the attacker if Wall was destroyed in
  that battle. The engine has no "after damage calculation" timing yet.
- De-Spell can target a face-up Trap (it is revealed and not destroyed). A filter can't say "a face-up Spell, or a
  Set card".

New eval cases cover Waboku, Reverse Trap, Soul Exchange, Last Will, Ultimate Offering and Wall of Illusion.

### Starter Deck: Kaiba (SDK)

50 cards: 26 Normal Monsters, 2 written by code, 22 scripted, none left to the judge. 12 of its cards were already in
the pool from Starter Deck: Yugi. It is a premade deck, "Starter Deck: Kaiba (2002)", the opponent for Yugi's.

Built for it:

- **`look`** (Ancient Telescope, The Inexperienced Spy): the player looks at the selected cards. Only their log names
  the cards (event `looked`); the other player's log gives only how many.
- **The `deck_top` selection**: the top n cards of a player's Deck.
- **The `be_targeted` restriction** (Lord of D.): the cards it covers are never offered as targets, and the op that
  declares targets refuses them.
- **Picking cards you can't see** (The Inexperienced Spy): a `choose` over the opponent's hand offers its cards
  face-down, in hand order. The player clicks one of the card backs in the opponent's hand, and the server matches the
  pick by a key made for that question only, so the pick never tells them which card is which.

New eval cases cover Just Desserts, The Flute of Summoning Dragon (with and without Lord of D.), Lord of D., Ancient
Telescope and The Inexperienced Spy.
