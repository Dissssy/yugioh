// HTTP API for the deck builder (docs/deck-builder.md): the card catalog, and players' decks.
// Premade decks are public; a player's deck is seen by its owner, or by anyone with the link once it's shared.

import { Router, type Response } from 'express';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { NO_BANLIST, SECTION_SIZE, type Banlist, type DeckDetail, type DeckList, type DeckSummary } from '@yugioh/shared';
import { defaultBanlist, toBanlist, visibleBanlist } from './banlistRoutes.ts';
import { loadCards } from './cards.ts';
import type { Catalog } from './catalog.ts';
import type { Db } from './db/client.ts';
import { decks, matches, type DuelDeck } from './db/schema.ts';
import { builderId } from './viewer.ts';

type DeckRow = typeof decks.$inferSelect;

const codes = (max: number) => z.array(z.number().int()).max(max);
const deckSave = z.object({
  name: z.string().trim().min(1).max(60),
  main: codes(SECTION_SIZE.main.max),
  extra: codes(SECTION_SIZE.extra.max),
  side: codes(SECTION_SIZE.side.max),
  shared: z.boolean(),
  banlistId: z.number().int().nullable(),
});
const deckId = z.coerce.number().int();
/** Which banlist the decks list checks against: the challenge's when picking a deck, otherwise each deck's own. */
const listQuery = z.object({ banlist: z.coerce.number().int().optional(), duel: z.string().optional() });

const listOf = (row: DeckRow): DeckList => ({ main: row.main, extra: row.extra, side: row.side });

/**
 * What keeps a deck out of a duel under the banlist. Premade decks follow the banlist like any deck, but skip the
 * section sizes, since some sets aren't 40 cards.
 */
const problemsOf = (catalog: Catalog, row: DeckRow, banlist: Banlist) => catalog.problems(listOf(row), banlist, row.slug !== null);

/**
 * The deck a player may bring to a duel under its banlist, copied for it: a premade deck, or a deck of their own.
 * `ownerId` is the player's account, null for a guest.
 */
export async function deckForDuel(
  db: Db,
  catalog: Catalog,
  id: number,
  ownerId: number | null,
  banlist: Banlist,
): Promise<DuelDeck | 'not_found' | 'deck_illegal'> {
  const row = await db.query.decks.findFirst({ where: eq(decks.id, id) });
  if (!row || (row.slug === null && (ownerId === null || row.ownerId !== ownerId))) return 'not_found';
  if ((await problemsOf(catalog, row, banlist)).length > 0) return 'deck_illegal';
  return { name: row.name, main: row.main, extra: row.extra };
}

export function deckRoutes(db: Db, catalog: Catalog) {
  const router = Router();

  const builder = (res: Response): number | null => {
    const id = builderId(res);
    if (id === null) res.status(403).json({ error: 'account_required' });
    return id;
  };

  /** The list a deck is built for: its own if it still exists, else the default list. */
  const banlistOf = async (row: DeckRow): Promise<Banlist> => {
    const own = row.banlistId === null ? undefined : await visibleBanlist(db, row.banlistId, row.ownerId);
    const list = own ?? (await defaultBanlist(db));
    return list ? toBanlist(list) : NO_BANLIST;
  };

  const summary = async (row: DeckRow, banlist?: Banlist): Promise<DeckSummary> => ({
    id: row.id,
    name: row.name,
    premade: row.slug !== null,
    mainCount: row.main.length,
    extraCount: row.extra.length,
    sideCount: row.side.length,
    problems: await problemsOf(catalog, row, banlist ?? (await banlistOf(row))),
  });

  /** Card data never changes between imports, so the browser revalidates it with the ETag and usually gets a 304. */
  router.get('/cards', async (req, res) => {
    const data = await catalog.get();
    res.set({ etag: data.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' });
    if (req.fresh) return void res.status(304).end();
    res.type('json');
    if (!req.acceptsEncodings('gzip')) return void res.send(data.json);
    res.set('content-encoding', 'gzip').send(data.gzipped);
  });

  // Visitors opening a challenge link pick a premade deck before deciding to play as a guest; accounts also get theirs.
  router.get('/decks', async (req, res) => {
    const owner = builderId(res);
    const query = listQuery.safeParse(req.query);
    if (!query.success) return void res.status(400).json({ error: 'bad_request' });
    let banlist: Banlist | undefined;
    if (query.data.duel !== undefined) {
      const duel = await db.query.matches.findFirst({ where: eq(matches.id, query.data.duel) });
      if (!duel) return void res.status(404).json({ error: 'not_found' });
      banlist = duel.banlist;
    } else if (query.data.banlist !== undefined) {
      const row = await visibleBanlist(db, query.data.banlist, owner);
      if (!row) return void res.status(404).json({ error: 'not_found' });
      banlist = toBanlist(row);
    }
    const rows = await db
      .select()
      .from(decks)
      .where(owner === null ? isNull(decks.ownerId) : or(isNull(decks.ownerId), eq(decks.ownerId, owner)))
      .orderBy(sql`${decks.ownerId} is null`, asc(decks.id));
    res.json(await Promise.all(rows.map((row) => summary(row, banlist))));
  });

  router.get('/decks/:id', async (req, res) => {
    const id = deckId.safeParse(req.params.id);
    const row = id.success ? await db.query.decks.findFirst({ where: eq(decks.id, id.data) }) : undefined;
    const owner = builderId(res);
    const mine = row !== undefined && row.ownerId !== null && row.ownerId === owner;
    if (!row || !(row.slug !== null || row.shared || mine)) return void res.status(404).json({ error: 'not_found' });
    const cards = await loadCards(db, [...row.main, ...row.extra, ...row.side]);
    res.json({
      id: row.id,
      name: row.name,
      premade: row.slug !== null,
      banlistId: row.banlistId,
      mine,
      shared: row.shared,
      main: row.main.map((c) => cards[c]!),
      extra: row.extra.map((c) => cards[c]!),
      side: row.side.map((c) => cards[c]!),
    } satisfies DeckDetail);
  });

  /**
   * Unknown cards and banlists the owner can't see are refused; anything else is saved, legal or not, since decks are
   * built a card at a time.
   */
  const parse = async (body: unknown, owner: number) => {
    const save = deckSave.safeParse(body);
    if (!save.success) return null;
    const { cards } = await catalog.get();
    const { main, extra, side, banlistId } = save.data;
    if (banlistId !== null && !(await visibleBanlist(db, banlistId, owner))) return null;
    return [...main, ...extra, ...side].every((c) => cards.has(c)) ? save.data : null;
  };

  router.post('/decks', async (req, res) => {
    const owner = builder(res);
    if (owner === null) return;
    const save = await parse(req.body, owner);
    if (!save) return void res.status(400).json({ error: 'bad_request' });
    const [row] = await db.insert(decks).values({ ...save, ownerId: owner }).returning();
    res.status(201).json(await summary(row!));
  });

  router.put('/decks/:id', async (req, res) => {
    const owner = builder(res);
    if (owner === null) return;
    const id = deckId.safeParse(req.params.id);
    const save = await parse(req.body, owner);
    if (!id.success || !save) return void res.status(400).json({ error: 'bad_request' });
    const [row] = await db
      .update(decks)
      .set({ ...save, updatedAt: new Date() })
      .where(and(eq(decks.id, id.data), eq(decks.ownerId, owner)))
      .returning();
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.json(await summary(row));
  });

  router.delete('/decks/:id', async (req, res) => {
    const owner = builder(res);
    if (owner === null) return;
    const id = deckId.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'bad_request' });
    const [row] = await db.delete(decks).where(and(eq(decks.id, id.data), eq(decks.ownerId, owner))).returning({ id: decks.id });
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  return router;
}
