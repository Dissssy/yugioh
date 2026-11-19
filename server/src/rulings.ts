// The admin's side of rulings: the cards players reported or appeals overturned, and the sheet edits that settle them.

import { eq, inArray, isNull } from 'drizzle-orm';
import type { EffectSheet } from '@yugioh/engine';
import type { RulingCard } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { cards, effectSheets, sheetReports } from './db/schema.ts';
import { saveSheet, sheetSchema, textHash } from './sheets.ts';

/** Cards with open reports or with scripts set aside, those with reports first. */
export async function rulingCards(db: Db): Promise<RulingCard[]> {
  const reports = await db.select().from(sheetReports).where(isNull(sheetReports.resolvedAt)).orderBy(sheetReports.createdAt);
  const sheets = new Map((await db.select().from(effectSheets)).map((r) => [r.code, r.sheet]));
  const flagged = [...sheets.values()].filter((s) => s.effects.some((e) => e.status === 'flagged')).map((s) => s.code);
  const codes = [...new Set([...reports.map((r) => r.code), ...flagged])];
  if (!codes.length) return [];
  const rows = await db.select({ id: cards.id, name: cards.name, text: cards.text }).from(cards).where(inArray(cards.id, codes));
  const byCode = new Map(rows.map((r) => [r.id, r]));
  return codes.map((code) => ({
    code,
    name: byCode.get(code)!.name,
    text: byCode.get(code)!.text,
    sheet: sheets.get(code) ?? null,
    reports: reports
      .filter((r) => r.code === code)
      .map((r) => ({ id: r.id, matchId: r.matchId, seq: r.seq, from: r.reporter === 'appeal' ? 'appeal' : 'player', note: r.note, createdAt: r.createdAt.toISOString() })),
  }));
}

/**
 * Stores the admin's version of a card's sheet. It must be for that card's current text. Returns the saved sheet,
 * or why it was refused.
 */
export async function editSheet(db: Db, code: number, body: unknown, note: string): Promise<{ sheet: EffectSheet } | { error: string }> {
  const parsed = sheetSchema.safeParse(body);
  if (!parsed.success) return { error: `The sheet is not valid: ${parsed.error.message}` };
  const card = await db.query.cards.findFirst({ where: eq(cards.id, code) });
  if (!card) return { error: 'There is no such card.' };
  if (parsed.data.code !== code || parsed.data.textHash !== textHash(card.text)) return { error: "The sheet is not for this card's current text." };
  const sheet = { ...parsed.data, model: 'admin' };
  await saveSheet(db, sheet, `admin: ${note}`);
  return { sheet };
}

/** Closes a report. Returns false if there is no such report. */
export async function resolveReport(db: Db, id: number): Promise<boolean> {
  const rows = await db.update(sheetReports).set({ resolvedAt: new Date() }).where(eq(sheetReports.id, id)).returning({ id: sheetReports.id });
  return rows.length > 0;
}
