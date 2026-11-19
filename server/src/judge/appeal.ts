// A contest: a stronger model, thinking, re-examines one judge decision against the board it was made on.
// It upholds or overturns the decision and explains why in a sentence or two both players can read.
// Rollback on an overturn comes with layer 6; for now the verdict is shown and stored as a candidate ruling.

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AppealRecord, DuelState, JudgeRecord, ModelUsage, Seat } from '@yugioh/engine';
import { hiddenNameIn } from './hidden.ts';
import type { ModelCall } from './judge.ts';
import { usageOf } from './pricing.ts';
import { describeEffect, describeState, RULES } from './prompt.ts';

export const APPEAL_MODEL = 'claude-opus-5-5';

const verdict = z.object({
  verdict: z.enum(['upheld', 'overturned']),
  explanation: z.string(),
  ruling: z.string(),
});

const SYSTEM = `You review a contested decision by the runtime judge of an online Yu-Gi-Oh! duel. The judge (a small model) follows the rules reference below; you are the appeal, and you know the official Yu-Gi-Oh! rules and rulings well.

You get the board as it was just before the decision, the card's text, the judge's full transcript (its tool calls, the code's answers, and the players' answers to its questions) and the contesting player's note. Decide whether the decision was correct under the official rules and the limits of this version of the game, as the reference describes them (no responses or chains yet, the op vocabulary it lists). Players contest wrongly too: uphold a correct decision even if the note is confident.

Reply with:
- verdict: "upheld" or "overturned".
- explanation: one or two plain sentences for both players. It must not name any card that either player can't see (cards in hands, Decks, Extra Decks or face-down); say "a card" instead.
- ruling: the correct ruling for this situation in one or two sentences, for the people who maintain the judge. This is never shown to players and may name any card.

The judge's rules reference:
${RULES}`;

export interface AppealInput {
  /** The board just before the decision. */
  before: DuelState;
  /** The board now, for the hidden-information check of the explanation. */
  now: DuelState;
  record: JudgeRecord;
  judged: number;
  by: Seat;
  note: string;
}

export async function appeal(input: AppealInput, model: ModelCall): Promise<AppealRecord> {
  const { before, record } = input;
  const link = { player: record.player, card: record.card, effect: record.effect, targets: [], choice: null };
  const request = [
    '# Board before the decision',
    describeState(before),
    '',
    '# The effect',
    describeEffect(before, link),
    '',
    `# The decision (${record.stage === 'activation' ? 'checking the activation' : 'resolving the effect'})`,
    `Outcome: ${record.stage === 'activation' ? (record.legal ? 'activation allowed' : 'activation refused') : 'resolved'}. Summary shown to players: ${record.summary}`,
    record.error ? `The judge failed: ${record.error}` : '',
    'Transcript:',
    JSON.stringify(record.transcript),
    '',
    `# Contest by player ${input.by}`,
    input.note.trim() || '(no note)',
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request }];
  const usage: ModelUsage[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await model({
      model: APPEAL_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: z.toJSONSchema(verdict) } },
      system: SYSTEM,
      messages,
    });
    usage.push(usageOf(APPEAL_MODEL, response));
    if (response.stop_reason === 'refusal') throw new Error('The appeal model declined the request.');
    const text = response.content.find((b) => b.type === 'text');
    const parsed = verdict.parse(JSON.parse(text?.type === 'text' ? text.text : 'null'));
    const leak = hiddenNameIn(input.now, parsed.explanation, [0, 1]);
    const result = { judged: input.judged, by: input.by, note: input.note, model: APPEAL_MODEL, ...parsed, usage };
    if (!leak) return result;
    if (attempt === 1) return { ...result, explanation: `The appeal ${parsed.verdict === 'upheld' ? 'upheld' : 'overturned'} the ruling.` };
    messages.push(
      { role: 'assistant', content: response.content },
      { role: 'user', content: `Your explanation names ${leak}, which a player can't see. Answer again without naming hidden cards.` },
    );
  }
  throw new Error('unreachable');
}
