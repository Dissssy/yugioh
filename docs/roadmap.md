# Roadmap: both starter decks, a whole duel

Written 2026-11-19 after reviewing a full duel between two players (Dawn of the Xyz mirror match, duel `TyppQfjSghnQi1B6`). The goal is that two friends can play either starter deck from the first draw to the last point of LP with every card doing what it says, without reporting or appealing anything. It continues the build order in [architecture.md](architecture.md); [effects.md](effects.md) and [chains.md](chains.md) describe what already works.

Each step leaves the site playable and is useful by itself. Steps 1 to 3 are in order, because Synchro and Xyz Summons need somewhere to go and continuous effects lean on Levels and materials. Steps 4 to 7 can be built in any order after that.

## What the reviewed duel showed

That duel started a minute after chains (PR #31) went live, but it ran on effect sheets stored before `when` existed. So no trigger was ever offered, and Mirror Force and Xyz Effect had no timing limit. PR #34 makes the card sync replace sheets in an older format. Most "effect didn't activate" complaints (Ganbara Knight, Feedback Warrior, Shining Angel) and the Mirror Force and Xyz Effect problems work with the current sheets. The rest are below.

## 1. Extra Deck and the Extra Monster Zones

- **Engine:** each player's Extra Deck as a pile, plus two shared Extra Monster Zones (`state.extraZones`, left and right of the middle strip). Under current rules, a monster Summoned from the Extra Deck may go to a Main Monster Zone or to an empty Extra Monster Zone, and each player may use only one Extra Monster Zone. Zone indices in intents, attacks and effects grow to cover them (an attack target, a card on the field).
- **Board:** the two zones in the middle strip ([duel-ui.md](duel-ui.md) already leaves room for them), the Extra Deck pile next to the Deck, browsable by its owner only.
- **Playable when:** a monster can be in an Extra Monster Zone (tests put it there), attack and be attacked from it, and be targeted, destroyed and Tributed like any other monster.
- **Built 2026-11-19.** Each player's `monsters` array has seven zones: the five Main Monster Zones, then the Extra Monster Zones on that player's left (5) and right (6), as EDOPro numbers them. The zones are shared, so a player's 5 is the opponent's 6 (`acrossTable`); a monster sits in its controller's array and the same zone across the table stays empty. Everything that reads "monsters you control" (attacks, targets, filters, Tributes, destruction) works on them unchanged. `monsterZonesFor(state, seat, fromExtraDeck)` lists where a monster may go: Main Deck monsters and anything Special Summoned by an effect only to a Main Monster Zone, a monster Summoned from the Extra Deck also to an empty Extra Monster Zone unless its controller already has one. The board shows the two zones in the middle row, above the second and fourth Main Monster Zones, with the chain between them.

## 2. Synchro Summon (5D's deck)

- The materials text on each Synchro sheet becomes structured: the Tuner (any Tuner, or a named one: Junk Warrior needs "Junk Synchron") and the non-Tuners (count, filter). The compiler writes it, the schema checks it.
- A `synchroSummon` legal action from the Extra Deck, when the player controls a Tuner and non-Tuners whose current Levels add up exactly. The player picks the materials on the board, and they go to the GY. Code alone, no judge call.
- The summon is a `summoned` happening with `how: synchro`, so Junk Warrior's trigger, Synchronized Realm and Colossal Fighter's trigger fire through the chains code. Synchro Blast Wave's condition becomes a script condition.
- Level changes already work (Feedback Warrior, Key Man, Harmonic Waves), so the deck's Level tuning works on day one.
- **Playable when:** each 5D's Synchro Monster can be Summoned from every material combination the deck can make, and its triggers fire.
- **Built 2026-11-19.** `EffectSheet.materials` is structured (`Materials` in `engine/src/types.ts`): `{ summon: 'synchro', tuner, nonTuners: { min, max } }` or `{ summon: 'xyz', level, count }`. The compiler writes it as JSON text and the schema checks it; the six Extra Deck sheets were filled in by hand. `legalActions` offers `extraSummon` for each Synchro Monster with every set of materials that works (one face-up Tuner, the named one if any, plus face-up non-Tuners whose current Levels add up) and the zones each set leaves open. The intent names the materials, the zone and the position; materials go to the GY in one `extraSummoned` event, which doesn't use the Normal Summon. `SummonKind` gained `synchro` and `xyz`; a `when` or condition that asks for `special` matches them too (`summonMatches`). Junk Warrior's trigger and Synchronized Realm's now ask for `synchro`, and Synchronized Realm's 500 damage is scripted (the card itself waits for step 4). On the board, the Extra Deck glows when something in it can be Summoned; clicking the card in the pile offers Synchro Summon in Attack or Defense Position, then the materials are picked on the field and, if it may go to more than one, the zone.

## 3. Xyz Summon (Dawn of the Xyz deck)

- Structured materials as in step 2 ("2 Level 4 monsters"). An `xyzSummon` action when the player controls enough face-up monsters of the same current Level. The materials are attached under the Xyz Monster, not sent to the GY.
- Xyz Materials in the state, the board (cards tucked under the monster, with a count) and the log. New ops and script steps `attach` and `detach`, and detaching as a cost (Xyz Energy, Number 39: Utopia). Materials go to the GY when the monster leaves the field.
- Xyz Monsters have a Rank and no Level: Level filters and Level changes must skip them. This is already done for Harmonic Waves; give it a test per card that reads Levels.
- `summoned` with `how: xyz` makes Xyz Effect offerable. Reinforced Space counts materials. Script conditions count materials ("an Xyz Monster with material").
- Grenosaurus needs "when this card destroys a monster by battle". That is a `destroyed_by_battle` `when` that names the destroying card (`by: self`).
- **Playable when:** each Xyz deck Xyz Monster can be Summoned, Xyz Energy and Utopia detach, and Xyz Effect and Reinforced Space work.
- **Built 2026-11-19.** `legalActions` offers `extraSummon` with `how: 'xyz'` for every set of `count` face-up monsters whose current Level is the Rank (Tuners included; an Xyz Monster has no Level, so it is never one). The materials leave play and sit in `FieldCard.materials`, oldest first; `locate` reports them as zone `materials`, which no filter's place matches, and both players see them. They go to their owners' GYs when the monster leaves the field. The op and script step `detach` move one to the GY; a `detach` step's selection picks the Xyz Monster (only those with enough materials), and the player picks which materials when there are more than it takes. The script condition `materials` (min/max) covers "while it has no material". `battle_destroying` is the destroying monster's side of a battle destruction ("When this card destroys a monster by battle"). No `attach` yet: no card in either deck attaches. Scripted: Utopia (both effects), Grenosaurus, Xyz Energy, Xyz Effect (`how: ['xyz']`). Reinforced Space stays with the judge, which now sees each Xyz Monster's materials; Gachi Gachi Gantetsu's effects wait for step 4. On the board the materials are tucked under the monster with a gold count, and fan out beside it when a question offers them.

## 4. Continuous effects and cards that stay on the field

The biggest step: ten monsters and a dozen Spells and Traps in the two decks need it. Continuous effects can't be judge calls, because they apply all the time. They are structured data on the sheet, applied by code.

- **Model:** a pure `effective(state)` derives current ATK/DEF/Level, attack and target restrictions, and battle protection from every face-up card's continuous effects on each read. Nothing is stored or expires, so it can't go stale. Timed changes (`modify_stats` with an end) stay as they are and stack on top.
- **Vocabulary** (add only what these cards need): stat change for cards matching a filter, with a condition (Banner of Courage: your Battle Phase; Blade Knight: 1 or fewer cards in hand; Tenshin: +400 per face-up Level 2 you control; Shine Knight: Level 4 while in Defense; Gachi Gachi Gantetsu and Colossal Fighter: per material or per card in GY). Also "can't be attacked except this card" (Marauding Captain), "can't be destroyed by battle with 1900+ ATK" (Sonic Chick), "can't attack or change position" (Spellbinding Circle), and "opponent's monsters can't declare an attack" (Swords of Revealing Light, Threatening Roar).
- **Cards that stay:** Continuous Spells and Traps are offered for activation and stay face-up. Equip Spells (Lucky Iron Axe, Synchro Boost, Symbols of Duty) attach to a monster and are destroyed when it leaves. Swords of Revealing Light counts its controller's opponent's turns and is destroyed on the third End Phase. Continuous Traps that Special Summon (Birthright, Limit Reverse) tie their monster to the card.
- **Lingering restrictions** from resolved effects (Reinforce Truth: "cannot conduct your Battle Phase"; Threatening Roar) go into the same derived layer, with an end, instead of the summary's "not applied".
- **Playable when:** every card in the list above works, and the eval suite has a case for each.
- **Built so far (2026-11-19):** continuous stat effects and Continuous Spells (see "Continuous effects" in [effects.md](effects.md)). Banner of Courage, Tenshin, Blade Knight's ATK, Shine Knight, Gachi Gachi Gantetsu's boost and Colossal Fighter's ATK work. Still to come: battle restrictions and protection, Swords of Revealing Light, Equip Spells, Continuous Traps tied to a monster, and lingering restrictions.

## 5. Negation and Counter Traps

- `when.event === 'activated'` is offered (Seven Tools of the Bandit: a Trap; Divine Wrath: a monster effect), with spell speed 3 enforced (only a Counter Trap answers a Counter Trap).
- A `negate_activation` op and script step marks a chain link as negated: it doesn't resolve, and "and if you do, destroy it" follows.
- "Its effects are negated" on a monster (Junk Synchron's and Speed Bird's summons, Blade Knight against Flip monsters) is a flag that `effective` and trigger detection respect.
- Scrap-Iron Scarecrow's "Set this card instead of sending it to the GY".
- **Playable when:** a Counter Trap can negate a Trap that answered a summon (the "Playable when" of architecture layer 4).

## 6. The remaining timing

- **Damage Step:** a "start of the Damage Step" happening (Zubaba Knight).
- **Phase triggers:** `when` on a phase ("During the End Phase of the turn this card was Summoned", Majestic Mech - Senku; Swords' countdown).
- **Leaving the field:** "When this card leaves the field" and "If this card is destroyed by your opponent's card effect" (Birthright, Limit Reverse, Symbols of Duty, Lucky Iron Axe, Miniaturize).
- **Counters:** Spell Counters (Frequency Magician), with ops to place and remove them.

## 7. Rollback (architecture layer 6)

"Then undo it" was asked for in the reviewed duel, right after the Mirror Force overturn. An overturned ruling offers both players a rewind to just before it, with the corrected ops. Both must accept.

## Alongside: things players noticed

- **Card zoom while aiming an attack** didn't work (Shift held during the attack drag). Reproduce in the browser first.
- **Dark Blade's image disappeared** after Blustering Winds raised its stats. Reproduce first.
- **Auto-picked targets:** when only one card can be targeted, the activation picks it without asking. In the reviewed duel, Mystical Space Typhoon destroyed its owner's own Mirror Force that way. Show the target and let the player confirm or cancel before the activation is committed.
- **Priority after your own summon:** the turn player can't Set while holding priority in the summon's response window, and nothing says why. Show "Responding to your summon" with a clear Pass. PR #34 already makes a drop ask before activating.

## Card coverage

What each card that doesn't fully work yet waits on. Every other effect in the two decks is handled today, by its script or by the judge.

| Step | Cards |
| --- | --- |
| 2 Synchro | Junk Warrior, Gaia Knight, Colossal Fighter (Summon), Synchronized Realm, Synchro Blast Wave |
| 3 Xyz | Number 39: Utopia, Grenosaurus, Gachi Gachi Gantetsu (Summon), Xyz Energy, Xyz Effect, Reinforced Space |
| 4 Continuous | Banner of Courage, Tenshin, Blade Knight, Shine Knight, Sonic Chick, Marauding Captain (lock), Gachi Gachi Gantetsu, Colossal Fighter, Lucky Iron Axe, Synchro Boost, Symbols of Duty, Swords of Revealing Light, Spellbinding Circle, Miniaturize, Birthright, Limit Reverse, Threatening Roar, Reinforce Truth (restriction) |
| 5 Negation | Seven Tools of the Bandit, Divine Wrath, Scrap-Iron Scarecrow, Junk Synchron and Speed Bird ("effects negated") |
| 6 Timing | Zubaba Knight, Majestic Mech - Senku (End Phase), Frequency Magician |

Each card is checked off when it has an eval case and a person has marked its sheet verified.
