# AI opponent (plan)

Status: plan only, 2026-11-19. Nothing here is built yet.

The admin can start a duel against Claude. Claude sits in a seat like any other player: it sees what that seat sees, picks one move at a time from the moves code already offers, answers the judge's questions, can contest a ruling, and says in the duel chat when it thinks a move should be possible but isn't offered. It is for the admin only, both to play against and as a playtester that finds rules bugs.

## Principles

- **The AI is a player, not a part of the engine.** It reaches the duel only through the same `Duels` methods the browser routes call (`watch`, `act`, `answer`, `contest`, `chat`), under its own seat key. Code checks its moves exactly as it checks a person's. Nothing in the engine or judge changes for it.
- **It can only see its own seat.** Its prompt is built from the `DuelUpdate`s `watch()` sends its seat (`PlayerView` and `LogEntry[]`), which already hide every card that seat can't see. The opponent module never imports `replay`, `DuelState` or the event log, so it can't leak hidden information even by mistake. A test checks that its prompt builder only accepts those view types.
- **It never invents a move.** Code expands `legalActions` into a numbered list of complete moves, and the model answers with a number. An illegal or malformed move can't happen, so there's no retry loop for those.
- **One move per call.** Each call sees the board as it is now and returns one choice. A turn of five actions is five calls.

## Starting a duel

- The admin's new-duel form gets a **Play against Claude** button, shown only to the admin and only when the server has an Anthropic API key. The admin picks their own deck and the AI's deck (any premade deck).
- `POST /api/admin/duels/ai { deck, aiDeck }` (behind `requireAdmin`) creates the match and joins it at once through the existing `create` and `join`, with a `SeatClaim` that returns the key `ai` and the name **Claude**. A seat key starting with `ai` is how the server knows a seat is played by the AI.
- The duel then runs exactly like any other: same link, same stream, same log, same admin Full log.
- When a duel loads (`Duels.load`) and one seat's key is `ai`, the server attaches an opponent to that seat. So after a restart, the AI picks up where it was, as soon as the duel is loaded again.

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
5. **Stale answers.** Before it sends, it checks that the log length is still what the call was based on. If the board moved on while the model thought (the person acted, a window closed), it throws the answer away and decides again from the new view.
6. **One call at a time per duel**, and at least about 800 ms between its moves, so the board's animations can play and the person can follow along.

### Expanding the moves

Code turns each `LegalAction` into complete moves, each with a line of text for the prompt:

| Legal action | Becomes |
| --- | --- |
| `normalSummon` / `setMonster` | one move per set of tributes (`tributeFrom` choose `tributes`). The zone is the leftmost free one; zones don't matter for these decks. |
| `attack` | one move per target, plus a direct attack if allowed |
| `extraSummon` | one move per material set, in attack or defense position |
| `activate` | one move per effect, with its `text`; a card from the hand goes to the leftmost free zone |
| `setSpellTrap`, `flipSummon`, `changePosition`, `enterBattle`, `enterMain2`, `pass` | one move each |
| `endTurn` with `discard > 0` | a follow-up question: pick the cards to discard |
| `replace` (Gantetsu) | detach the first `count` materials, or let it be destroyed |
| `surrender` | not offered to the model |

Judge questions (`PromptView`) are answered the same way: the cards and choices are numbered, the model returns the numbers it picks, and code checks `min` and `max`.

## What the model sees

Each call sends the same prefix, so most of it comes from the prompt cache:

1. **System (cached, the same for every AI duel):** how to play Yu-Gi-Oh! on this site, what the answer format is, when to contest and when to complain (see below), and that it should play to win.
2. **Its deck (cached per deck):** its Main and Extra Deck list with every card's text, plus a short game plan for the deck. The plan is a file in the repo, `server/opponent-plans/<deck slug>.md`, written once (Opus can draft it, Ethan reviews it). It says things like "Xyz Summon with two Level 4s", "keep Trap Hole for a monster of 1000 or more ATK" and "go first". The opponent's deck is a public premade, so its list goes in too, as it would for a person who looked it up.
3. **The duel log so far (cached up to the previous call):** every entry from `logFor` for its seat, one line each, the same text a person reads. The log only grows, so each call reuses the cache from the call before and pays full price only for the new lines.
4. **Now (not cached):** the board as its seat sees it, its last note to itself, any new rulings it may contest (by `seq`), and the numbered moves.

**History.** The whole visible log is small (a long duel is a few hundred lines, around 5,000 to 10,000 tokens), so there's no summary to build or keep in sync. The full log is simplest and gives it everything a person would remember. The model also writes a one-sentence **note to self** with each answer ("they Set a card on turn 3 and didn't use it on my attack"), and the latest note goes into the next call. That covers what the log doesn't say: its own plans and reads.

A rewind (rolled back log) changes the start of the log once, so that call misses the cache; nothing else is needed.

### The answer

One structured output (strict JSON schema), with the fields in this order, so the model reasons before it commits (the same lesson as the judge's summary-before-verdict in PR #26):

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

The default is **Claude Haiku 5.5 with thinking disabled at effort high** (Ethan's choice, 2026-11-19), like the judge: `reason` comes first in the answer, which gives it room to think in the open. `AI_OPPONENT_MODEL` sets the model, and `pricing.ts` already prices Haiku and Opus (add Sonnet if it's used).

Rough cost per call, assuming 12,000 tokens read from the cache, 4,000 new input tokens and 300 output tokens:

| Model | Per call | Per duel (about 200 calls) |
| --- | --- | --- |
| Haiku 5.5 | about $0.0008 | about $0.15 |
| Sonnet 5.5 | about $0.013 | about $2.50 |
| Opus 5.5 | about $0.026 | about $5 |

The 200 calls are a guess for a full duel. Code makes the trivial decisions, and the response floor already passes for it in every window where it holds nothing to activate, so most windows never reach the model. Contests run on the appeal model (Opus) and cost the same as a person's.

**Cache lifetime.** The default cache lasts 5 minutes. A person's turn can take longer, which costs one cache write when it's the AI's turn again. That's still cheap on Haiku. If the logs show many misses, use the 1-hour cache for the system and deck blocks.

**Records.** Each call is stored as an `aiDecided` event: the seat, the model, the token usage, the moves it was offered, its choice, its `reason` and `note`. Players' logs never show it (it's left out by `logFor` like `intent`), the admin Full log does, and the admin page's cost per duel counts it. The engine's `evolve` ignores it.

**Limits.** `AI_CALLS_PER_DUEL` (default 400). If the AI uses them all, it says so in chat and surrenders, so a duel never hangs on it.

**Errors.** An API error is retried twice with backoff. If it still fails, the AI takes a safe default (pass in a window, otherwise move to the next phase or end the turn) and says in chat that it couldn't think.

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
- By default this is chat only, and it does **not** file a ruling report. A report flags a card's scripts in every duel at once, and the AI will sometimes be wrong about the rules (see Open questions).
- Because chat is in the duel log, every complaint shows up in the admin Full log with the board around it.

## As a playtester

The AI plays every turn through the same code a person does, so it finds bugs for free:

- **Offered but refused.** If code ever refuses a move that `legalActions` offered (a 422 on `act`), that's an engine bug: the list and `decide` disagree. The opponent logs it as an error with the duel ID and `seq`, and posts in chat. It then decides again from the remaining moves.
- **Missing moves** in chat, as above.
- **Contested rulings** go through the appeal, and an overturned scripted ruling already flags the script.
- **Its reasons** are in the admin Full log, so a strange move is easy to read back.

A later step could let the admin start a duel where Claude plays both seats, to run many duels unattended and collect these. That's left out of this plan for now.

## Build order

Each step works end to end on its own.

1. **Play against Claude.** The admin entry point, the AI seat, the watch loop, move expansion, judge questions, code-made decisions, the model call and its answer, `aiDecided` records and cost, limits, errors, and the response-window timing. One generic plan for every deck. Offline tests use a fake model that picks at random and play whole duels through, which also tests the engine.
2. **Contests and missing moves.** The `contest` and `missing` fields, their limits and the chat messages.
3. **Deck plans and tuning.** A plan file per premade deck, and a small eval set of positions with a clear best move (lethal on board, don't attack into a face-up Mirror Force, use Trap Hole on the big Summon), run by hand like the judge evals.

## Open questions

- Should a missing-move complaint also file a ruling report, which flags the card's scripts at once in every duel?
