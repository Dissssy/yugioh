// Asking the judge (docs/ask-the-judge.md). A question is answered by Haiku from what the asking seat can see: its
// view, its log, and the cards it may know, so the answer can't leak a hidden card. An escalation goes to the appeal
// model, which sees the whole board, and decides whether the game is right, a ruling or a card's script is wrong, or a
// rule in code is.

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  cardOf,
  logFor,
  type AskRecord,
  type CardData,
  type DuelEvent,
  type DuelState,
  type EffectSheet,
  type EscalationRecord,
  type LogEntry,
  type ModelUsage,
  type PlayerView,
  type Seat,
} from '@yugioh/engine';
import { boardText, logBlocks } from '../opponent/prompt.ts';
import { movesFor, namesIn } from '../opponent/moves.ts';
import { APPEAL_MODEL } from './appeal.ts';
import { hiddenNameIn } from './hidden.ts';
import { JUDGE_MODEL, type ModelCall } from './judge.ts';
import { usageOf } from './pricing.ts';
import { describeState, RULES } from './prompt.ts';
import { SCRIPT } from './script.ts';

export const ASK_MODEL = JUDGE_MODEL;

const NOT_YET = `What this site doesn't do yet: Fusion, Link and Pendulum Summons, Field Spells, and per-card automatic responses. A response window where a player holds nothing they could activate is passed for them after a short pause.`;

const ASK_SYSTEM = `You answer a player's rules question during an online Yu-Gi-Oh! duel, about the board in front of them. Answer under the official rules, as this site plays them.

How this site works:
- Code runs every generic rule (turns, phases, summons, battle, the chain, response windows, once-per-turn counting) and offers each player only the moves that are legal. A move that isn't offered can't be made.
- Card effects are applied from each card's "effect sheet". An effect with a script is ruled by code exactly as the script says; any other effect is ruled by a judge model that reads the card's text. A script can be wrong; when a player reports a card, its scripts are set aside and the judge rules on it instead.
- ${NOT_YET}

You get the player's deck, the cards they can see with their effect sheets, their duel log, the board as they see it, the moves code offers them now, and code's own reason for each of their effects and attacks it doesn't offer. Code's reasons are facts about what the site does: explain them, never contradict them. If you think code's reason (or a ruling in the log) is wrong under the official rules, say so plainly and set the verdict to game_seems_wrong.

You only know what this player can see. Never guess what is in the opponent's hand, Deck or face-down cards, and never name a card the player can't see.

Answer with JSON:
- answer: at most three plain sentences for the player. Lead with the direct answer.
- verdict: "explained" when the site did the right thing (or the question isn't about something the site got wrong), "game_seems_wrong" when you think the site is wrong, "not_sure" when you can't tell.
- ruling: the # of the ruling in the log the question is about, or null.

The judge's rules reference, for background (you have no tools; you only answer):
${RULES}`;

const answerSchema = z.object({
  answer: z.string(),
  verdict: z.enum(['explained', 'game_seems_wrong', 'not_sure']),
  ruling: z.number().nullable(),
});

/** A card's text and its sheet's effects, as one block of lines for a prompt. */
function cardLines(card: CardData, sheet: EffectSheet | null): string {
  const stats = card.kind === 'monster' ? ` | ${card.attribute ?? ''} ${card.race}${card.level !== null ? `, Level ${card.level}` : ''}, ATK ${card.atk ?? '?'} / DEF ${card.def ?? '?'}` : ` | ${card.race}`;
  const lines = [`- ${card.name} (${card.type}${stats}): ${card.text.replace(/\s+/g, ' ')}`];
  sheet?.effects.forEach((e, i) => {
    const how = e.status === 'flagged' ? 'script set aside after a report, so the judge rules on it' : e.script || e.continuous ? 'code applies it exactly' : 'the judge rules on it';
    lines.push(`  Effect ${i + 1}: ${e.kind}${e.opt !== 'none' ? `, once per turn (${e.opt})` : ''}; window: ${e.window || 'none'}; cost: ${e.cost || 'none'}; does: ${e.effect} [${how}]`);
  });
  return lines.join('\n');
}

export interface AskInput {
  view: PlayerView;
  log: LogEntry[];
  /** Every card the asker may know: what they can see and their own Deck and Extra Deck, with sheets. */
  cards: { card: CardData; sheet: EffectSheet | null }[];
  question: string;
  /** The card asked about (its code), one the asker may know, or null. */
  card: number | null;
  /** The board now, only for the backstop check that the answer names no card the asker can't see. */
  state: DuelState;
}

/** What the asker can do now and code's reasons for what they can't, in words. */
function movesText(view: PlayerView): string {
  const names = namesIn(view);
  const moves = movesFor(view).map((m) => `- ${m.text}`);
  const blocked = view.blocked.map((b) => {
    const what = b.effect === null ? 'attack with it' : `use effect ${b.effect + 1} ("${b.text}")`;
    return `- ${names.get(b.card) ?? 'a card'}: can't ${what}. Code's reason: ${b.reason}`;
  });
  return [`# Moves code offers you now\n${moves.join('\n') || '- none'}`, `# What code doesn't offer you now, and why\n${blocked.join('\n') || '- nothing to report'}`].join('\n\n');
}

export async function askJudge(input: AskInput, model: ModelCall): Promise<AskRecord> {
  const { view, question } = input;
  const log = logBlocks(input.log);
  log[log.length - 1] = { ...log[log.length - 1]!, cache_control: { type: 'ephemeral' } };
  const cards = ['# Cards you know (your deck and every card you can see), with their effect sheets', ...input.cards.map((c) => cardLines(c.card, c.sheet))].join('\n');
  const about = input.card === null ? '' : ` (about ${input.state.cards[input.card]?.name ?? 'a card'})`;
  const now = [boardText(view), movesText(view), `# The question${about}\n${question}`].join('\n\n');
  const usage: ModelUsage[] = [];
  const base = { player: view.you, question, card: input.card, model: ASK_MODEL, usage };
  try {
    const response = await model({
      model: ASK_MODEL,
      max_tokens: 2000,
      // Reasoning off, like the judge: Haiku 5.5 accepts disabled thinking at effort high or below.
      thinking: { type: 'disabled' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: z.toJSONSchema(answerSchema) } },
      system: [{ type: 'text', text: ASK_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: cards, cache_control: { type: 'ephemeral' } }, ...log, { type: 'text', text: now }] }],
    });
    usage.push(usageOf(ASK_MODEL, response));
    if (response.stop_reason === 'refusal') throw new Error('The model declined the request.');
    const text = response.content.find((b) => b.type === 'text');
    const parsed = answerSchema.parse(JSON.parse(text?.type === 'text' ? text.text : 'null'));
    const rulings = new Set(input.log.filter((e) => e.event.type === 'judged').map((e) => e.seq));
    const ruling = parsed.ruling !== null && rulings.has(parsed.ruling) ? parsed.ruling : null;
    // The prompt holds nothing hidden, but the model knows the premade decklists: a guess must not reach the player.
    const leak = hiddenNameIn(input.state, parsed.answer, [view.you]);
    const answer = leak ? 'The answer named a card you can’t see, so it was withheld. Escalate it if you still need an answer.' : clean(parsed.answer);
    return { ...base, answer, verdict: parsed.verdict, ruling, error: leak ? `named a hidden card: ${leak}` : null };
  } catch (error) {
    return { ...base, answer: "The judge couldn't answer just now. Try again in a moment.", verdict: 'not_sure', ruling: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();

const ESCALATE_SYSTEM = `You are the appeal for an online Yu-Gi-Oh! duel, and you know the official rules and rulings well. A player asked a quick rules question during the duel; a small model answered from what that player can see. The player escalated it to you. You see the whole board, including hidden cards.

How this site works:
- Code runs every generic rule (turns, phases, summons, battle, the chain, response windows, once-per-turn counting) and offers each player only the moves that are legal.
- Card effects are applied from each card's effect sheet: a scripted effect is ruled by code exactly as its script says; any other effect by a judge model reading the card's text. Each ruling is a "judged" entry in the log.
- ${NOT_YET}

Decide which is true, under the official rules and this site's limits:
- "game_right": the site did the right thing (the player's expectation is wrong, or the question isn't about a mistake).
- "ruling_wrong": a specific ruling in the player's log (a "judged" entry, by its #) was wrong. It will be contested on the player's behalf, so give its # in "judged".
- "card_wrong": a card's effect sheet makes code do the wrong thing: a script refuses an activation it should allow, allows one it shouldn't, or does the wrong thing, or its window or once-per-turn clause is wrong. Give the card's instance ID in "card". Its scripts will be set aside so the judge rules on it.
- "engine_wrong": a generic rule in code is wrong (phases, summons, battle, chain timing). It is reported to the site's maintainer.

Reply with:
- outcome: one of the four.
- explanation: one or two plain sentences for the player who asked. It must not name any card that player can't see (the opponent's hand, any Deck, the opponent's Extra Deck, face-down cards they don't control); say "a card" instead.
- ruling: the correct ruling in one or two sentences, for the maintainer. Never shown to players; may name any card.
- judged: the ruling's # for ruling_wrong, else null.
- card: the card's instance ID for card_wrong, else null.

The judge's rules reference:
${RULES}`;

const escalationSchema = z.object({
  outcome: z.enum(['game_right', 'ruling_wrong', 'card_wrong', 'engine_wrong']),
  explanation: z.string(),
  ruling: z.string(),
  judged: z.number().nullable(),
  card: z.string().nullable(),
});

const OUTCOME_WORDS: Record<EscalationRecord['outcome'], string> = {
  game_right: 'the game did the right thing',
  ruling_wrong: 'the ruling was wrong, so it is contested for you',
  card_wrong: "the card's script was wrong, so the judge rules on the card now",
  engine_wrong: "a rule in the game's code is wrong; the site's maintainer will fix it",
};

export interface EscalateInput {
  state: DuelState;
  events: readonly DuelEvent[];
  view: PlayerView;
  asked: AskRecord;
  /** The `asked` event's seq. */
  seq: number;
  note: string;
}

export async function escalate(input: EscalateInput, model: ModelCall): Promise<EscalationRecord> {
  const { state, asked } = input;
  const seat: Seat = asked.player;
  const log = logFor(input.events, seat);
  const rulings = new Set(log.filter((e) => e.event.type === 'judged').map((e) => e.seq));
  const judgedText = (seq: number) => {
    const e = input.events[seq];
    if (e?.type !== 'judged') return '';
    const r = e.record;
    return [
      `# Ruling #${seq} (${r.model === SCRIPT ? "made by code from the card's script" : 'made by the judge'})`,
      `${r.stage === 'activation' ? 'Checking the activation' : 'Resolving'} of ${r.card} ${cardOf(state, r.card).name}, effect ${r.effect + 1}: ${r.legal ? 'allowed' : 'refused'}. Summary: ${r.summary}`,
      `Transcript: ${JSON.stringify(r.transcript)}`,
    ].join('\n');
  };
  const sheets = [...new Set(Object.values(state.instances).map((i) => i.code))]
    .filter((code) => state.sheets[code])
    .map((code) => cardLines(state.cards[code]!, state.sheets[code]!))
    .join('\n');
  const request = [
    '# The whole board now, nothing hidden',
    describeState(state),
    `# Every card in the duel with its effect sheet\n${sheets}`,
    `# The log as player ${seat} (who asked) sees it\n${log.filter((e) => e.text).map((e) => `#${e.seq} T${e.turn} ${e.text}`).join('\n')}`,
    movesText(input.view),
    asked.ruling !== null ? judgedText(asked.ruling) : '',
    `# The question, from player ${seat}${asked.card !== null ? ` (about ${state.cards[asked.card]?.name ?? asked.card})` : ''}\n${asked.question}`,
    `# The answer they got\n${asked.answer} (verdict: ${asked.verdict})`,
    `# Their note when escalating\n${input.note.trim() || '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request }];
  const usage: ModelUsage[] = [];
  const base = { player: seat, asked: input.seq, note: input.note, model: APPEAL_MODEL, usage };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await model({
      model: APPEAL_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: z.toJSONSchema(escalationSchema) } },
      system: ESCALATE_SYSTEM,
      messages,
    });
    usage.push(usageOf(APPEAL_MODEL, response));
    if (response.stop_reason === 'refusal') throw new Error('The appeal model declined the request.');
    const text = response.content.find((b) => b.type === 'text');
    const parsed = escalationSchema.parse(JSON.parse(text?.type === 'text' ? text.text : 'null'));
    const badTarget =
      parsed.outcome === 'ruling_wrong' && (parsed.judged === null || !rulings.has(parsed.judged))
        ? `"judged" must be the # of a ruling in player ${seat}'s log (${[...rulings].join(', ') || 'there are none'}).`
        : parsed.outcome === 'card_wrong' && (parsed.card === null || !state.instances[parsed.card])
          ? '"card" must be the instance ID of a card in the duel.'
          : null;
    const leak = hiddenNameIn(state, parsed.explanation, [seat]);
    const record: EscalationRecord = {
      ...base,
      outcome: parsed.outcome,
      explanation: clean(parsed.explanation),
      ruling: clean(parsed.ruling),
      judged: parsed.outcome === 'ruling_wrong' ? parsed.judged : null,
      code: parsed.outcome === 'card_wrong' && parsed.card !== null && state.instances[parsed.card] ? state.instances[parsed.card]!.code : null,
    };
    if (!badTarget && !leak) return record;
    if (attempt === 1) {
      // Still unusable: keep what it found for the maintainer. A wrong target changes nothing in the duel.
      if (badTarget) return { ...record, outcome: 'engine_wrong', judged: null, code: null, explanation: 'The appeal looked at it; the site’s maintainer will check what it found.' };
      return { ...record, explanation: `The appeal found: ${OUTCOME_WORDS[record.outcome]}.` };
    }
    const problems = [badTarget, leak && `Your explanation names ${leak}, which player ${seat} can't see.`].filter(Boolean).join(' ');
    messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: `Please answer again: ${problems}` });
  }
  throw new Error('unreachable');
}
