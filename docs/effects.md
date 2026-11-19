# Card effects and the judge (layer 2)

As of 2026-11-19. This is build layer 2 of [architecture.md](architecture.md): effect sheets, the runtime judge on Claude Haiku 5.5, `ask_player`, and a bare Contest that runs an appeal. Code still owns every generic rule; the judge only reads card text and changes the board through checked ops.

## What works

- **Activating** Normal and Quick-Play Spells (from the hand or Set), Normal Traps Set on an earlier turn, and the ignition and quick effects of face-up monsters, on your own turn. Code checks the phase, where the card is, a free zone and once-per-turn use. A card's own conditions are checked by code when its effect has a script, and by the judge otherwise (see [Scripts](#scripts-rulings-in-code)).
- **Resolving** right after activation. Nobody can respond yet (layer 4), so the chain holds at most one link and everyone waits until it resolves.
- **Choices** through `ask_player`: costs such as "discard 1 card", targets, searches, and choices between effects.
- **Stat changes** with an end: until end of turn, end of the Battle Phase, your next Standby Phase, or while on the field. Battle uses the changed ATK and DEF.
- **Contest** on any ruling a player can see: Claude Opus 5.5 (thinking on) re-examines it and its verdict and one- or two-sentence explanation join both logs. If it overturns a ruling that changed the board, both players are offered a rewind to just before it (see step 7 in [roadmap.md](roadmap.md)).

Not yet, by design of the build order:

- Flip effects, continuous effects and lingering restrictions. Continuous, Equip and Field Spells, Continuous Traps, and Spells/Traps that stay on the field (Swords of Revealing Light) aren't offered for activation.
- Negation and Counter Traps. Triggers, chains and responses to summons and attacks work: see [chains.md](chains.md).
- Counters, Xyz materials and negation: no ops for them yet. An effect that needs one does the parts it can, and its summary says what it skipped.

## Effect sheets

Each card with an effect has a sheet: per effect its kind (activation, ignition, trigger, quick, continuous, flip, condition), spell speed, whether a trigger is mandatory, its once-per-turn clause, window, cost, effect, targets, what it answers (`when`) and its script, its status, plus an Extra Deck monster's materials as data (`Materials`: the Tuner and non-Tuners of a Synchro Monster, the Level and count of an Xyz Monster's), which code uses to offer and check its Summon. Code reads the kind, the once-per-turn clause, `when`, the script and its status; the judge reads the rest next to the full card text. The spell speed follows from the kind and the card type, so the compiler sets it, not the model.

Sheets are data in Postgres (`effect_sheets`), so players' reports and the admin can change them without a deploy. Every version is kept in `sheet_revisions` with why it changed ("compiled", "imported", a report, an appeal, or the admin's note). `server/effect-sheets/*.json` is the seed and backup: the card sync (at every server start, then daily) imports any sheet the database lacks or holds in an older format (one that no longer fits the current schema, such as a sheet from before `when` existed; such a sheet is never played), `npm run sheets:import -- --force` overwrites the database from the files, and `npm run sheets:export` writes the database back to them. While in development, `RESET_SHEETS=true` deletes every stored sheet, revision and report at each server start, so the deploy plays exactly the repository's sheets; duels keep the sheets they started with in their logs. A duel copies its cards' sheets into its first event, and a later change joins the log as a `sheetUpdated` event that players never see, so replays never depend on the database. A running duel gets the change at once; one that wasn't loaded gets it when it next loads. Finished duels keep the sheets they were played with.

- Each sheet carries the sha256 of the card text it was made from. If errata changes the text, the sheet is ignored (the card acts as if it had no effects) until it is recompiled.
- `npm run sheets:compile` writes a sheet for every premade-deck card with an effect that has none or whose text changed, using Claude Opus 5.5 with thinking through the Message Batches API (half price; it waits for the batch, usually minutes). `-- --force` recompiles all of them, and card names after it only those (`-- --force "Twister" "Fissure"`). It needs `ANTHROPIC_API_KEY` and `DATABASE_URL`, and writes to the database (export afterwards to update the files). A full recompile of the 69 sheets costs about $3, and the run prints its cost.
- Each effect's `status` is `unverified` (as compiled), `verified` (a person checked it) or `flagged` (its script is set aside, so the judge rules on it). A sheet with any verified effect is never recompiled.

The current 69 sheets for the two starter decks were compiled by Opus on 2026-11-19 and are unverified; they match today's card text.
- A sheet is named by the card's passcode. YGOPRODeck sometimes changes which artwork's passcode is a card's main ID (in November 2026 it did for Mystic Tomato and Number 39: Utopia). The old sheet is then never found and the card acts as if it had no effects, so rename the sheet and its `code` to the new passcode; the offline tests catch this once the fixture in `server/test/fixtures/` is refreshed.

## Scripts: rulings in code

Most effects are fixed: what The Warrior Returning Alive needs ("a Warrior monster in your GY") and what it does ("add that target to your hand") never depend on judgement. Such an effect's sheet entry carries a `script`, structured data that code runs exactly, and the judge never sees it. The types are `Script`, `Step`, `Selection` and `CardFilter` in `engine/src/types.ts`; the checks are in `engine/src/script.ts` and the runner in `server/src/judge/script.ts`.

- **Activation** is checked by code: the script's conditions (a count of cards that fit a filter, or "before your Battle Phase"), that the cost can be paid, that there are enough targets, and that every step the effect must do has cards to do it to ("Special Summon 1 ... from your Deck" needs a match there and a free zone). Legality is judged before the cost, so a card the cost would use can't count as a target. An activation that fails isn't offered to the player at all; if a client sends it anyway, it is refused with the reason. So a scripted card never shows a move that gets declined.
- **Paying and choosing.** Code pays the cost and asks the player every choice the card gives them (the card to discard, the targets, the effect to use, a Special Summon's position, a tie for lowest ATK), with the same questions the judge asks.
- **Resolving** runs the steps as ops: destroy, move (to hand, GY, banished or Deck), Special Summon, modify stats, change LP, draw, one more Normal Summon. A target that no longer fits the filter is left alone. A part the steps can't express yet, such as a lingering "you cannot conduct your Battle Phase this turn", is named in `unapplied` and said in the summary.
- **Records.** Each stage is logged as a `judged` event with the model `script`, the questions and answers as its transcript and no token usage, so it can be contested like any ruling. It doesn't count against the duel's judge calls, needs no API key, and costs nothing. An appeal on a scripted ruling is told the script made it, so an overturn names what the script got wrong.
- **Timing.** Each effect's `when` names the event a trigger or response answers. Code offers the effect only in a matching window and runs the chain itself ([chains.md](chains.md)); the judge is told the event and never rules on timing.

Opus writes the scripts when it compiles a sheet, only where the whole effect fits the vocabulary; anything else gets `script: null` and the judge. Structured outputs can't hold the script schema (too many unions), so the model returns each script as JSON text and the compiler checks it with the same Zod schema; a script that doesn't check is dropped with a log line, leaving that effect to the judge.

## Continuous effects

An always-on effect can't be a judge call, so a `continuous` sheet entry carries `continuous`: data that code applies whenever its card is face-up on the field (`Continuous` in `engine/src/types.ts`, applied in `engine/src/continuous.ts`). Nothing is stored. Every read of a monster's stats (`statsOf`, `levelNow`) derives what is in force from the board as it is, so an effect stops the moment its card leaves or its `while` conditions fail, and it can't go stale. A Spell or Trap applies only once its activation has resolved. The vocabulary has three kinds. `stats`: the cards in `to` (`self`, or face-up monsters that fit a filter) gain ATK/DEF, optionally once per card that fits `per` or per Xyz Material, and their Level changes or becomes a number. `restrict`: the cards in `to` can't attack, change position, be targeted for an attack, or be destroyed by battle (optionally only by a monster that fits `by`); `others` leaves the card itself out ("except this one"). `self_destruct`: a Normal Spell/Trap that remains on the field after it resolves and is destroyed in the End Phase of its controller's opponent's nth turn after activation (`FieldCard.activatedTurn`). Equip Spells and Continuous Traps that work through a monster are linked to it by the script step and op `link` as they resolve (`FieldCard.linked`); `to: 'linked'` then applies their effect to that monster. A linked card is always destroyed when its monster leaves the field, one that resolves without a link goes to the GY, and a fourth kind, `tie`, adds "when this card leaves the field, destroy that monster" (`destroyLinked`) and "if it is changed to Defense Position, destroy both" (`defenseBreaks`). A step on `targets` still reaches a target an earlier step of the same effect Special Summoned ("Special Summon it, and if you do, equip this card to it"). A restriction left by a resolved effect for the rest of the turn ("your opponent cannot declare an attack this turn") is the script step and op `forbid`, kept in `DuelState.forbidden`. A `replace_destruction` continuous effect ("you can detach 1 Xyz Material from this card instead") asks its controller whenever the card would be destroyed. Counters live on the card (`FieldCard.counters`), placed and removed by the steps `add_counters` and `remove_counters`. Negation is a set of script steps: `negate_activation` (the effect answers an `activated` event, the chain's last link, and that link then resolves doing nothing), `negate_effects` (a face-up monster's effects stop while it stays face-up: no continuous effects, triggers, ignition or quick effects) and `set_again` (the resolving Spell/Trap is Set again instead of going to the GY). Conditions are the script conditions plus `turn` ("during your turn") and `position` ("while in face-up Defense Position"). Level is worked out apart from ATK and DEF, so an effect that counts monsters of a Level (Tenshin) never needs its own ATK. Opus writes `continuous` when it compiles a sheet, as JSON text checked like scripts; a continuous effect without it does nothing.

## Reports: when a script is wrong

A player who thinks a card is ruled wrongly pins the card's details (right-click or Shift) and uses **Report a ruling problem**, saying what the game did and what it should have done (`POST /api/duels/:id/report`; up to 5 per player per duel, only for cards they can see). An appeal that overturns a scripted ruling does the same on its own, with the appeal's `ruling` as the note. Either way, at once and in every duel:

- the report is stored in `sheet_reports` with the duel and its event count, so the board it was made on can be replayed from the log;
- every script on the card is flagged, so code stops ruling on it and the judge reads the card instead (the activation may now be offered where the script refused it).

Any player's report flags the card, without review: this is a small private site, and the cost of a wrong report is only some judge calls. The admin page's **Rulings** section lists every card with open reports or flagged scripts, with its text, the reports and a link to the duel log. There the admin edits the sheet as JSON (fix a script, **Restore scripts** to unflag them, or **Mark scripts verified** after checking them), saves it with a note, and closes the reports (`GET /api/admin/rulings`, `POST /api/admin/sheets/:code`, `POST /api/admin/reports/:id/resolve`). A saved sheet must match the card's current text; it reaches running duels at once. Add an eval case for the situation whenever a script was really wrong.

## The judge

`server/src/judge/` holds the judge loop, its tools, the rules reference and the appeal.

Two calls per activation:

1. **Checking the activation.** The card is already where activation puts it (on a scratch copy of the board). The judge decides whether the activation is legal now, pays the cost with ops, asks the player for costs and targets, and records targets with `declare_targets`. If it rules the activation illegal, nothing happens: the card stays where it was, and the opponent sees nothing.
2. **Resolving.** The judge applies the effect with ops, asking players where the text gives them a choice, then the card goes to the GY if it is a Normal or Quick-Play Spell or a Normal Trap.

Each call is a tool loop: one tool per op (`move`, `special_summon`, `destroy`, `change_lp`, `modify_stats`, `change_position`, `draw`, `extra_normal_summon`, `negate_attack`, `detach`, `declare_targets`, `choose_effect`), plus `ask_player` and `finish`. The engine checks every op against the scratch board (`engine/src/ops.ts`); a refused op goes back to the model as an error it can fix. Code also refuses to let the judge rule an activation legal before it has paid the cost or declared the targets the effect sheet lists, and refuses an `ask_player` question with only one choice. On activation, targets must be cards the player picked through `ask_player`; a card can't target itself, a card used to pay the cost can't be picked or targeted, a target described as face-up can't be face-down, an effect with no targets declares none, and an effect with no cost or targets asks for no cards (its choices come on resolution). A face-down card on the field can be offered to a player who can't see it: the prompt shows it face-down, with a one-off key instead of its ID. Nothing reaches the duel until `finish`. A call that errors or doesn't finish within 16 turns fails safe: the activation is refused, or the effect does nothing, with a log line saying the judge couldn't rule.

Model settings: `claude-haiku-5-5`, thinking disabled with effort `high` (the "reasoning off" setting), strict tools so every call parses, a forced tool call each turn, and the rules reference cached. Appeals use `claude-opus-5-5` with adaptive thinking and a JSON schema for the verdict.

**Hidden information.** The judge sees everything. Text shown to players (summaries, `ask_player` questions, appeal explanations) is refused if it names a card a player can't see, and `ask_player` may only offer cards the asked player can see, or cards in their own Deck. A card moved between places the opponent can't see (Deck to hand) is logged without its identity. Deck orders after a shuffle are never sent.

**A refused activation isn't judged twice on the same board.** Once the judge rules an activation illegal, code refuses that card's effect for that player without a model call, and the board stops offering it, until any event changes the board: a draw, a summon, a phase change, a cost paid, anything but another refused activation or an upheld appeal. The rulings live in the duel state (`ruledIllegal`), so they are rebuilt from the log on a restart. Because any change counts, the key holds every hidden detail the judge sees (hands, Deck order), and nothing the player isn't shown changes the board without an event. A judge call that failed isn't a ruling, so the player may try again; an appeal that overturns a ruling lifts it too.

**An overturned refusal binds.** When an appeal overturns the judge's refusal of an activation, and nothing on the board has changed since, the next try of that activation gives the judge the appeal's ruling, and code refuses to let it rule the activation illegal again. Any change to the board ends this, as it ends a standing refusal.

**Every decision is stored** as a `judged` event with the model, the prompt version (a hash of the rules reference and tools), a hash of the board it saw, the whole transcript, the ops, the summary, and the tokens each API call used. Players see only the stage, outcome and summary.

**Cost.** Judge and appeal records keep each API call's token counts (input, cache writes, cache reads, output). `server/src/judge/pricing.ts` is the one place that holds Anthropic's prices and turns tokens into dollars, so updating a price there reprices past duels too; the eval runner uses it as well. The admin page's duel list shows each duel's judge calls, appeals and estimated cost, and the total spent across every duel; a duel's full log states its cost in the header. An appeal that fails (an API error, a refusal, an unreadable verdict) stores nothing, so its tokens aren't counted.

**Limits.** Each duel may use 300 judge calls (an activation and its resolution are two) and 10 appeals; set `JUDGE_CALLS_PER_DUEL` and `APPEALS_PER_DUEL` to change them. Scripted rulings count toward neither. Without `ANTHROPIC_API_KEY` the server runs, scripted effects work, and activating any other effect answers 503.

**If the server restarts** while the judge works, nothing it did was committed: an activation being checked simply never happened, and an activated effect that hadn't resolved is resolved again when the duel is next loaded.

## API for the board

Everything a player sees comes over the duel's event stream as before; the shapes are in `engine/src/types.ts`.

- `LegalAction` `{ type: 'activate', card, effect, zones, text }`: `effect` indexes the card's sheet, `zones` lists the Spell & Trap Zones a card from the hand may go to (null otherwise), `text` is the effect's wording for the menu.
- `Intent` `{ type: 'activate', card, effect, zone }` to `POST /api/duels/:id/intents`. It answers 204 once code accepts it; the judge's work follows on the stream. 422 means code refused it, including an activation already ruled illegal on this board (the error quotes the ruling); 503 means no API key; 429 that the duel's judge calls are used up.
- A `judged` ruling made by a script has the model `script` in the stored record; players see it like any other ruling.
- `DuelUpdate` `{ type: 'judging', judging }` whenever the judge starts, asks, gets an answer or finishes (null), and `sync` carries `judging` too. `JudgingView` has the stage, the activating player, the card (hidden from the opponent while a card from the hand is being checked), `waitingOn` (who must answer, or null while the model works) and `prompt` (only for the player asked).
- `PromptView` `{ id, text, cards: [{ id, card, place }], choices, min, max }`. Answer with `POST /api/duels/:id/answer` `{ prompt, picks }`, picking card IDs or choices; 422 if the picks don't fit, 409 if the question has closed.
- New log events: `judged` (a ruling: `stage`, `player`, `card` or null, `legal`, `summary`, `failed`), `effectActivated`, `targeted`, `moved` (card null when the player can't see it), `specialSummoned`, `destroyed`, `lpChanged`, `statsModified`, `normalSummonGranted`, `effectChosen` (`choice`, the effect picked when a card offers several), `linkResolved` (no text) and `appealed` (`judged`, `by`, `verdict`, `explanation`).
- Contest a ruling with `POST /api/duels/:id/contest` `{ seq, note }`, where `seq` is the `judged` entry's `seq`. It answers 202; the verdict arrives as an `appealed` entry. Each player may contest each ruling once.
- `PlayerView.chain` lists effects waiting to resolve (with `targets` and `choice`), and face-up monsters' `FieldCardView.stats` carries current ATK, DEF and Level.

The board's side of this is duel UI step 3 (see [duel-ui.md](duel-ui.md)).

## The eval suite

`server/src/judge/evals.ts` holds hand-written cases: a board, what happens first (`before`, such as an attack or an activation to answer), the card to activate (and which of its effects), the picks to make, whether the activation is legal, and a check of the board after. They cover every effect of the two starter decks that can be activated in this layer: costs (discard, pay LP, tribute), targets in the GY and on the field, searches from the Deck, choices between effects, ties the player breaks, stat and Level changes, and activations that must be refused (missing targets or costs, no Synchro Monster, no Xyz Material or Spell Counter, Traps that need an attack, a summon or an Xyz Summon, a Battle Phase effect in the Main Phase).

The test suite runs every case whose effect has a script (or a `when`) offline, since code rules on those without a model, so a wrong script fails CI. For the rest it builds the board and checks that code offers the activation. It also checks every effect sheet's spell speed against its kind and card type. The live run calls the model only for the cases the judge handles.

The suite isn't run in GitHub Actions; the API key stays out of GitHub. Run it by hand before deploying a change to the judge, the effect sheets or the engine's ops and activation rules (in production, `docker compose exec app node server/src/judge/evals.ts`). A single pass costs about $0.06.

### Running it

`npm run judge:eval` needs `ANTHROPIC_API_KEY` and a database with the cards imported (`npm run db:migrate`, then `npm run cards:import`).

- `npm run judge:eval -- <text>` runs only the cases whose name contains the text.
- `npm run judge:eval -- --repeat 5` runs every case 5 times and prints each case's pass rate (`3/5`). The judge runs with reasoning off and the model doesn't take a temperature, so its rulings vary from run to run; one pass proves little, and one failure may be a fluke.
- Each run writes `server/eval-runs/<time>/` (ignored by git): `summary.json` with the prompt version, each case's pass rate, the tokens used and the cost, and one JSON file per failed attempt holding the whole transcript of every judge call it made.

In a Claude Code cloud session, the key comes from an environment variable named `JUDGE_ANTHROPIC_API_KEY` (the cloud host removes `ANTHROPIC_API_KEY` from commands), so run `ANTHROPIC_API_KEY=$JUDGE_ANTHROPIC_API_KEY npm run judge:eval`. Postgres runs there without Docker: `initdb` and `pg_ctl` from `/usr/lib/postgresql/16/bin`, as the `postgres` user, with a data directory under `/var/tmp`.

### The iteration loop

1. **Baseline.** Run `--repeat 5` on the current code and keep its summary. Any case below 5/5 is a candidate.
2. **Read the transcripts** of the failed attempts, not just the one-line detail: what the judge saw, which tools it called, which calls code refused and what it said in the summary.
3. **Fix the cause where it belongs:**
   - The judge broke a rule that code can check (finished without paying a cost, asked a pointless question, named a hidden card): make code refuse it in `judge.ts`, with an error the model can act on. Checks in code hold on every run; prompt wording only shifts the odds.
   - The mistake is about one card (wrong cost, targets, window or spell speed): fix its effect sheet.
   - It's a general rule the judge keeps missing: add a short line to the rules reference in `prompt.ts`, ideally naming a card as the example.
   - The case itself is wrong (a ruling we got wrong, or the harness mis-reading a fair answer): fix the case, and check the official ruling first.
4. **Re-run** the affected cases with `--repeat 5`, then the whole suite with `--repeat 3` so a fix for one card doesn't break another. Compare with the baseline's summary.
5. **Add a case** for every mistake worth fixing, and one for each tricky ruling we meet, so it stays fixed.

Keep spend small: target the cases you're working on with a filter, and save full-suite repeats for the end of a round. Five runs of the whole suite cost about $0.30.
