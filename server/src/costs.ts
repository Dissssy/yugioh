// What the judge and appeals cost, priced from the token counts kept in each duel's log. Admin only.

import { inArray, sql } from 'drizzle-orm';
import type { ModelUsage } from '@yugioh/engine';
import type { DuelCost } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { matchEvents } from './db/schema.ts';
import { costOf } from './judge/pricing.ts';
import { SCRIPT } from './judge/script.ts';

/** Every duel's judge calls, appeals and cost (duels that never used the judge are absent), and the total of all. */
export async function duelCosts(db: Db): Promise<{ total: number; byDuel: Map<string, DuelCost> }> {
  const type = sql<'judged' | 'appealed'>`${matchEvents.event}->>'type'`;
  const rows = await db
    .select({
      id: matchEvents.matchId,
      type,
      // Only the token counts, not the transcripts around them.
      model: sql<string | null>`${matchEvents.event}->'record'->>'model'`,
      usage: sql<ModelUsage[] | null>`coalesce(${matchEvents.event}->'record'->'usage', ${matchEvents.event}->'appeal'->'usage')`,
    })
    .from(matchEvents)
    .where(inArray(type, ['judged', 'appealed']));

  const byDuel = new Map<string, DuelCost>();
  let total = 0;
  for (const r of rows) {
    // A ruling a script made called no model.
    if (r.type === 'judged' && r.model === SCRIPT) continue;
    const duel = byDuel.get(r.id) ?? { judgeCalls: 0, appeals: 0, cost: 0 };
    byDuel.set(r.id, duel);
    if (r.type === 'judged') duel.judgeCalls++;
    else duel.appeals++;
    if (!r.usage) throw new Error(`Duel ${r.id} has a ${r.type} event without token counts, logged before costs were tracked. Delete that duel.`);
    const cost = costOf(r.usage);
    duel.cost += cost;
    total += cost;
  }
  return { total, byDuel };
}
