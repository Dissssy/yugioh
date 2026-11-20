# New decks: Duelist Toolbox and Freezing Chains

Status, 2026-11-20: both decks are premade decks with compiled sheets (Opus, about $8.90 for 72 sheets). This page lists what their cards need from the engine and the order to build it in. Ethan chose these two decks to widen rulings coverage and test how far the system extends; Kaiba Reloaded and Yugi Reloaded come in a later cycle.

Duelist Toolbox has 38 Main Deck cards (the set printed one copy of each), below the usual 40. Duels don't check deck size, so it plays as it is.

## Where the new cards stand

Of the new cards' 124 effects, Opus scripted 25 and gave 6 continuous effects data. Activated effects without a script go to the judge, as they do today. What doesn't work yet falls into four groups, each a generic mechanic rather than a card:

1. **Summoning procedures from the hand.** A `condition` effect such as "You can Special Summon this card (from your hand) by ..." isn't offered at all, and "Cannot be Normal Summoned/Set" isn't enforced. Cards: Aqua Spirit, Medium, Prior and Silent Angler of the Ice Barrier, Quickdraw Synchron, Turret Warrior, Moulinglacia the Elemental Lord.
2. **Continuous effects with no data**, which therefore do nothing:
   - attack locks by a stat or Level (Cryomancer, Defender of the Ice Barrier) and position locks (Speaker for the Ice Barriers);
   - activation locks (Medium: one Spell/Trap a turn; Warlock; Mind Drain; Spellbreaker; Revealer: no Tribute Summons);
   - battle changes (Hayabusa Knight's second attack, Twin-Sword Marauder's piercing and second attack, Fortress Warrior's no battle damage and once-per-turn survival, X-Saber Galahad's Damage Step stats);
   - protection (Dai-sojo, Freezing Chains of the Ice Barrier), Fiendish Chain negating the monster it's tied to;
   - "can't be Synchro Material" (Fishborg Launcher, Quickdraw Synchron, Ronintoadin) and name changes (Dupe Frog, Ronintoadin).
3. **New ops** the judge and scripts don't have: take control of a monster (Enemy Controller, Crackdown), Tokens (Speaker), a random card from a hand (Moulinglacia, X-Saber Urbellum, Trishula), looking at and placing the top card of the Deck (Dark Tinker), "banish it when it leaves the field" (Quillbolt Hedgehog, Fishborg Launcher, Zuijin), and skipping a Battle Phase (Moulinglacia).
4. **Synchro details:** Quickdraw Synchron standing in for a "Synchron" Tuner, Junk Destroyer counting its non-Tuner materials, and Trishula, Zero Dragon's "2 or more non-Tuners".

## Build order

Each step leaves both decks playable, and each new piece of vocabulary goes into the compiler's prompt so Opus can use it, then the affected cards are recompiled (`sheets:compile -- --force "Name"`), with offline eval cases for the new steps.

1. Summoning procedures from the hand, and "cannot be Normal Summoned". Built: a `condition` effect with a script is a procedure (docs/effects.md), with new vocabulary for it (`outnumbered`, `named` filters, `gain_stats` with a value from the cost, and `forbid` of Special Summons with a filter, which code enforces on effects, procedures and Synchro and Xyz Summons). The seven cards are recompiled, with eval cases. Not yet: a procedure whose cost frees the last Monster Zone (Turret Warrior with five monsters out) isn't offered; Prior's ban applies only after its Summon, not to Special Summons made earlier that turn; and a monster that must first be Special Summoned by its procedure can still be revived without it.
2. Taking control, Tokens, and random cards from a hand: the ops that whole effects need. Built: `take_control` (for good or until the End Phase), `summon_token`, `change_position`, a `random` selection, costs on script options, and an effect's `from` (hand, field or GY) so hand and GY effects can be scripted. Tokens vanish when they leave the field and can't be Xyz Material. The affected cards are recompiled, with eval cases. Effects that still need wording the vocabulary lacks (such as Trishula Dragon's banish) stay with the judge until step 4.
3. The continuous vocabulary: attack, position and activation locks, then battle changes and protection. Built: `restrict` gained protection from effects and "unaffected by" (`be_destroyed_by_effect`, `be_affected`, judged on the op's source card), `compare` and `once`; new `battle`, `lock` and `negate_linked` effects and the `battling` and `last_attack` conditions; filters gained `extraDeck`. Thirteen cards are recompiled (about $3.90) and five had their "another Ice Barrier monster" count fixed by hand (the card itself is never counted). Not yet: Spellbreaker's lingering Spell lock, Revealer's cost substitute, and Medium counting any Spell/Trap activation (effects of face-up ones too), not only card activations; Warlock lets a Set Spell be activated from the next turn, not the player's own next turn.
4. The rest: banish-when-leaves, the Deck top, skipping the Battle Phase, name changes, the Synchro details. Built: banish when it leaves the field, the `sent_to_graveyard` trigger event, looking at the Deck top and putting cards on the bottom (`arrange_top`), name changes, and what a monster allows as Synchro Material (Quickdraw Synchron standing in for a "Synchron" Tuner; Fishborg Launcher, Quickdraw and Ronintoadin's limits). Trishula's "2 or more non-Tuners" already worked. Not yet: Moulinglacia skipping its controller's next Battle Phase when it leaves the field, Junk Destroyer counting its non-Tuner materials, and Trishula's banish (all with the judge or not applied).
5. Self-play with the four decks against each other to find what still breaks. Done: random self-play (a stand-in model picking moves, no judge) over all 16 deck pairings, three times. Every duel finished with no refused move and no script error once Dark Tinker showed its card as a question option and an Equip Spell that leaves the field mid-chain stopped undoing the Summon it made.

## Follow-up: effects that did nothing (2026-11-20)

An audit of every sheet after the FLIP fix found effects missing from the lists above. Now built, with engine tests:

- Hexa Spirit of the Ice Barrier: its −500 ATK/DEF was expressible as `stats` but compiled empty; filled in by hand.
- Crackdown: `restrict` gained `activate_effects`, so the monster it took can't attack or activate effects.
- Blade Knight: `negate_battled_flips` (with `while`) negates the FLIP effects of monsters it destroys by battle.
- General Wayne: `banish_instead` banishes fitting cards leaving the field instead of sending them to the GY.
- Chainsaw Insect: the `damage_step_end` event (its `self` matches either monster in the battle), pushed when an attack that reached the Damage Step ends.
- General Grunard: `extra_normal_summon` lets its controller Normal Summon (not Set) one more fitting monster from the hand, limited by the effect's `opt`. The `normalSummoned` event records which effect allowed it.
- General Raiho: `discard_or_negate`. Before a monster effect activated on the field resolves, a new `tax` step asks its controller to discard 1 card or let the effect be negated (`taxDemanded`/`taxAnswered`, intent `tax`).
