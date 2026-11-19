// The admin's view of what the judge and appeals cost, priced from the token counts kept in each duel's log.

import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { ModelUsage } from '@yugioh/engine';
import type { CostReport, DuelCost } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { matchEvents, matches, users } from './db/schema.ts';
import { costOf } from './judge/pricing.ts';

export async function costReport(db: Db): Promise<CostReport> {
  const type = sql<'judged' | 'appealed'>`${matchEvents.event}->>'type'`;
  const rows = await db
    .select({
      id: matches.id,
      createdAt: matches.createdAt,
      status: matches.status,
      createdBy: users.username,
      type,
      // Only the token counts, not the transcripts around them.
      usage: sql<ModelUsage[]>`coalesce(${matchEvents.event}->'record'->'usage', ${matchEvents.event}->'appeal'->'usage')`,
    })
    .from(matchEvents)
    .innerJoin(matches, eq(matches.id, matchEvents.matchId))
    .innerJoin(users, eq(users.id, matches.createdBy))
    .where(inArray(type, ['judged', 'appealed']))
    .orderBy(desc(matches.createdAt));

  const duels = new Map<string, DuelCost>();
  for (const r of rows) {
    let duel = duels.get(r.id);
    if (!duel) {
      duel = { id: r.id, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy, status: r.status, judgeCalls: 0, appeals: 0, cost: 0 };
      duels.set(r.id, duel);
    }
    if (r.type === 'judged') duel.judgeCalls++;
    else duel.appeals++;
    duel.cost += costOf(r.usage);
  }
  const list = [...duels.values()];
  return { total: list.reduce((n, d) => n + d.cost, 0), duels: list };
}
