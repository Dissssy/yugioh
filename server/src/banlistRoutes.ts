// Banlists (docs/deck-builder.md, Banlists): the default lists from the card import, and players' own, which work like
// decks: private until shared, and anyone who can see one can copy it.

import { Router, type Response } from 'express';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Banlist, BanlistDetail, BanlistSave, BanlistSummary } from '@yugioh/shared';
import { DEFAULT_BANLISTS } from './cards.ts';
import type { Catalog } from './catalog.ts';
import type { Db } from './db/client.ts';
import { banlists } from './db/schema.ts';
import { builderId } from './viewer.ts';

type BanlistRow = typeof banlists.$inferSelect;

/** The list a deck without one is built for, and a challenge starts with. */
export async function defaultBanlist(db: Db): Promise<BanlistRow | undefined> {
  return db.query.banlists.findFirst({ where: eq(banlists.slug, DEFAULT_BANLISTS[0].slug) });
}

/** A banlist the viewer may use: a default list, one of theirs, or a shared one. */
export async function visibleBanlist(db: Db, id: number, viewerId: number | null): Promise<BanlistRow | undefined> {
  const row = await db.query.banlists.findFirst({ where: eq(banlists.id, id) });
  return row && (row.slug !== null || row.shared || (row.ownerId !== null && row.ownerId === viewerId)) ? row : undefined;
}

export const toBanlist = (row: Pick<BanlistRow, 'name' | 'limits'>): Banlist => ({ name: row.name, limits: row.limits });

const summary = (row: BanlistRow): BanlistSummary => ({
  id: row.id,
  name: row.name,
  isDefault: row.slug !== null,
  slug: row.slug,
  listed: Object.keys(row.limits).length,
});

export function banlistRoutes(db: Db, catalog: Catalog) {
  const router = Router();
  const id = z.coerce.number().int();
  const save = z.object({
    name: z.string().trim().min(1).max(60),
    limits: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(2)),
    shared: z.boolean(),
  });

  const builder = (res: Response): number | null => {
    const owner = builderId(res);
    if (owner === null) res.status(403).json({ error: 'account_required' });
    return owner;
  };

  /** Only cards we have; a list may limit cards that aren't in the game yet. */
  const parse = async (body: unknown): Promise<BanlistSave | null> => {
    const parsed = save.safeParse(body);
    if (!parsed.success) return null;
    const { cards } = await catalog.get();
    return Object.keys(parsed.data.limits).every((c) => cards.has(Number(c))) ? parsed.data : null;
  };

  router.get('/banlists', async (_req, res) => {
    const owner = builderId(res);
    const rows = await db
      .select()
      .from(banlists)
      .where(owner === null ? isNull(banlists.ownerId) : or(isNull(banlists.ownerId), eq(banlists.ownerId, owner)))
      .orderBy(sql`${banlists.ownerId} is not null`, asc(banlists.id));
    res.json(rows.map(summary));
  });

  router.get('/banlists/:id', async (req, res) => {
    const owner = builderId(res);
    const parsed = id.safeParse(req.params.id);
    const row = parsed.success ? await visibleBanlist(db, parsed.data, owner) : undefined;
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.json({ ...summary(row), mine: row.ownerId !== null && row.ownerId === owner, shared: row.shared, limits: row.limits } satisfies BanlistDetail);
  });

  router.post('/banlists', async (req, res) => {
    const owner = builder(res);
    if (owner === null) return;
    const body = await parse(req.body);
    if (!body) return void res.status(400).json({ error: 'bad_request' });
    const [row] = await db.insert(banlists).values({ ...body, ownerId: owner }).returning();
    res.status(201).json(summary(row!));
  });

  router.put('/banlists/:id', async (req, res) => {
    const owner = builder(res);
    if (owner === null) return;
    const parsed = id.safeParse(req.params.id);
    const body = await parse(req.body);
    if (!parsed.success || !body) return void res.status(400).json({ error: 'bad_request' });
    const [row] = await db
      .update(banlists)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(banlists.id, parsed.data), eq(banlists.ownerId, owner)))
      .returning();
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.json(summary(row));
  });

  router.delete('/banlists/:id', async (req, res) => {
    const owner = builder(res);
    if (owner === null) return;
    const parsed = id.safeParse(req.params.id);
    if (!parsed.success) return void res.status(400).json({ error: 'bad_request' });
    const [row] = await db
      .delete(banlists)
      .where(and(eq(banlists.id, parsed.data), eq(banlists.ownerId, owner)))
      .returning({ id: banlists.id });
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  return router;
}
