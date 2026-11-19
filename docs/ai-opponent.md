# AI opponent

Status, 2026-11-19: step 1 of the build order (play against Claude) is built; contests, missing-move complaints and deck plans (steps 2 and 3) are not yet. Notes marked **Built** say where the code differs from the plan.

The admin can start a duel against Claude. Claude sits in a seat like any other player: it sees what that seat sees, picks one move at a time from the moves code already offers, answers the judge's questions, can contest a ruling, and says in the duel chat when it thinks a move should be possible but isn't offered. It is for the admin only, both to play against and as a playtester that finds rules bugs.

## Principles

- **The AI is a player, not a part of the engine.** It reaches the duel only through the same `Duels` methods the browser routes call (`watch`, `act`, `answer`, `contest`, `chat`), under its own seat key. Code checks its moves exactly as it checks a person's. Nothing in the engine or judge changes for it.
- **It can only see its own seat.** Its prompt is built from the `DuelUpdate`s `watch()` sends its seat (`PlayerView` and `LogEntry[]`), which already hide every card that seat can't see. The opponent module never imports `replay`, `DuelState` or the event log, and its prompt builder (`server/src/opponent/prompt.ts`) only takes those view types, so it can't leak hidden information even by mistake.
- **It never invents a move.** Code expands `legalActions` into a numbered list of complete moves, and the model answers with a number. An illegal or malformed move can't happen, so there's no retry loop for those.
- **One move per call.** Each call sees the board as it is now and returns one choice. A turn of five actions is five calls.

## Starting a duel

- The admin's home page gets a **Play against Claude** box, shown only to the admin (without an API key, starting a duel answers 503 with a message). The admin picks their own deck and the AI's deck (any premade deck).
- `POST /api/admin/duels/ai { deckId, aiDeckId }` (behind `requireAdmin`) creates the match and joins it at once through the existing `create` and `join` (`Duels.createAgainstAi`), with a `SeatClaim` that returns the key `ai:claude` and the name **Claude**. A seat key starting with `ai:` is how the server knows a seat is played by the AI (`isAiKey` in `viewer.ts`); the tests use `ai:a` and `ai:b` to have it play both seats.
- The duel then runs exactly like any other: same link, same stream, same log, same admin Full log.
- When a duel loads (`Duels.load`) and a seat's key starts with `ai:`, `Duels.onAiSeat` has `Opponents` (`server/src/opponent/opponent.ts`) attach an opponent to that seat. So after a restart, the AI picks up where it was, as soon as the duel is loaded again.

## The opponent loop

`server/src/opponent/` holds it, separate from `server/src/judge/`.

1. The opponent calls `duels.watch(id, seat, send)` and keeps the latest view, log and `judging`.
2. After each update it checks whether it has to decide anything. That's the case when the last view offers it actions, when `judging.prompt` is a question for it, or when there is a rollback offer it hasn't answered.
3. Some decisions are made by code with no model call:
   - **Rock-paper-scissors:** a random pick.
   - **Who goes first:** the deck plan says go first or second (default: go first).
   - **Rollback offers:** always accept. A rewind only follows an overturned ruling, so accepting is fair to both sides.
   - **Only one move offered** (usually `pass`): take it without asking the model.
4. Otherwise it makes one model call, gets a number back, and sends that move with `act` or `answer`.
5. **Stale answers.** Before it sends, it checks that the board is still what the call was based on (its view, the log length and `judging`; its own records don't count). If the board moved on while the model thought (the person acted, a window closed), it throws the answer away and decides again from the new view. After a move it waits for the board to change before deciding again, since an activation is accepted before the judge's work reaches the board.
6. **One call at a time per duel**, and at least 800 ms (`paceMs`) between its moves, so the board's animations can play and the person can follow along.
7. **Built: settling.** Code commits a chain's resolution and what follows one step at a time, so before a model call it waits a quarter of `paceMs` after the last change and gives up if the board changed meanwhile. Without this the live check made calls on boards that were about to change.

### Expanding the moves

Code turns each `LegalAction` into complete moves, each with a line of text for the prompt:

| Legal action | Becomes |
| --- | --- |
| `normalSummon` / `setMonster` | one move per set of tributes (`tributeFrom` choose `tributes`). The zone is the leftmost free one; zones don't matter for these decks. |
| `attack` | one move per target, plus a direct attack if allowed |
| `extraSummon` | one move per material set, in attack or defense position |
| `activate` | one move per effect, with its `text`; a card from the hand goes to the leftmost free zone |
| `setSpellTrap`, `flipSummon`, `changePosition`, `enterBattle`, `enterMain2`, `pass` | one move each |
| `endTurn` with `discard > 0` | **Built:** one move per set of cards to discard |
| `replace` (Gantetsu) | detach the first `count` materials, or let it be destroyed |
| `surrender` | not offered to the model |

Judge questions (`PromptView`) are answered the same way: the cards and choices are numbered, the model returns the numbers it picks, and code checks `min` and `max`.

## What the model sees

Each call sends the same prefix, so most of it comes from the prompt cache:

1. **System (cached, the same for every AI duel):** how to play Yu-Gi-Oh! on this site, what the answer format is, when to contest and when to complain (see below), and that it should play to win.
2. **Its deck (cached per deck):** its Main and Extra Deck list with every card's text, plus (step 3) a short game plan for the deck. The plan is a file in the repo, `server/opponent-plans/<deck slug>.md`, written once (Opus can draft it, Ethan reviews it). It says things like "Xyz Summon with two Level 4s", "keep Trap Hole for a monster of 1000 or more ATK" and "go first". The opponent's deck is a public premade, so its list goes in too, as it would for a person who looked it up.
3. **The duel log so far (cached up to the previous call):** every entry from `logFor` for its seat, one line each, the same text a person reads. The log only grows, so each call reuses the cache from the call before and pays full price only for the new lines. **Built:** each entry is its own content block, with the cache mark on the last one. The cache only finds a previous call's prefix at a block boundary, so one growing block would never hit.
4. **Now (not cached):** the board as its seat sees it, its last note to itself, (step 2) any new rulings it may contest (by `seq`), and the numbered moves.

**History.** The whole visible log is small (a long duel is a few hundred lines, around 5,000 to 10,000 tokens), so there's no summary to build or keep in sync. The full log is simplest and gives it everything a person would remember. The model also writes a one-sentence **note to self** with each answer ("they Set a card on turn 3 and didn't use it on my attack"), and the latest note goes into the next call. That covers what the log doesn't say: its own plans and reads.

A rewind (rolled back log) changes the start of the log once, so that call misses the cache; nothing else is needed.

### The answer

One structured output (strict JSON schema), with the fields in this order, so the model reasons before it commits (the same lesson as the judge's summary-before-verdict in PR #26). **Built:** step 1 has `reason`, `choice` (or `picks`) and `note`; `contest` and `missing` come with step 2. The numbers are plain `number`s in the schema, because structured outputs refuse the bounds Zod puts on an integer; code checks they are whole and in range.

```ts
{
  reason: string;        // a sentence or two: why this move
  choice: number;        // the move (or, for a question, `picks: number[]`)
  note: string;          // its note to self for the next call
  contest: { seq: number; why: string } | null;
  missing: string | null; // a move it expected but wasn't offered
}
```

## Model and cost

The default is **Claude Haiku 5.5 with thinking disabled at effort high** (Ethan's choice, 2026-11-19), like the judge: `reason` comes first in the answer, which gives it room to think in the open. The model is the env var `AI_OPPONENT_MODEL` (default `claude-haiku-5-5`), so a deeper test run only needs a restart with, say, `claude-sonnet-5-5`. Thinking and effort follow the model: Haiku runs with thinking disabled at effort high, and any other model runs with adaptive thinking. The server refuses to start if `pricing.ts` has no price for the model, so every duel's cost stays counted (it prices Haiku, Sonnet 5.5 and Opus). Each `aiDecided` record stores the model, so duels played on different models can be compared later.

Rough cost per call, assuming 12,000 tokens read from the cache, 4,000 new input tokens and 300 output tokens:

| Model | Per call | Per duel (about 200 calls) |
| --- | --- | --- |
| Haiku 5.5 | about $0.0008 | about $0.15 |
| Sonnet 5.5 | about $0.013 | about $2.50 |
| Opus 5.5 | about $0.026 | about $5 |

**Measured** (live check, 2026-11-19, Haiku playing both seats for 8 turns): 34 calls cost $0.012, about $0.00036 a call. Each read about 9,000 tokens from the cache and sent about 600 new input tokens and 220 output tokens, so a 200-call duel is about $0.07.

The 200 calls are a guess for a full duel. Code makes the trivial decisions, and the response floor already passes for it in every window where it holds nothing to activate, so most windows never reach the model. Contests run on the appeal model (Opus) and cost the same as a person's.

**Cache lifetime.** The default cache lasts 5 minutes. A person's turn can take longer, which costs one cache write when it's the AI's turn again. That's still cheap on Haiku. If the logs show many misses, use the 1-hour cache for the system and deck blocks.

**Records.** Each call is stored as an `aiDecided` event: the seat, the model, the token usage, the moves it was offered, its choice, its `reason` and `note`. Players' logs never show it (it's left out by `logFor` like `intent`), the admin Full log does, and the admin page's cost per duel counts it. The engine's `evolve` ignores it.

**Limits.** `AI_CALLS_PER_DUEL` (default 400). If the AI uses them all, it says so in chat and surrenders at its next move, so a duel never hangs on it. A judge question can't wait for a surrender (the duel is waiting on the answer), so at the limit it answers questions with the first options instead.

**Errors.** The Anthropic SDK retries an API error twice with backoff. If it still fails, or the answer doesn't fit the options, the AI takes a safe default (pass in a window, otherwise move to the next phase or end the turn) and says in chat once that it couldn't decide; the record keeps the error. Control characters are stripped from the model's text, since Postgres can't store a NUL in JSON (the live check hit one). A record that can't be stored is logged, and the duel goes on.

## Response windows and timing

- The server already passes for the AI after the response floor when it has nothing to activate, the same as for a person, so those windows cost no call.
- When it does hold a response, it gets one call, like a person thinking.
- If the model chooses to pass, the opponent waits until the response floor has gone by before sending it. Its pass then looks the same as an automatic pass, so the person can't tell from timing that it held something.
- It never has to rush: windows where it holds a response stay open until it acts, as for a person.

## Contesting rulings

- Each call lists the rulings (`judged` log entries) that arrived since its last call, by `seq`, with their summaries. If the model thinks one is wrong, it fills in `contest`, and the opponent calls `duels.contest` with `why` as the note. Everything after that (the appeal, the verdict in both logs, a rollback offer) is the existing flow.
- The AI may contest at most **3 rulings per duel**. They come out of the duel's 10 appeals, so it can never use up more than 3 of the person's.
- It can contest a ruling only on its first call after the ruling arrives, so a disagreement comes up once, not on every move.

## When a move seems missing

- If the model believes a move should be possible but it isn't in the list (for example "Trap Hole should be able to answer that Summon"), it fills in `missing`. The opponent posts that in the duel chat as an ordinary message, starting with "I expected to be able to: ", and the game goes on with the move it chose.
- Code drops a complaint it already made this turn, and allows at most 10 per duel, so the chat doesn't fill up.
- This is chat only, and it does **not** file a ruling report (Ethan, 2026-11-19). A report flags a card's scripts in every duel at once, and the AI will sometimes be wrong about the rules.
- Because chat is in the duel log, every complaint shows up in the admin Full log with the board around it.

## As a playtester

The AI plays every turn through the same code a person does, so it finds bugs for free:

- **Offered but refused.** If code ever refuses a move that `legalActions` offered (a 422 on `act`), that's an engine bug: the list and `decide` disagree. The opponent logs it as an error with the duel ID and the move, and posts in chat. It then decides again from the remaining moves. Other refusals (503 with no judge, 429 with the judge calls used up) just take the move off the list. The offline test (`server/test/opponent.test.ts`) plays whole duels between two AI seats with a model that picks at random and fails on any such refusal.
- **Missing moves** in chat, as above.
- **Contested rulings** go through the appeal, and an overturned scripted ruling already flags the script.
- **Its reasons** are in the admin Full log, so a strange move is easy to read back.

A later step could let the admin start a duel where Claude plays both seats, to run many duels unattended and collect these. The server already supports it (any two `ai:` seat keys, as the test does); only an admin button is missing.

## Build order

Each step works end to end on its own.

1. **Play against Claude** (built 2026-11-19). The admin entry point, the AI seat, the watch loop, move expansion, judge questions, code-made decisions, the model call and its answer, `aiDecided` records and cost, limits, errors, and the response-window timing. One generic plan for every deck. Offline tests use a fake model that picks at random and play whole duels through, which also tests the engine.
2. **Contests and missing moves.** The `contest` and `missing` fields, their limits and the chat messages.
3. **Deck plans and tuning.** A plan file per premade deck, and a small eval set of positions with a clear best move (lethal on board, don't attack into a face-up Mirror Force, use Trap Hole on the big Summon), run by hand like the judge evals.
