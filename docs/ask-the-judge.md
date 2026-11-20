# Ask the judge

Status, 2026-11-20: all three steps built. Notes marked **Built** say where the code differs from the plan. Part of the order in [next-steps.md](next-steps.md).

During a duel a player asks a rules question in plain words about the board in front of them: "Can Trap Hole answer that Synchro Summon?", "Why can't I attack with Junk Warrior?", "Does Swords of Revealing Light stop my own attacks?" They get an answer in a few seconds. When they think the answer shows the game is wrong, one click escalates it to the appeal model, which can contest a ruling through the existing flow or set a card's script aside the way a report does.

## Why

Players have two tools today, and neither answers a question:

- **Contest** needs a ruling to point at. The most common confusion in playtests is "nothing happened": a move wasn't offered, a trigger never came up. There is no ruling to contest.
- **Report a ruling problem** flags the card's scripts at once and tells the player nothing.

Often the game is right and the player just doesn't know the rule (Trap Hole doesn't answer a Special Summon). An answer settles that without spending an appeal or flagging a good script.

## Principles

- **The answer comes from what the asker can see.** The question's prompt is built from the asker's `PlayerView` and their own log, with the prompt builders the AI opponent already uses (`boardText` and `logBlocks` in `server/src/opponent/prompt.ts`). It never sees `DuelState`, so it can't leak a hidden card even by mistake. This is the same trick as the AI opponent.
- **Code answers what code knows.** For "why can't I...?" questions, code works out its own reason (see `whyNot` below) and the model is given it as a fact it must not contradict. The model explains; code is the authority on what the engine does.
- **A question never changes the duel or holds it up.** The duel doesn't pause, and a question can be asked while the judge is working or a window is open.
- **Private by default.** The question itself can give away a hand ("can my Trap Hole..."), so only the asker sees it and its answer. An escalation that becomes a contest is public, as every contest is today.

## Build order

Each step works on its own.

### 1. "Why can't I?" (code only, free)

When a player opens the menu of a card with effects that aren't offered right now, the menu lists them greyed out as **Why can't I activate this?**. Choosing one shows code's reason next to the card, for example "Trap Hole needs a monster with 1000 or more ATK to have just been Normal or Flip Summoned" or "Once per turn: already used this turn". The same goes for a monster that can't attack ("This card attacked already this turn", "Swords of Revealing Light: your opponent's monsters can't declare an attack").

- **Engine:** `whyNot(state, seat, card, effect): string | null` in `engine/src/rules.ts`, next to `legalActions`, running the same checks in the same order (phase, place, free zone, once-per-turn, the `when` window, spell speed against the chain, then `scriptProblem` for a scripted effect) and returning the first that fails. A sibling `whyNotAttack` covers attacks. Sharing the checks with `legalActions` (one function that both call) keeps the reason and the offer from drifting apart; a test asserts `whyNot` is null exactly when `legalActions` offers the activation.
- **Judge-only effects** (no script) have only the generic checks. If those pass, the reason is "The judge decides when you try", and the effect is offered anyway.
- **Hidden information:** reasons only describe the asker's own cards and public facts. A test runs `hiddenNameIn` over every reason the offline duels produce.
- **API:** the reasons ride on the view: `PlayerView.blocked: { card, effect, reason }[]` for the player's visible cards with effects, so no extra request is needed and the menu shows them at once.
- **Built:** `checkEffects` in `engine/src/rules.ts` runs the checks once per effect and gives either the activation code may offer or the reason it can't; `legalActions` takes the activations and `blockedEffects` the reasons (then `scriptProblem` for scripted effects that pass), so the two can't drift. Where the card is comes first (a Trap Set this turn, an effect of a face-down monster), then the timing, spell speed, once per turn, a standing refusal, the phase and last the `when` moment. `blockedAttacks` covers attacks in the Battle Phase. `Blocked` also carries the effect's wording, so a card with several effects says which. Trigger, continuous, Flip and summoning-condition effects get a line saying how they work (they are never activated by hand). The menu opens on any of your cards with something to say, and each reason sits in a "Why can't I activate this?" item that unfolds in place.

### 2. Ask a question (Haiku)

- **Where:** the chat box in the sidebar gets a switch, **Chat / Ask the judge**. Pinned card details get **Ask about this card**, which switches the box to Ask and names the card. The answer appears in the asker's log as a private entry, styled apart and marked "Only you see this", with **Escalate** under it.
- **Built:** `card` is the card's code, not an instance ID (pinned card details know the card, not which copy), and must be a card the asker can see or one in their own Deck or Extra Deck. While the answer is on its way the box says "The judge is answering…".
- **API:** `POST /api/duels/:id/ask { text, card? }` answers 202, and the answer arrives on the asker's stream as a log entry. 409 while that player's previous question is still being answered (one at a time each), 429 when their questions are used up, 503 without an API key. Guests can ask like accounts.
- **The prompt**, in cache order:
  1. *System (cached, the same for every question):* what the judge's helper is for, the judge's rules reference (`RULES` from `prompt.ts`, so both agree), what this site doesn't support yet (Fusion, Link, Pendulum, per-card default responses), and the answer format.
  2. *The asker's deck list with card text* (cached per deck). They know their own deck.
  3. *The asker's log* (cached up to the last question), one block per entry as for the AI opponent.
  4. *Now:* the board as the asker sees it, the current step (whose priority, what the window answers), the sheet entries of every card the asker can see (window, cost, effect, `when`, whether it has a script and its status), the asker's legal moves as text (`moves.ts`), every `blocked` reason from step 1, and the question.
- **The answer** (structured output, `answer` written before `verdict` so the model reasons first):

  ```ts
  {
    answer: string;                 // up to three sentences for the asker
    verdict: 'explained' | 'game_seems_wrong' | 'not_sure';
    about: { ruling: number } | { card: string } | null; // the judged entry's seq, or the card instance, it is about
  }
  ```

  `explained` means the game did the right thing and says why. `game_seems_wrong` and `not_sure` show **Escalate** more prominently.
- **Model:** Claude Haiku 5.5 with thinking disabled at effort high, like the judge. Rough cost: about 10,000 cached tokens and 1,500 new ones per question, so about $0.002.
- **Record:** an `asked` event in the duel log: the seat, question, card, answer, verdict, `about`, model and token usage. `logFor` shows it only to the asker; the other seat never learns a question was asked. The admin Full log shows it, the admin costs count it, and `evolve` ignores it (like `aiDecided`).
- **Hidden check:** the prompt holds nothing hidden, but the model knows the premade decklists from training. As a backstop, the answer goes through `hiddenNameIn` for the asker's seat, and a hit replaces it with "The judge's answer named a card you can't see, so it was withheld. Escalate if you still need an answer."
- **Limits:** `QUESTIONS_PER_DUEL` per player (default 20). Questions don't count toward the 300 judge calls. The AI opponent doesn't ask; it has its `missing` complaints.

### 3. Escalate (Opus)

**Escalate** under an answer sends the question, the answer and the asker's note (optional) to the appeal model (Opus 5.5, adaptive thinking). Unlike the question, the escalation sees the full board (`DuelState`), as an appeal does, plus the `whyNot` reasons and, when `about` names a ruling, that ruling's transcript. Its explanation is checked with `hiddenNameIn` for the asker, as appeal explanations are today.

It answers with one of four outcomes:

| Outcome | Means | What happens |
| --- | --- | --- |
| `game_right` | The game is right | The asker gets the explanation. Nothing else changes. |
| `ruling_wrong` | A past ruling (a `judged` entry the asker can see) was wrong | The server contests that ruling for the asker through the existing `contest` path, with the escalation's ruling as the note. From there it is the normal appeal: public verdict in both logs, rollback offer, and a scripted ruling that is overturned flags the script. |
| `card_wrong` | A card's script refuses a move it should allow, or does the wrong thing | The same as a player's report: a `sheet_reports` row with reporter `escalation` and the ruling as the note, the card's scripts are flagged, and running duels get the change, so the judge rules on the card from now on and the move may be offered at once. The asker is told "The card's script was set aside; the judge rules on it now." The opponent sees nothing, as with reports today. |
| `engine_wrong` | A rule in code is wrong (phases, chains, battle, summoning) | Stored for the admin as a report with no card. Nothing in the duel changes. |

- **Cost and limits:** an escalation is one of the duel's 10 appeals (`APPEALS_PER_DUEL`). A contest it starts doesn't count again. Each player may escalate each answer once.
- **Reports with no card:** `sheet_reports.code` becomes nullable; a report with no card is about a rule in code. **Built:** the admin Rulings section lists them under "Rules in code", and `GET /api/admin/rulings` answers `{ cards, engine }`. Reports from an escalation have the reporter `escalation`.
- **Record:** an `escalated` event (seat, the `asked` seq, outcome, explanation, ruling, model, usage), shown only to the asker, like `asked`. A contest it starts is an ordinary `appealed` entry.
- **Built:** `POST /api/duels/:id/escalate { seq, note }` (202; 404 for a question that isn't the caller's, 409 when already escalated, 429 when the appeals are used up). `server/src/judge/ask.ts` holds both calls. The escalation's answer is checked by code: a `ruling_wrong` must name a ruling in the asker's log and a `card_wrong` a card in the duel, and its explanation must name no card the asker can't see. A failed check goes back to the model once; a target still wrong after that is kept as an `engine_wrong` for the admin, and a leak gets a plain explanation instead. Appeals used = contests + escalations that didn't start a contest. The admin's duel list gains a Questions column; escalations count as appeals.

## Tests and evals

- **Offline:** `whyNot` agrees with `legalActions` on every board the offline duels reach; `asked` and `escalated` entries never appear in the other seat's log; the limits; each escalation outcome with a fake model (a `ruling_wrong` starts a contest, a `card_wrong` flags the scripts and reaches a running duel).
- **Live evals,** run by hand like the judge's: a dozen board-and-question cases with the expected verdict ("Can Trap Hole answer a Synchro Summon?" is `explained`; a case where a script wrongly refuses a legal activation is `game_seems_wrong`).

## Decisions for Ethan

| Question | Recommendation | Other options |
| --- | --- | --- |
| Who sees a question and its answer | Only the asker; the opponent doesn't learn one was asked | Both players see the question and answer; or the opponent sees "asked the judge" without the text |
| Questions per duel | 20 per player, separate from the 300 judge calls (Haiku makes them about $0.002 each) | A lower cap; or counting them against the judge calls |
| When Escalate is offered | On every answer, since the player may disagree with a confident answer | Only when the answer says `game_seems_wrong` or `not_sure` |
| An escalation that finds a card wrong | Flags the card's scripts at once, as your rule for reports already does | Store it for the admin to act on, changing nothing in the duel |
| What an escalation costs | One of the duel's 10 appeals | A separate cap |
