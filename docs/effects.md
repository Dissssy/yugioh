# Card effects and the judge (layer 2)

As of 2026-11-19. This is build layer 2 of [architecture.md](architecture.md): effect sheets, the runtime judge on Claude Haiku 5.5, `ask_player`, and a bare Contest that runs an appeal. Code still owns every generic rule; the judge only reads card text and changes the board through checked ops.

## What works

- **Activating** Normal and Quick-Play Spells (from the hand or Set), Normal Traps Set on an earlier turn, and the ignition and quick effects of face-up monsters, on your own turn. Code checks the phase, where the card is, a free zone and once-per-turn use; the judge checks the card's own conditions.
- **Resolving** right after activation. Nobody can respond yet (layer 4), so the chain holds at most one link and everyone waits until it resolves.
- **Choices** through `ask_player`: costs such as "discard 1 card", targets, searches, and choices between effects.
- **Stat changes** with an end: until end of turn, end of the Battle Phase, your next Standby Phase, or while on the field. Battle uses the changed ATK and DEF.
- **Contest** on any ruling a player can see: Claude Opus 5.5 (thinking on) re-examines it and its verdict and one- or two-sentence explanation join both logs. There is no rollback yet (layer 6).

Not yet, by design of the build order:

- Triggers ("when this card is Normal Summoned"), Flip effects, continuous effects and lingering restrictions (layer 5). Continuous, Equip and Field Spells, Continuous Traps, and Spells/Traps that stay on the field (Swords of Revealing Light) aren't offered for activation.
- Responses, chains, Counter Traps and anything that reacts to an attack or activation (layer 4). The judge rules those activations illegal: their moment has passed.
- Counters, Xyz materials and negation: no ops for them yet. An effect that needs one does the parts it can, and its summary says what it skipped.

## Effect sheets

Each card with an effect has a sheet in `server/effect-sheets/<passcode>.json`: per effect its kind (activation, ignition, trigger, quick, continuous, flip, condition), spell speed, whether a trigger is mandatory, its once-per-turn clause, window, cost, effect and targets, plus Extra Deck materials. Code reads the kind and the once-per-turn clause; the judge reads the rest next to the full card text.

Sheets are files in the repository rather than database rows, so a change to one is reviewed in a pull request like code. A duel copies its cards' sheets into its first event, so replays never depend on later edits.

- Each sheet carries the sha256 of the card text it was made from. If errata changes the text, the sheet is ignored (the card acts as if it had no effects) until it is recompiled.
- `npm run sheets:compile` writes a sheet for every premade-deck card with an effect that has none or whose text changed, using Claude Opus 5.5 with thinking through the Message Batches API (half price; it waits for the batch, usually minutes). `-- --force` recompiles all of them. It needs `ANTHROPIC_API_KEY` and `DATABASE_URL`.
- A sheet with `"verified": true` has been checked by a person and is never overwritten.

The current 69 sheets for the two starter decks were written by hand in the coding session that built this layer and are unverified; they match today's card text.
- A sheet is named by the card's passcode. YGOPRODeck sometimes changes which artwork's passcode is a card's main ID (in November 2026 it did for Mystic Tomato and Number 39: Utopia). The old sheet is then never found and the card acts as if it had no effects, so rename the sheet and its `code` to the new passcode; the offline tests catch this once the fixture in `server/test/fixtures/` is refreshed.

## The judge

`server/src/judge/` holds the judge loop, its tools, the rules reference and the appeal.

Two calls per activation:

1. **Checking the activation.** The card is already where activation puts it (on a scratch copy of the board). The judge decides whether the activation is legal now, pays the cost with ops, asks the player for costs and targets, and records targets with `declare_targets`. If it rules the activation illegal, nothing happens: the card stays where it was, and the opponent sees nothing.
2. **Resolving.** The judge applies the effect with ops, asking players where the text gives them a choice, then the card goes to the GY if it is a Normal or Quick-Play Spell or a Normal Trap.

Each call is a tool loop: one tool per op (`move`, `special_summon`, `destroy`, `change_lp`, `modify_stats`, `change_position`, `draw`, `extra_normal_summon`, `declare_targets`, `choose_effect`), plus `ask_player` and `finish`. The engine checks every op against the scratch board (`engine/src/ops.ts`); a refused op goes back to the model as an error it can fix. Code also refuses to let the judge rule an activation legal before it has paid the cost or declared the targets the effect sheet lists, and refuses an `ask_player` question with only one choice. Nothing reaches the duel until `finish`. A call that errors or doesn't finish within 16 turns fails safe: the activation is refused, or the effect does nothing, with a log line saying the judge couldn't rule.

Model settings: `claude-haiku-5-5`, thinking disabled with effort `high` (the "reasoning off" setting), strict tools so every call parses, a forced tool call each turn, and the rules reference cached. Appeals use `claude-opus-5-5` with adaptive thinking and a JSON schema for the verdict.

**Hidden information.** The judge sees everything. Text shown to players (summaries, `ask_player` questions, appeal explanations) is refused if it names a card a player can't see, and `ask_player` may only offer cards the asked player can see, or cards in their own Deck. A card moved between places the opponent can't see (Deck to hand) is logged without its identity. Deck orders after a shuffle are never sent.

**Every decision is stored** as a `judged` event with the model, the prompt version (a hash of the rules reference and tools), a hash of the board it saw, the whole transcript, the ops, the summary, and the tokens each API call used. Players see only the stage, outcome and summary.

**Cost.** Judge and appeal records keep each API call's token counts (input, cache writes, cache reads, output). `server/src/judge/pricing.ts` is the one place that holds Anthropic's prices and turns tokens into dollars, so updating a price there reprices past duels too; the eval runner uses it as well. The admin page lists every duel that used the judge with its judge calls, appeals and estimated cost, and the total across them. An appeal that fails (an API error, a refusal, an unreadable verdict) stores nothing, so its tokens aren't counted.

**Limits.** Each duel may use 300 judge calls (an activation and its resolution are two) and 10 appeals; set `JUDGE_CALLS_PER_DUEL` and `APPEALS_PER_DUEL` to change them. Without `ANTHROPIC_API_KEY` the server runs, and activating an effect answers 503.

**If the server restarts** while the judge works, nothing it did was committed: an activation being checked simply never happened, and an activated effect that hadn't resolved is resolved again when the duel is next loaded.

## API for the board

Everything a player sees comes over the duel's event stream as before; the shapes are in `engine/src/types.ts`.

- `LegalAction` `{ type: 'activate', card, effect, zones, text }`: `effect` indexes the card's sheet, `zones` lists the Spell & Trap Zones a card from the hand may go to (null otherwise), `text` is the effect's wording for the menu.
- `Intent` `{ type: 'activate', card, effect, zone }` to `POST /api/duels/:id/intents`. It answers 204 once code accepts it; the judge's work follows on the stream. 503 means no API key; 429 that the duel's judge calls are used up.
- `DuelUpdate` `{ type: 'judging', judging }` whenever the judge starts, asks, gets an answer or finishes (null), and `sync` carries `judging` too. `JudgingView` has the stage, the activating player, the card (hidden from the opponent while a card from the hand is being checked), `waitingOn` (who must answer, or null while the model works) and `prompt` (only for the player asked).
- `PromptView` `{ id, text, cards: [{ id, card, place }], choices, min, max }`. Answer with `POST /api/duels/:id/answer` `{ prompt, picks }`, picking card IDs or choices; 422 if the picks don't fit, 409 if the question has closed.
- New log events: `judged` (a ruling: `stage`, `player`, `card` or null, `legal`, `summary`, `failed`), `effectActivated`, `targeted`, `moved` (card null when the player can't see it), `specialSummoned`, `destroyed`, `lpChanged`, `statsModified`, `normalSummonGranted`, `effectChosen` (`choice`, the effect picked when a card offers several), `linkResolved` (no text) and `appealed` (`judged`, `by`, `verdict`, `explanation`).
- Contest a ruling with `POST /api/duels/:id/contest` `{ seq, note }`, where `seq` is the `judged` entry's `seq`. It answers 202; the verdict arrives as an `appealed` entry. Each player may contest each ruling once.
- `PlayerView.chain` lists effects waiting to resolve (with `targets` and `choice`), and face-up monsters' `FieldCardView.stats` carries current ATK, DEF and Level.

The board's side of this is duel UI step 3 (see [duel-ui.md](duel-ui.md)).

## The eval suite

`server/src/judge/evals.ts` holds 47 hand-written cases: a board, the card to activate (and which of its effects), the picks to make, whether the activation is legal, and a check of the board after. They cover every effect of the two starter decks that can be activated in this layer: costs (discard, pay LP, tribute), targets in the GY and on the field, searches from the Deck, choices between effects, ties the player breaks, stat and Level changes, and activations that must be refused (missing targets or costs, no Synchro Monster, no Xyz Material or Spell Counter, Traps that need an attack, a summon or an Xyz Summon, a Battle Phase effect in the Main Phase).

The test suite builds every case's board offline and checks that code offers the activation, so a broken case fails CI without a model call. It also checks every effect sheet's spell speed against its kind and card type.

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
