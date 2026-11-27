// Claude against Claude with real models, to see what a deck surfaces before people play it: both seats are the AI
// opponent (AI_OPPONENT_MODEL), rulings go to the real judge and appeals. Writes each duel's full report to
// eval-runs/self-play/<duel id>.txt and prints what each duel cost.
//
//   ANTHROPIC_API_KEY=... npm run self-play -- yugi-2002 kaiba-2002 [duels, default 2]
//
// The seats swap decks each duel. Needs a database with the cards synced (npm run cards:import).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { NO_BANLIST } from '@yugioh/shared';
import { loadConfig } from '../src/config.ts';
import { duelCosts } from '../src/costs.ts';
import { connect } from '../src/db/client.ts';
import { decks, matches, users } from '../src/db/schema.ts';
import { deckForDuel } from '../src/deckRoutes.ts';
import { Duels } from '../src/duels.ts';
import { matchReport, reportText } from '../src/matchReport.ts';
import { Opponents } from '../src/opponent/opponent.ts';
import { importSheetFiles } from '../src/sheets.ts';

const [slugA, slugB, count = '2'] = process.argv.slice(2);
if (!slugA || !slugB) throw new Error('Usage: npm run self-play -- <premade slug> <premade slug> [duels]');

const config = loadConfig();
if (!config.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY: these duels call the real models.');
const db = connect(config.DATABASE_URL);
await importSheetFiles(db);
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const model = (params: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(params);
const opponent = { call: model, model: config.AI_OPPONENT_MODEL, calls: config.AI_CALLS_PER_DUEL, paceMs: 0 };
const ai = { judge: model, appeal: model, judgeCalls: config.JUDGE_CALLS_PER_DUEL, appeals: config.APPEALS_PER_DUEL, questions: config.QUESTIONS_PER_DUEL, opponent };
const duels = new Duels(db, ai, undefined, 0);
const opponents = new Opponents(duels, db, opponent, 0);
duels.onAiSeat = (id, seat) => void opponents.attach(id, seat);

const deckId = async (slug: string) => {
  const row = await db.query.decks.findFirst({ where: eq(decks.slug, slug) });
  if (!row) throw new Error(`No premade deck "${slug}"`);
  return row.id;
};
const pair = [await deckId(slugA), await deckId(slugB)];
const [owner] = await db
  .insert(users)
  .values({ auth0Sub: 'self-play', username: 'Self-play', status: 'approved', role: 'admin' })
  .onConflictDoUpdate({ target: users.auth0Sub, set: { status: 'approved' } })
  .returning();

const out = join(import.meta.dirname, '../eval-runs/self-play');
await mkdir(out, { recursive: true });
for (let n = 0; n < Number(count); n++) {
  const id = await duels.create(owner!.id, 'ai:a', 'Claude A', NO_BANLIST, true, null);
  await duels.join(id, async () => ({ key: 'ai:b', name: 'Claude B' }));
  for (const [key, deck] of [['ai:a', pair[n % 2]!], ['ai:b', pair[(n + 1) % 2]!]] as const) {
    const copy = (await deckForDuel(db, deck, null))!;
    await duels.setDeck(id, key, () => copy);
    await duels.ready(id, key, true, async () => []);
  }
  // Loading the duel starts both AI seats.
  await duels.watch(id, 0, 0, () => {});
  const started = Date.now();
  while ((await db.query.matches.findFirst({ where: eq(matches.id, id) }))?.status !== 'finished') {
    if (Date.now() - started > 30 * 60_000) throw new Error(`Duel ${id} didn't finish in 30 minutes`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await writeFile(join(out, `${id}.txt`), reportText((await matchReport(db, id))!));
  const cost = (await duelCosts(db)).byDuel.get(id);
  console.log(`Duel ${id}: ${cost?.aiCalls ?? 0} AI calls, ${cost?.judgeCalls ?? 0} judge calls, ${cost?.appeals ?? 0} appeals, $${(cost?.cost ?? 0).toFixed(3)}`);
}
await db.$client.end();
process.exit(0);
