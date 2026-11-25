# Chains, response windows and triggers

Built 2026-11-19 (layers 4 and 5 of [architecture.md](architecture.md), without negation, Counter Traps or continuous effects). Code runs all timing: which effects may be activated now, who has priority, the order triggers go on the chain, and when the chain resolves. Card scripts or the judge only decide whether one activation is legal and what it does (see [effects.md](effects.md)).

## The step

`DuelState.step` (`DuelStep` in `engine/src/types.ts`) says where the duel is:

- `open`: the turn player may do anything their phase allows.
- `triggers`: something happened (`cause`) and trigger effects are being collected. `handled` lists the triggers already activated and `passed` the players who declined their optional ones.
- `respond`: a response window. `priority` is the player who may act, `actor` the one whose action opened it, and `passed` is true after one pass. Two passes in a row resolve the chain, or close the window when the chain is empty.
- `resolve`: the chain resolves from the last link down. After each link, its happenings are checked for triggers again.
- `continue`: what the window was holding up (`then`): back to `open`, an attack's Damage Step and then its damage calculation, or the end of the turn.
- `replace`: a monster would be destroyed by battle and can detach materials instead (Gachi Gachi Gantetsu); its controller answers with the `replace` intent, then damage calculation goes on.

Everything that happens in a duel that a trigger could answer is pushed onto `state.happened` as a `Happening` (summoned, attack declared, attacked, destroyed by battle or by a card effect, the start of the Damage Step, battle damage, a phase starting). Each one carries the number of links resolved so far, so an optional "When ... you can" trigger misses the timing if it wasn't the last thing to happen.

## Who drives it

The engine's `nextStep(state)` (`engine/src/chain.ts`) says what happens next, and the server's `advance()` loop in `server/src/duels.ts` does it:

- `events`: code-only steps, committed at once (finishing the trigger step, battle damage, ending the turn).
- `trigger`: a mandatory trigger goes on the chain. Its activation is ruled by its script or the judge like any other.
- `resolve`: the top link resolves.
- `wait`: a player has to decide. If they hold nothing that could be activated, the server passes for them after the response floor.

General Raiho adds a `tax` step: before a monster effect activated on the field resolves, its controller discards 1 card or lets the effect be negated. Chainsaw Insect's `damage_step_end` happens as an attack that reached the Damage Step ends, with the battle's other triggers.

FLIP effects are triggers whose event is always their own card being `flipped` face-up: by a Flip Summon, by an attack (after damage calculation, so Man-Eater Bug destroyed by that battle still activates from the GY), or by an effect that changes its position. Sheets leave their `when` null; code supplies it.

Triggers go on the chain in SEGOC order: the turn player's mandatory, the opponent's mandatory, the turn player's optional, the opponent's optional. An optional trigger is offered to its controller with **Don't activate**.

## Windows

A window opens after a Normal or Flip Summon, an attack declaration, every activation (priority goes to the other player), the start of the Battle Phase, and the End Phase. In a chain, a response must have spell speed 2 or more and at least the highest speed already on it. An effect with a `when` (Trap Hole answers "a monster with 1000 or more ATK was Normal or Flip Summoned", Mirror Force "an opponent's monster declares an attack") is only offered in a window whose cause matches. Quick-Play Spells activate from the hand only on their controller's turn.

**The timing floor.** A window where the player has nothing to activate closes by itself after `RESPONSE_FLOOR_MS` (default 2000) plus up to half again at random, so how fast a window closes reveals nothing about a hand or a Set card. Meanwhile that player sees the question with a greyed-out Pass button, since the window closes for them. A player who does hold a response gets the window until they act or pass. The player whose own action opened the window gets no floor. Tests set the floor to 0.

**Replays.** If the attack target leaves the field before the Damage Step, or a monster appears for a direct attack, the attack ends and the attacker may attack again. Once the Damage Step has started (its triggers, such as Zubaba Knight's, go first), a target that leaves just ends the attack. While a card used in the Standby Phase is in a hand, on the field or in a GY (Aqua Spirit), the Standby Phase opens a response window too; Main Phase 1 follows once it closes (`then: main1`). The Damage Step's start opens a response window before damage calculation, in which only Counter Traps and effects made for the Damage Step (one that changes ATK or DEF, answers a Damage Step event, or has a `damage_calculation` or Damage Step `battling` condition) can be activated.

## Effect sheets

An effect's `when` (`When` in `engine/src/types.ts`) names the event it answers: `summoned` (with `how` and `from`), `attack_declared`, `attacked`, `destroyed_by_battle`, `battle_destroying` (the monster that destroyed it), `battle_damage`, `activated`, `destroyed_by_effect` (with `by`: whose effect), `damage_step_start` or `end_phase`. `self` limits it to this card, `filter` to cards that fit, and `canMiss` marks "When ... you can" triggers. Script targets with `event: true` pick the card the event is about, without asking (Trap Hole's summoned monster). Scripts gained `set_stats` ("ATK becomes"), `negate_attack`, and the conditions `phase` and `summoned_this_turn`.

## Not yet

- Negation and Counter Traps. Effects with `when.event === 'activated'` are never offered.
- Continuous effects (Banner of Courage, Blade Knight). Lingering restrictions that last past resolution are still only in the summary.
- Per-card default responses.
