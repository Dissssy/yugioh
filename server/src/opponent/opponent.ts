// The AI opponent (docs/ai-opponent.md). It plays a seat through the same Duels methods a browser's requests reach
// (watch, act, answer, chat), so code checks its moves like anyone's, and it only ever reads its own seat's view.

import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { HANDS, type AiRecord, type DuelUpdate, type JudgingView, type LogEntry, type ModelUsage, type PlayerView, type Seat } from '@yugioh/engine';
import { loadCards } from '../cards.ts';
import type { Db } from '../db/client.ts';
import { decks } from '../db/schema.ts';
import type { ActResult, Duels, OpponentModel } from '../duels.ts';
import { usageOf } from '../judge/pricing.ts';
import { movesFor, optionsFor, safeMove, type Move } from './moves.ts';
import { askText, decksText, logBlocks, SYSTEM, type Decks } from './prompt.ts';

// Plain numbers: structured outputs don't take the bounds an integer schema carries. Code checks them against the options.
const moveAnswer = z.object({ reason: z.string(), choice: z.number(), note: z.string() });
const questionAnswer = z.object({ reason: z.string(), picks: z.array(z.number()), note: z.string() });
const MOVE_SCHEMA = z.toJSONSchema(moveAnswer);
const QUESTION_SCHEMA = z.toJSONSchema(questionAnswer);

/** Haiku plays with reasoning off, like the judge (its `reason` field comes first, so it thinks in the open); larger models think. */
function settingsFor(model: string): Pick<Anthropic.MessageCreateParamsNonStreaming, 'thinking' | 'max_tokens'> & { effort: 'high' | 'medium' } {
  return model.startsWith('claude-haiku')
    ? { thinking: { type: 'disabled' }, max_tokens: 4000, effort: 'high' }
    : { thinking: { type: 'adaptive' }, max_tokens: 16000, effort: 'medium' };
}

/** Starts and stops the AI opponents of the duels this server runs. */
export class Opponents {
  private playing = new Map<string, Opponent>();

  private duels: Duels;
  private db: Db;
  private model: OpponentModel;
  /** The response floor (RESPONSE_FLOOR_MS): its passes wait it out, so they look like the server's own. */
  private floorMs: number;
  private random: () => number;

  constructor(duels: Duels, db: Db, model: OpponentModel, floorMs: number, random: () => number = Math.random) {
    this.duels = duels;
    this.db = db;
    this.model = model;
    this.floorMs = floorMs;
    this.random = random;
  }

  /** Plays `seat` of a duel until it ends. Called by Duels when it loads a duel with an AI seat. */
  async attach(id: string, seat: Seat) {
    const key = `${id}:${seat}`;
    if (this.playing.has(key)) return;
    const row = await this.duels.find(id);
    const seatKey = seat === 0 ? row?.seat0 : row?.seat1;
    if (!row || !seatKey) return;
    const deckOf = async (deckId: number | null) => {
      const deck = deckId === null ? undefined : await this.db.query.decks.findFirst({ where: eq(decks.id, deckId) });
      if (!deck) throw new Error(`Duel ${id} has no deck for a seat`);
      const cards = await loadCards(this.db, [...deck.main, ...deck.extra]);
      return { name: deck.name, main: deck.main.map((c) => cards[c]!), extra: deck.extra.map((c) => cards[c]!) };
    };
    const [d0, d1] = await Promise.all([deckOf(row.deck0), deckOf(row.deck1)]);
    const history = await this.duels.aiHistory(id, seat);
    const opponent = new Opponent({
      id,
      seat,
      seatKey,
      duels: this.duels,
      model: this.model,
      decks: seat === 0 ? { mine: d0, theirs: d1 } : { mine: d1, theirs: d0 },
      floorMs: this.floorMs,
      random: this.random,
      calls: history.calls,
      note: history.note,
      stop: () => {
        this.playing.delete(key);
        unwatch();
      },
    });
    this.playing.set(key, opponent);
    const unwatch = await this.duels.watch(id, seat, (update) => opponent.update(update));
  }
}

interface Context {
  id: string;
  seat: Seat;
  seatKey: string;
  duels: Duels;
  model: OpponentModel;
  decks: Decks;
  floorMs: number;
  random: () => number;
  /** Model calls it has made in this duel so far, and its latest note (after a server restart). */
  calls: number;
  note: string;
  stop: () => void;
}

/** Model text without control characters: Postgres can't store a NUL in JSON, and the log has no use for the rest. */
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Opponent {
  private view: PlayerView | null = null;
  private log: LogEntry[] = [];
  private judging: JudgingView | null = null;
  /** The board it last acted on: it waits for a change before deciding again. */
  private actedOn: string | null = null;
  /** Moves code refused on this board, so it doesn't pick them again. */
  private refused = { on: '', intents: new Set<string>() };
  /** When the board last changed: a pass waits out the response floor from here. */
  private changedAt = Date.now();
  private lastMoveAt = 0;
  private busy = false;
  private again = false;
  private done = false;
  /** Whether the last model call failed, so a run of failures is said in chat once. */
  private failing = false;
  private decks: string;
  private calls: number;
  private note: string;

  private c: Context;

  constructor(c: Context) {
    this.c = c;
    this.decks = decksText(c.decks);
    this.calls = c.calls;
    this.note = c.note;
  }

  update(update: DuelUpdate) {
    const before = this.board();
    if (update.type === 'sync') {
      this.view = update.view;
      this.log = update.log;
      this.judging = update.judging;
    } else if (update.type === 'steps') {
      for (const step of update.steps) if (step.entry) this.log.push(step.entry);
      this.view = update.steps.at(-1)!.view;
    } else {
      this.judging = update.judging;
    }
    if (this.board() !== before) this.changedAt = Date.now();
    this.poke();
  }

  /**
   * Everything a decision depends on. Its own `aiDecided` records change nothing here, so writing one doesn't make
   * the board look new.
   */
  private board(): string {
    return JSON.stringify([this.view, this.log.length, this.judging]);
  }

  private poke() {
    if (this.done) return;
    if (this.busy) return void (this.again = true);
    this.busy = true;
    void this.decide()
      .catch((error: unknown) => console.error(`AI opponent in duel ${this.c.id}:`, error))
      .finally(() => {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.poke();
        }
      });
  }

  /** Makes at most one decision for the board as it is now. */
  private async decide() {
    const view = this.view;
    if (!view) return;
    if (view.result) {
      this.done = true;
      return this.c.stop();
    }
    const board = this.board();
    if (board === this.actedOn) return;
    const judging = this.judging;
    if (judging) {
      if (judging.waitingOn === this.c.seat && judging.prompt) await this.answer(view, judging, board);
      return;
    }
    // Decisions code makes by itself.
    const offered = (type: string) => view.actions.some((a) => a.type === type);
    if (offered('rollback')) return this.act(board, { text: 'Accept the rewind', intent: { type: 'rollback', accept: true } });
    if (offered('rps')) return this.act(board, { text: 'Rock-paper-scissors', intent: { type: 'rps', hand: HANDS[Math.floor(this.c.random() * 3)]! } });
    if (offered('chooseOrder')) return this.act(board, { text: 'Go first', intent: { type: 'chooseOrder', goFirst: true } });

    const offeredMoves = movesFor(view);
    // Holding nothing to respond with: the server passes for it after the response floor.
    if (offeredMoves.length === 1 && offeredMoves[0]!.intent.type === 'pass' && view.waiting?.for === 'respond') return;
    const refused = this.refused.on === board ? this.refused.intents : new Set<string>();
    const moves = offeredMoves.filter((m) => !refused.has(JSON.stringify(m.intent)));
    if (moves.length === 0) return;

    let move = moves[0]!;
    let failed = false;
    if (moves.length > 1) {
      if (!(await this.settled(board))) return;
      if (!(await this.withinLimit(board))) return;
      const picked = await this.ask(view, board, moves.map((m) => m.text), { moves: moves.map((m) => m.text) });
      if (picked === 'stale') return;
      move = picked === null ? safeMove(moves) : moves[picked[0]!]!;
      failed = picked === null;
    }
    // A pass waits out the response floor, so its timing looks like the server's automatic pass.
    if (move.intent.type === 'pass') await sleep(this.changedAt + this.c.floorMs * (1 + this.c.random() / 2) - Date.now());
    await sleep(this.lastMoveAt + this.c.model.paceMs - Date.now());
    if (this.board() !== board) return;
    await this.act(board, move);
    // Said after the move, since a chat message changes the board it decided on.
    if (failed) await this.sayOnce(`I couldn't decide on a move, so I picked: ${move.text}.`);
  }

  private async act(board: string, move: Move) {
    this.lastMoveAt = Date.now();
    const result = await this.c.duels.act(this.c.id, this.c.seatKey, move.intent);
    if (result.ok) return void (this.actedOn = board);
    this.refusedMove(board, move, result);
  }

  /** Code refused a move it offered: an engine bug, unless the board moved on in between. Decides again without it. */
  private refusedMove(board: string, move: Move, result: Extract<ActResult, { ok: false }>) {
    if (this.refused.on !== board) this.refused = { on: board, intents: new Set() };
    this.refused.intents.add(JSON.stringify(move.intent));
    this.again = true;
    if (result.status !== 422 || this.board() !== board) return;
    console.error(`AI opponent in duel ${this.c.id}: code offered "${move.text}" (${JSON.stringify(move.intent)}) but refused it: ${result.error}`);
    void this.c.duels.chat(this.c.id, this.c.seatKey, `The game offered me "${move.text}" but then refused it (${result.error}). That looks like a bug.`);
  }

  private async answer(view: PlayerView, judging: JudgingView, board: string) {
    const prompt = judging.prompt!;
    const options = optionsFor(prompt, this.c.seat);
    const fallback = options.slice(0, Math.max(prompt.min, 1)).map((_, i) => i);
    let picks: number[];
    if (options.length <= prompt.min) {
      picks = options.map((_, i) => i);
    } else if (this.calls >= this.c.model.calls) {
      // The duel waits on this answer, so it can't surrender now; it does at its next move.
      picks = fallback;
    } else {
      if (!(await this.settled(board))) return;
      const picked = await this.ask(view, board, options.map((o) => o.text), { judging, options: options.map((o) => o.text) }, prompt);
      if (picked === 'stale') return;
      picks = picked ?? fallback;
    }
    await sleep(this.lastMoveAt + this.c.model.paceMs - Date.now());
    if (this.board() !== board) return;
    this.lastMoveAt = Date.now();
    const result = await this.c.duels.answer(this.c.id, this.c.seatKey, prompt.id, picks.map((i) => options[i]!.pick));
    if (result.ok) this.actedOn = board;
    else console.error(`AI opponent in duel ${this.c.id}: its answer to "${prompt.text}" was refused: ${result.error}`);
  }

  /**
   * Waits for the board to settle before a model call: code commits a chain's resolution and what follows it one step
   * at a time, and a call made on a board that is about to change is thrown away. False if it changed meanwhile.
   */
  private async settled(board: string): Promise<boolean> {
    await sleep(this.changedAt + this.c.model.paceMs / 4 - Date.now());
    return this.board() === board;
  }

  /** At the duel's limit of model calls, it says so and surrenders, so a duel never hangs on it. */
  private async withinLimit(board: string): Promise<boolean> {
    if (this.calls < this.c.model.calls) return true;
    await this.c.duels.chat(this.c.id, this.c.seatKey, "I've used all the thinking I'm allowed for this duel, so I surrender.");
    await this.act(board, { text: 'Surrender', intent: { type: 'surrender' } });
    return false;
  }

  private async sayOnce(text: string) {
    if (this.failing) return;
    this.failing = true;
    await this.c.duels.chat(this.c.id, this.c.seatKey, text);
  }

  /**
   * One model call. Returns the picked option indexes, 'stale' if the board changed while it thought, or null if the
   * call failed or its answer didn't fit (the caller plays a safe default). Every call is recorded with its cost.
   */
  private async ask(
    view: PlayerView,
    board: string,
    options: string[],
    ask: Parameters<typeof askText>[2],
    question?: NonNullable<JudgingView['prompt']>,
  ): Promise<number[] | 'stale' | null> {
    this.calls++;
    const { model, call } = this.c.model;
    const settings = settingsFor(model);
    const log = logBlocks(this.log);
    log[log.length - 1] = { ...log[log.length - 1]!, cache_control: { type: 'ephemeral' } };
    const usage: ModelUsage[] = [];
    // A record that can't be stored is logged, and the duel goes on without it.
    const record = (picks: number[], fields: Partial<AiRecord>): Promise<void> =>
      this.c.duels
        .recordAi(this.c.id, { player: this.c.seat, model, options, picks, reason: '', note: this.note, stale: false, error: null, usage, ...fields })
        .catch((error: unknown) => console.error(`AI opponent in duel ${this.c.id} couldn't store a record:`, error));
    let answer: { reason: string; note: string; picks: number[] };
    try {
      const response = await call({
        model,
        max_tokens: settings.max_tokens,
        thinking: settings.thinking,
        output_config: { effort: settings.effort, format: { type: 'json_schema', schema: question ? QUESTION_SCHEMA : MOVE_SCHEMA } },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: this.decks, cache_control: { type: 'ephemeral' } }, ...log, { type: 'text', text: askText(view, this.note, ask) }] }],
      });
      usage.push(usageOf(model, response));
      if (response.stop_reason === 'refusal') throw new Error('The model declined the request.');
      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      const parsed = question ? questionAnswer.parse(JSON.parse(text)) : moveAnswer.parse(JSON.parse(text));
      answer = { reason: clean(parsed.reason), note: clean(parsed.note), picks: 'picks' in parsed ? parsed.picks.map((n) => n - 1) : [parsed.choice - 1] };
    } catch (error) {
      await record([], { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    const fits = answer.picks.every(Number.isInteger) && new Set(answer.picks).size === answer.picks.length && answer.picks.every((i) => i >= 0 && i < options.length);
    const count = question ? answer.picks.length >= question.min && answer.picks.length <= question.max : answer.picks.length === 1;
    if (!fits || !count) {
      await record(answer.picks.filter((i) => i >= 0 && i < options.length), { reason: answer.reason, error: `Its picks (${answer.picks.map((i) => i + 1).join(', ')}) don't fit the options.` });
      return null;
    }
    this.note = answer.note;
    this.failing = false;
    const stale = this.board() !== board;
    await record(answer.picks, { reason: answer.reason, note: answer.note, stale });
    return stale ? 'stale' : answer.picks;
  }
}
