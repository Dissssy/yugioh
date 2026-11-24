# Rulings history and the tuning job

Status, 2026-11-19: plan, not built. Part of the order in [next-steps.md](next-steps.md).

Effect sheets are where the site's rulings live: a script is a fixed ruling that code runs, and the judge reads the rest of the sheet. This plan makes their history readable, keeps it outside the database, and adds a job where Opus studies finished duels and proposes sheet fixes for Ethan to accept or reject. Four steps, each useful alone.

## What exists today

- `effect_sheets` holds each card's sheet; `sheet_revisions` keeps every version with a `reason` and a time; `sheet_reports` holds players' reports and overturned appeals on scripts ([effects.md](effects.md)).
- `saveSheet` in `server/src/sheets.ts` is the one place sheets are written. The compiler, imports, reports, appeals and the admin all go through it.
- The admin Rulings section lists cards with open reports or flagged scripts, with a JSON editor, Restore scripts and Mark scripts verified.
- Missing: what changed between two versions, who changed it, a way back to an older version, and any history that outlives a database reset. (`RESET_SHEETS` was removed on 2026-11-24: a start now imports only changed repository files, so revisions build up across deploys; see [review-api.md](review-api.md).)
- Architecture layer 6 planned a separate store of "verified rulings" retrieved into judge prompts. It was never built; the appeal's `ruling` text only reaches `sheet_reports`. Step 4 below proposes putting such rulings into the sheet instead.

## 1. History and diff on the admin page

- **Who changed it.** `sheet_revisions` gains `author`: an admin's account ID, or `compiler`, `import`, `report`, `appeal`, `escalation` or `tuner`. A revision that came from a duel keeps `match_id` and `seq`, so it links to that line of the duel's Full log. Pre-launch, so this is a schema change with no migration.
- **Every card.** The Rulings section gets a search over every card with a sheet, not just reported ones. A card's page shows a timeline: its revisions, interleaved with the reports and appeals on it.
- **Diffs.** Each revision shows what changed from the one before, and any two can be compared. Both sheets are printed as JSON exactly as `sheets:export` writes the files (stable key order, two-space indent), then compared line by line with [jsdiff](https://github.com/kpdecker/jsdiff) (`diff` on npm) and shown as a unified diff with the effect index in each hunk's header. That's the same text git would show, so the page and the git mirror (step 2) agree.
- **Restore.** "Restore this version" saves it as a new revision ("restored revision 12"), only if it is for the card's current text. History is never rewritten.
- **API:** `GET /api/admin/sheets/:code/history` returns every revision (whole sheets; they are small) and the card's reports, and the page computes the diffs.

## 2. Git mirror on the server

A git repository on the home server's disk that gets a commit for every sheet change. It is never pushed to GitHub. It outlives database resets, and its layout matches the main repository's, so a fix moves from one to the other with ordinary git.

- **Where:** `SHEETS_GIT_DIR`. In production a bind mount, `./rulings:/data/rulings` in compose.yaml, so it sits at `/git/yugioh/rulings` on the host. Unset (tests, local dev) means no mirror.
- **Commits:** after each `saveSheet`, a queue writes `server/effect-sheets/<code>.json` in the mirror exactly as `sheets:export` would, and commits it with the revision's author as the git author (`Admin <username>`, `Player report`, `Tuner`, ...) and its reason as the message, plus the duel link when there is one. A save never waits for or fails with the mirror: an error is logged, and at start the server commits any difference between the database and the mirror as "sync from database". A reset and reimport commits only real changes, naming the image's commit.
- **Git itself:** the `git` CLI, run with `execFile`. The runtime image adds the `git` package (a few MB). isomorphic-git would avoid that, but real git has fewer surprises and the commits are plain.
- **Using it** from Ethan's own clone of the main repository:

  ```sh
  git remote add rulings ssh://192.168.1.200/git/yugioh/rulings
  git fetch rulings
  git diff HEAD rulings/main -- server/effect-sheets       # what the live site changed
  git checkout rulings/main -- server/effect-sheets/12345.json   # take one fix into the repo
  ```

  The two histories are unrelated, so it's `checkout` of files rather than merge or cherry-pick. Taken fixes then reach GitHub through a normal commit, as sheet files do today.
- **The page reads the database, not git.** The database stays the one source of truth, and the history page works the same with the mirror off.

## 3. Eval cases as data

The tuning job (step 4) has to write eval cases, and today's cases are TypeScript with check functions (`server/src/judge/evals.ts`). So add cases that are plain data, taken from a real duel:

```ts
interface SnapshotCase {
  name: string;
  state: DuelState;     // the whole board at that point, hidden cards included, trimmed to the cards present
  seat: Seat;
  intent: Intent | null; // the activation to try; null checks the mandatory triggers that follow
  picks: string[][];     // card names or choices, one list per question
  expect: {
    legal: boolean;
    places?: { card: string; seat: Seat; place: 'hand' | 'deck' | 'gy' | 'banished' | 'extra' | 'monsters' | 'spellTraps' | 'materials' }[];
    lp?: [number, number];
  };
}
```

- Stored as `server/eval-snapshots/*.json` in the repository (and in the git mirror under the same path), loaded by the eval runner next to `evals.ts`. Cases for scripted effects run offline in CI, like the hand-written ones.
- Made from a duel: the admin page gets **Make eval case** on a report or appeal. The server replays the log to that `seq`, and the admin fills in the expectation.
- `places` and `lp` cover what the existing check functions mostly test; the vocabulary grows only when a case needs it.

## 4. Opus tuning job

Turns evidence from finished duels into proposed sheet changes, which Ethan reads as diffs and accepts or rejects, so fixing a card doesn't start with reading duel logs.

- **Evidence**, per card, since the job last looked at it:
  - appeals on its rulings, overturned or upheld (scripted or judged);
  - player reports and `card_wrong` escalations ([ask-the-judge.md](ask-the-judge.md));
  - the judge's rulings on its effects that have no script, as candidates to script once the judge has ruled them the same way a few times;
  - judge calls that failed;
  - the AI opponent's "I expected to be able to" messages that name it.
- **When:** nightly at 04:00 server time, on the same in-process timer as the card sync, and from **Tune now** on the admin page. Only cards with new evidence go in.
- **The call:** Opus 5.5 with adaptive thinking through the Message Batches API (half price), like the compiler. Per card: its text; the current sheet and its last revisions with reasons; each piece of evidence (the board at that point, from `describeState`, the ruling's transcript, the appeal's ruling, the report's note); the compiler's script vocabulary and instructions; the card's existing eval cases; and proposals Ethan rejected before, with his note.
- **The answer:** `{ change: 'none' | 'sheet', sheet, rationale, cases: SnapshotCase[] }`. One case per piece of evidence, saying what should have happened.
- **Code checks it before Ethan sees it.** The sheet fits the schema and the card's current text; every offline eval case still passes with it; its own new cases pass with it; and, when the old sheet had a script, at least one new case fails with the old sheet, showing the change fixes something. A proposal that fails is kept as `failed`, with why, and isn't offered.
- **Review:** a **Proposals** list in the Rulings section shows each proposal's diff against the current sheet (step 1's view), its rationale, the evidence with links into the duel logs, and its cases. **Accept** saves it through `saveSheet` (author `tuner`, reason naming the admin who accepted it) and writes its cases to `server/eval-snapshots/` in the git mirror. **Reject** asks for a short note, which goes back to the next run.
- **Table:** `sheet_proposals`: card, the revision it was made against, the sheet, rationale, cases, evidence, status (`proposed`, `accepted`, `rejected`, `failed`, `stale`), the admin's note and the token usage. A proposal goes `stale` when the sheet changes after it was made.
- **Cost:** the compiler spends about $0.05 a card in a batch; a tuning prompt with evidence is bigger, so about $0.10 to $0.30 a card. `TUNER_MAX_CARDS` (default 10) caps a run at about $3. The admin cost total gets a Tuning line.
- **Rulings the judge reads.** The judge-only effects need somewhere to keep a fix that isn't a script ("Harmonic Waves can target a monster that is already Level 4"). Add `rulings: string[]` to `SheetEffect`: short rulings the judge sees next to that card's text. The tuner and the admin write them, and they get history, diffs and the mirror like everything else in the sheet. That replaces architecture layer 6's separate rulings store.

## Decisions for Ethan

| Question | Recommendation | Other options |
| --- | --- | --- |
| Where history is read from | The database, with git as a mirror of it | Read history from the git repository |
| Where the mirror lives | A bind mount at `/git/yugioh/rulings`, fetched over SSH from your clone | A Docker volume, copied out when needed |
| What the tuner may do | Propose only; nothing changes until you accept | Apply its changes at once, as reports flag at once |
| What Accept marks the effects | `verified`, since you read the diff | `unverified`, leaving verification separate |
| How often it runs | Nightly with a cap of 10 cards, plus Tune now | Only when you press Tune now |
| Rulings for judge-only effects | A `rulings` list on each sheet effect, replacing the planned separate rulings store | Build the separate store from architecture layer 6 |
