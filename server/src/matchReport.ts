// A whole duel for review after the fact: every event with nothing hidden, including intents, rulings, appeals
// and chat. Only the admin may read it, through the admin API or `npm run duel:report -- <duel id>`.

import { eq } from 'drizzle-orm';
import { reviewLog, type DuelEvent } from '@yugioh/engine';
import type { Db } from './db/client.ts';
import { costOf } from './judge/pricing.ts';
import { decks, matchEvents, matches } from './db/schema.ts';

export interface MatchReport {
  id: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  seats: [string, string | null];
  decks: [string | null, string | null];
  /** Every stored event, with the time it was stored. Judge records carry their whole transcript. */
  events: { seq: number; at: string; event: DuelEvent }[];
}

export async function matchReport(db: Db, id: string): Promise<MatchReport | null> {
  const row = await db.query.matches.findFirst({ where: eq(matches.id, id) });
  if (!row) return null;
  const rows = await db.select().from(matchEvents).where(eq(matchEvents.matchId, id)).orderBy(matchEvents.seq);
  const deckName = async (deck: number | null) =>
    deck === null ? null : ((await db.query.decks.findFirst({ where: eq(decks.id, deck) }))?.name ?? null);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    seats: [row.seat0, row.seat1],
    decks: [await deckName(row.deck0), await deckName(row.deck1)],
    events: rows.map((r) => ({ seq: r.seq, at: r.createdAt.toISOString(), event: r.event as DuelEvent })),
  };
}

/** The report as plain text: a header, then one line per event as `#seq time T<turn> text`. */
export function reportText(report: MatchReport): string {
  const events = report.events.map((e) => e.event);
  const judged = events.filter((e) => e.type === 'judged').length;
  const appeals = events.filter((e) => e.type === 'appealed').length;
  const chat = events.filter((e) => e.type === 'chatted').length;
  const header = [
    `Duel ${report.id} (${report.status})`,
    `Created ${report.createdAt}${report.finishedAt ? `, finished ${report.finishedAt}` : ''}`,
    `Seat 0: ${report.seats[0]} with ${report.decks[0] ?? '?'}`,
    `Seat 1: ${report.seats[1] ?? 'empty'} with ${report.decks[1] ?? '?'}`,
    `${events.length} events, ${judged} judge calls, ${appeals} appeals, ${chat} chat messages`,
    `Estimated API cost: $${costOf(events.flatMap((e) => (e.type === 'judged' ? e.record.usage : e.type === 'appealed' ? e.appeal.usage : []))).toFixed(4)}`,
    '',
  ];
  if (events.length === 0) return header.join('\n');
  const lines = reviewLog(events).map(({ seq, turn, text }) => {
    const event = events[seq]!;
    const extra = event.type === 'judged' ? judgeExchanges(event.record.transcript) : [];
    return [`#${seq} ${report.events[seq]!.at.slice(11, 19)} T${turn} ${text}`, ...extra.map((line) => `    ${line}`)].join('\n');
  });
  return [...header, ...lines, ''].join('\n');
}

type Block = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

/**
 * What the judge asked the players and what they picked, and the tool calls code refused, read from a judge
 * transcript (Anthropic messages). The JSON report has the whole transcript.
 */
function judgeExchanges(transcript: unknown[]): string[] {
  // Each message's tool results answer the calls of the message before it.
  let calls = new Map<string | undefined, Block>();
  return transcript.flatMap((m) => {
    const content = (m as { content?: unknown }).content;
    const blocks = Array.isArray(content) ? (content as Block[]) : [];
    const lines = blocks.flatMap((b) => {
      if (b.type !== 'tool_result') return [];
      const call = calls.get(b.tool_use_id);
      const result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      if (b.is_error) return [`Refused ${call?.name} ${JSON.stringify(call?.input)}: ${result}`];
      if (call?.name === 'ask_player') return [`Asked ${JSON.stringify(call.input)}: ${result}`];
      return [];
    });
    calls = new Map(blocks.filter((b) => b.type === 'tool_use').map((b) => [b.id, b]));
    return lines;
  });
}

if (import.meta.main) {
  const id = process.argv[2];
  const json = process.argv.includes('--json');
  if (!id) throw new Error('Usage: npm run duel:report -- <duel id> [--json]');
  const { connect } = await import('./db/client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  const report = await matchReport(db, id);
  await db.$client.end();
  if (!report) throw new Error(`No duel ${id}`);
  process.stdout.write(json ? JSON.stringify(report, null, 2) : reportText(report));
}
