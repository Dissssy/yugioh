// The runtime judge: Claude Haiku 5.5 applies one card effect through a short tool loop. Each op is checked by the
// engine against a scratch copy of the board, and a refused op goes back to the model as an error. Nothing reaches
// the duel until the model calls finish; the caller then commits the events this returns.

import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import {
  applyOp,
  cardOf,
  evolve,
  locate,
  monsterZonesFor,
  visibleTo,
  zonePick,
  type ChainLink,
  type DuelEvent,
  type DuelState,
  type JudgeRecord,
  type ModelUsage,
  type Op,
  type Place,
  type Seat,
  type SheetEffect,
} from '@yugioh/engine';
import { hiddenNameIn } from './hidden.ts';
import { usageOf } from './pricing.ts';
import { activationRequest, resolutionRequest, RULES } from './prompt.ts';
import { askPlayer, finish, parseOp, randomCards, TOOLS, type AskPlayer } from './tools.ts';

export const JUDGE_MODEL = 'claude-haiku-5-5';
/** Model turns per judge call before it counts as failed. */
const MAX_TURNS = 16;

export const PROMPT_VERSION = createHash('sha256').update(RULES).update(JSON.stringify(TOOLS)).digest('hex').slice(0, 12);

/** One Messages API call; the real one is `client.messages.create`, tests script it. */
export type ModelCall = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

/** A card a player may pick: `hidden` when it is face-down on the field and the player may not know what it is. */
export interface QuestionCard {
  id: string;
  place: Place;
  seat: Seat;
  /** The zone index of a card on the field, else null. */
  zone: number | null;
  hidden: boolean;
}

/** A question for a player, with its options checked to be real. */
export interface Question {
  player: Seat;
  text: string;
  cards: QuestionCard[];
  choices: string[];
  /** The asked player's empty Main Monster Zones, when the question is where a monster goes (picks are `zonePick`). */
  zones: number[];
  min: number;
  max: number;
}

export interface JudgeDeps {
  model: ModelCall;
  /** Puts a question to a player and resolves with their picks (already checked against the question). */
  ask: (question: Question) => Promise<string[]>;
  random: () => number;
}

export interface JudgeCall {
  stage: 'activation' | 'resolution';
  /** The board the judge works on: for an activation, with the card already activated. */
  state: DuelState;
  link: ChainLink;
  /** For an activation an appeal ruled legal on this board after the judge refused it: the appeal's ruling, which binds. */
  appealRuling?: string | null;
}

export interface JudgeOutcome {
  record: JudgeRecord;
  /** The ops' events, to commit after the `judged` event. Empty for an illegal activation or a failure. */
  events: DuelEvent[];
}

export async function judge(call: JudgeCall, deps: JudgeDeps): Promise<JudgeOutcome> {
  const { stage, link } = call;
  let scratch = call.state;
  const events: DuelEvent[] = [];
  const ops: Op[] = [];
  const usage: ModelUsage[] = [];
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: stage === 'activation' ? activationRequest(scratch, link, call.appealRuling ?? null) : resolutionRequest(scratch, link, call.appealRuling ?? null) },
  ];
  const record = (fields: Pick<JudgeRecord, 'legal' | 'summary' | 'error'>): JudgeRecord => ({
    stage,
    player: link.player,
    card: link.card,
    effect: link.effect,
    model: JUDGE_MODEL,
    promptVersion: PROMPT_VERSION,
    stateHash: createHash('sha256').update(JSON.stringify(call.state)).digest('hex'),
    transcript: messages,
    ops,
    usage,
    ...fields,
  });
  const sheetEffect = sheetEffectOf(call.state, link);
  /** True while the effect has a cost and no op has paid anything (choosing targets or an effect pays nothing). */
  /** Cards each player picked in answer to ask_player during this call. */
  const picked = new Set<string>();
  const unpaid = (done: Op[]) => sheetEffect.cost.trim() !== '' && !done.some((o) => o.op !== 'declare_targets' && o.op !== 'choose_effect');
  const failed = (error: string): JudgeOutcome => ({
    record: record({
      legal: stage === 'resolution',
      summary: stage === 'activation' ? 'The judge could not rule on this activation, so it was not activated.' : 'The judge could not resolve this effect, so it did nothing.',
      error,
    }),
    events: [],
  });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await deps.model({
        model: JUDGE_MODEL,
        max_tokens: 4096,
        // Reasoning off: Haiku 5.5 accepts disabled thinking at effort high or below.
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' },
        system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        tool_choice: { type: 'any' },
        messages,
      });
      usage.push(usageOf(JUDGE_MODEL, response));
      if (response.stop_reason === 'refusal') return failed('The model declined the request.');
      messages.push({ role: 'assistant', content: response.content });
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const results: Anthropic.ToolResultBlockParam[] = [];
      /** Answers a tool call; returns true so a refusal reads `refused = reply(..., true)`. */
      const reply = (id: string, content: string, isError = false) => {
        results.push({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });
        return true;
      };
      let refused = false;
      let done: { legal: boolean; summary: string } | null = null;

      for (const c of calls) {
        if (refused || done) {
          reply(c.id, refused ? 'Skipped: an earlier call in this turn was refused.' : 'Skipped: finish must be the last call.', true);
          continue;
        }
        if (c.name === 'finish') {
          const parsed = finish.safeParse(c.input);
          const leak = parsed.success ? hiddenNameIn(scratch, parsed.data.summary, [0, 1]) : null;
          if (!parsed.success) refused = reply(c.id, 'Invalid input.', true);
          else if (!parsed.data.summary.trim()) refused = reply(c.id, 'Write a one-sentence summary.', true);
          else if (stage === 'activation' && !parsed.data.legal && call.appealRuling) {
            refused = reply(c.id, `An appeal already ruled this activation legal on this board: ${call.appealRuling} Pay its cost and declare its targets, then finish with legal true.`, true);
          } else if (stage === 'activation' && !parsed.data.legal && ops.length > 0) {
            refused = reply(c.id, 'An illegal activation makes no changes. The ops you made will be discarded; call finish again to confirm.', true);
            scratch = call.state;
            events.length = 0;
            ops.length = 0;
          } else if (leak) refused = reply(c.id, `The summary names ${leak}, which a player can't see. Rephrase it without naming hidden cards.`, true);
          else if (stage === 'activation' && parsed.data.legal && unpaid(ops)) {
            refused = reply(c.id, `This activation has a cost ("${sheetEffect.cost}") and you haven't paid it. Pay it with ops, or call finish with legal false if it can't be paid.`, true);
          } else if (stage === 'activation' && parsed.data.legal && sheetEffect.targets && !ops.some((o) => o.op === 'declare_targets')) {
            refused = reply(c.id, `This effect targets (${sheetEffect.targets}) and you haven't declared targets. Declare them, or call finish with legal false if there is no legal target.`, true);
          } else {
            done = { legal: stage === 'resolution' ? true : parsed.data.legal, summary: parsed.data.summary.trim() };
            reply(c.id, 'Done.');
          }
          continue;
        }
        if (c.name === 'random_cards') {
          const parsed = randomCards.safeParse(c.input);
          if (!parsed.success) {
            refused = reply(c.id, 'Invalid input.', true);
            continue;
          }
          const hand = [...scratch.players[parsed.data.player].hand];
          const picked: string[] = [];
          while (hand.length > 0 && picked.length < parsed.data.count) picked.push(...hand.splice(Math.floor(deps.random() * hand.length), 1));
          reply(c.id, JSON.stringify({ picked }));
          continue;
        }
        if (c.name === 'ask_player') {
          const parsed = askPlayer.safeParse(c.input);
          const question = !parsed.success
            ? { error: 'Invalid input.' }
            : (stage === 'activation' && activationPickProblem(scratch, sheetEffect, link, ops, parsed.data.cards, null)) || checkQuestion(scratch, parsed.data);
          if ('error' in question) {
            refused = reply(c.id, question.error, true);
            continue;
          }
          const picks = await deps.ask(question);
          for (const id of picks) picked.add(id);
          reply(c.id, JSON.stringify({ picked: picks }));
          continue;
        }
        const parsed = parseOp(c.name, c.input);
        if (!parsed.ok) {
          refused = reply(c.id, parsed.error, true);
          continue;
        }
        const pickProblem = parsed.op.op === 'declare_targets' && stage === 'activation' ? activationPickProblem(scratch, sheetEffect, link, ops, parsed.op.cards, picked) : null;
        if (pickProblem) {
          refused = reply(c.id, pickProblem.error, true);
          continue;
        }
        const named = parsed.op.op === 'choose_effect' ? hiddenNameIn(scratch, parsed.op.choice, [0, 1]) : null;
        if (named) {
          refused = reply(c.id, `The choice names ${named}, which a player can't see. Word it without naming hidden cards.`, true);
          continue;
        }
        const opCtx = { player: link.player, source: link.card, stage, random: deps.random };
        let op = parsed.op;
        if (op.op === 'special_summon' || op.op === 'take_control' || op.op === 'summon_token') {
          const { zone: _, ...unplaced } = op;
          const placed = await placeInto(scratch, unplaced as Unplaced, opCtx, deps.ask);
          if (!placed.ok) {
            refused = reply(c.id, placed.error, true);
            continue;
          }
          op = placed.op;
        }
        const applied = applyOp(scratch, op, opCtx);
        if (!applied.ok) {
          refused = reply(c.id, applied.error, true);
          continue;
        }
        scratch = applied.events.reduce(evolve, scratch);
        events.push(...applied.events);
        ops.push(op);
        reply(c.id, scratch.result ? 'Done. The duel is over; call finish.' : 'Done.');
      }

      if (calls.length === 0) messages.push({ role: 'user', content: 'Use the tools; call finish when you are done.' });
      else messages.push({ role: 'user', content: results });
      if (done) {
        const legal = done.legal;
        return { record: record({ legal, summary: done.summary, error: null }), events: legal ? events : [] };
      }
    }
    return failed(`No finish within ${MAX_TURNS} turns.`);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

/** The sheet entry of the effect being judged. */
function sheetEffectOf(state: DuelState, link: ChainLink): SheetEffect {
  return state.sheets[cardOf(state, link.card).code]!.effects[link.effect]!;
}

/** Cards an op has already moved, destroyed or summoned; during an activation check these paid the cost. */
function cardsUsed(ops: Op[]): string[] {
  return ops.flatMap((o) => ('cards' in o ? o.cards : 'card' in o ? [o.card] : []));
}

/**
 * During an activation check, players choose cards only for the cost and the targets. Checks cards offered by
 * ask_player (`picked` null) or declared as targets (`picked` the cards players chose so far).
 */
function activationPickProblem(
  state: DuelState,
  effect: SheetEffect,
  link: ChainLink,
  ops: Op[],
  cards: string[],
  picked: Set<string> | null,
): { error: string } | null {
  if (cards.length === 0) return null;
  const targeting = picked !== null;
  if (targeting && !effect.targets) return { error: "This effect doesn't target, so declare no targets. Cards it affects are chosen when it resolves." };
  if (!targeting && !effect.cost.trim() && !effect.targets) {
    return { error: "This effect has no cost and doesn't target, so nothing is chosen on activation: rule on legality now, and ask the player which cards when it resolves." };
  }
  if (cards.includes(link.card)) return { error: `${link.card} is the card being activated; it can't be its own cost or target.` };
  const used = cards.find((id) => cardsUsed(ops).includes(id));
  if (used) {
    return {
      error: `${used} was used to pay this activation's cost, so it can't be chosen again or targeted: legality is judged before the cost is paid. If no other card fits, call finish with legal false.`,
    };
  }
  // With no cost, every card asked for on activation is a target.
  if ((targeting || !effect.cost.trim()) && effect.targets && /\bface-up\b/i.test(effect.targets)) {
    const faceDown = cards.find((id) => {
      const at = locate(state, id);
      return (at?.zone === 'monsters' || at?.zone === 'spellTraps') && !state.players[at.seat][at.zone][at.index]!.faceUp;
    });
    if (faceDown) return { error: `${faceDown} is face-down, and this effect targets face-up cards only ("${effect.targets}").` };
  }
  const unchosen = targeting ? cards.find((id) => !picked.has(id)) : undefined;
  if (unchosen) return { error: `The player didn't pick ${unchosen}. Targets are the player's choice: ask them with ask_player, then declare the cards they picked.` };
  return null;
}

/** Checks an ask_player call: real options, sensible counts, and a prompt that names nothing the player can't see. */
export function checkQuestion(state: DuelState, q: AskPlayer): Question | { error: string } {
  const p = q.player;
  if (q.cards.length === 0 && q.choices.length === 0) return { error: 'Give at least one card or choice.' };
  if (q.cards.length > 0 && q.choices.length > 0) return { error: 'Ask for cards or for choices, not both in one question.' };
  if (q.cards.length === 0 && q.choices.length === 1) return { error: 'A question with one choice offers no choice. Go ahead without asking.' };
  const count = q.cards.length + q.choices.length;
  if (q.min < 0 || q.max < Math.max(1, q.min) || q.min > count) return { error: `min and max must satisfy 0 <= min <= max, min <= ${count}, max >= 1.` };
  if (new Set(q.cards).size !== q.cards.length || new Set(q.choices).size !== q.choices.length) return { error: 'Each option may appear once.' };
  const cards: Question['cards'] = [];
  for (const id of q.cards) {
    const at = state.instances[id] ? locate(state, id) : null;
    if (!at) return { error: `There is no card ${id}.` };
    // A player may pick from what they can see, from their own Deck when an effect lets them search it, and any card
    // on the field: a face-down one is offered as a face-down card, without its identity.
    const field = at.zone === 'monsters' || at.zone === 'spellTraps';
    const hidden = !visibleTo(state, id, p);
    if (hidden && !field && !(at.zone === 'deck' && at.seat === p)) return { error: `Player ${p} can't see ${id}, so it can't be an option for them.` };
    cards.push({ id, place: at.zone, seat: at.seat, zone: field ? at.index : null, hidden: hidden && field });
  }
  const leak = hiddenNameIn(state, q.prompt, [p]);
  if (leak) return { error: `The prompt names ${leak}, which player ${p} can't see.` };
  return { player: p, text: q.prompt, cards, choices: q.choices, zones: [], min: q.min, max: Math.min(q.max, count) };
}

/** An op that puts a monster in a Monster Zone of `controller`'s. */
type ZoneOp = Extract<Op, { zone: number; controller: Seat }>;
type Unplaced = ZoneOp extends infer O ? (O extends ZoneOp ? Omit<O, 'zone'> : never) : never;

/**
 * Applies `op` (without a zone: a Special Summon, a Token, or taking control) into the Main Monster Zone its
 * controller picks: they are asked when more than one is empty, once code has checked the op itself can happen.
 * Returns the op with its zone, or why it can't be applied.
 */
export async function placeInto(
  state: DuelState,
  op: Unplaced,
  ctx: Parameters<typeof applyOp>[2],
  ask: JudgeDeps['ask'],
): Promise<{ ok: true; op: Op; picks: string[] | null } | { ok: false; error: string }> {
  const free = monsterZonesFor(state, op.controller, false);
  const check = applyOp(state, { ...op, zone: free[0] ?? 0 } as ZoneOp, ctx);
  if (!check.ok) return check;
  if (free.length === 1) return { ok: true, op: { ...op, zone: free[0]! } as ZoneOp, picks: null };
  const what =
    op.op === 'summon_token'
      ? `Special Summon ${op.token.name}`
      : `${op.op === 'take_control' ? 'Take control of' : 'Special Summon'} ${visibleTo(state, op.card, op.controller) ? cardOf(state, op.card).name : 'the monster'}`;
  const picks = await ask({ player: op.controller, text: `${what}: choose a Monster Zone for it.`, cards: [], choices: [], zones: free, min: 1, max: 1 });
  const zone = free.find((z) => zonePick(z) === picks[0]);
  if (zone === undefined) return { ok: false, error: 'No Monster Zone was picked.' };
  return { ok: true, op: { ...op, zone } as ZoneOp, picks };
}
