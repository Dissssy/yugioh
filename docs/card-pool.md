# The card pool

Status, 2026-11-23. The pool is the set of cards the site supports, on the way to deckbuilding. It grows down the
list of English TCG sets by release date, oldest first, one set per pull request, each stacked on the one before.
Ethan chose to go set by set through Metal Raiders first, so each step brings only a little engine work.

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
