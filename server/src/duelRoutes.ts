// HTTP API for decks and duels. Players send intents with POST and receive their view as Server-Sent Events.

import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Intent } from '@yugioh/engine';
import type { DeckDetail, DeckSummary } from '@yugioh/shared';
import { loadCards } from './cards.ts';
import type { Db } from './db/client.ts';
import { decks } from './db/schema.ts';
import type { Duels } from './duels.ts';
import { displayName, playerKey, viewerOf, type Viewer } from './viewer.ts';

const id = z.string();
const intent: z.ZodType<Intent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('normalSummon'), card: id, tributes: z.array(id).max(3) }),
  z.object({ type: z.literal('setMonster'), card: id, tributes: z.array(id).max(3) }),
  z.object({ type: z.literal('setSpellTrap'), card: id }),
  z.object({ type: z.literal('flipSummon'), card: id }),
  z.object({ type: z.literal('changePosition'), card: id }),
  z.object({ type: z.literal('enterBattle') }),
  z.object({ type: z.literal('attack'), attacker: id, target: z.union([z.number().int().min(0).max(4), z.literal('direct')]) }),
  z.object({ type: z.literal('enterMain2') }),
  z.object({ type: z.literal('endTurn'), discard: z.array(id).max(60) }),
  z.object({ type: z.literal('surrender') }),
]);

const deckChoice = z.object({ deckId: z.number().int() });

/** How often an idle event stream sends a comment, so proxies don't close it. */
const KEEPALIVE_MS = 25_000;

export function duelRoutes(db: Db, duels: Duels) {
  const router = Router();

  /** Playing needs an approved account or a guest invite. */
  const player = (res: Response): { viewer: Viewer; key: string } | null => {
    const viewer = viewerOf(res);
    const key = playerKey(viewer);
    if (!key) {
      res.status(viewer.kind === 'anonymous' ? 401 : 403).json({ error: 'player_required' });
      return null;
    }
    return { viewer, key };
  };

  /** Guests may only play their inviter; approved users may play anyone's challenge. */
  const mayJoin = (viewer: Viewer, createdBy: number) => viewer.kind === 'user' || (viewer.kind === 'guest' && viewer.invitedById === createdBy);

  router.get('/decks', async (_req, res) => {
    if (!player(res)) return;
    const rows = await db.select().from(decks).orderBy(decks.id);
    res.json(rows.map((d): DeckSummary => ({ id: d.id, name: d.name, mainCount: d.main.length, extraCount: d.extra.length })));
  });

  router.get('/decks/:id', async (req, res) => {
    if (!player(res)) return;
    const deckId = z.coerce.number().int().safeParse(req.params.id);
    const deck = deckId.success ? await db.query.decks.findFirst({ where: eq(decks.id, deckId.data) }) : undefined;
    if (!deck) return void res.status(404).json({ error: 'not_found' });
    const cards = await loadCards(db, [...deck.main, ...deck.extra]);
    res.json({
      id: deck.id,
      name: deck.name,
      main: deck.main.map((c) => cards[c]!),
      extra: deck.extra.map((c) => cards[c]!),
    } satisfies DeckDetail);
  });

  router.get('/duels', async (_req, res) => {
    const p = player(res);
    if (!p) return;
    const challenger = p.viewer.kind === 'guest' ? p.viewer.invitedById : null;
    const rows = await duels.list(p.key, challenger);
    res.json(await Promise.all(rows.map((row) => duels.summarize(row, p.key, mayJoin(p.viewer, row.createdBy)))));
  });

  router.post('/duels', async (req, res) => {
    const p = player(res);
    if (!p) return;
    if (p.viewer.kind !== 'user') return void res.status(403).json({ error: 'account_required' });
    const body = deckChoice.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const duelId = await duels.create(p.viewer.user.id, p.key, body.data.deckId);
    if (!duelId) return void res.status(404).json({ error: 'deck_not_found' });
    res.status(201).json(await duels.summarize((await duels.find(duelId))!, p.key, false));
  });

  router.get('/duels/:id', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const row = await duels.find(req.params.id);
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.json(await duels.summarize(row, p.key, mayJoin(p.viewer, row.createdBy)));
  });

  router.post('/duels/:id/join', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = deckChoice.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !mayJoin(p.viewer, row.createdBy)) return void res.status(404).json({ error: 'not_found' });
    if (!(await db.query.decks.findFirst({ where: eq(decks.id, body.data.deckId) })))
      return void res.status(404).json({ error: 'deck_not_found' });
    const { createdBy } = await duels.summarize(row, null, false);
    const joined = await duels.join(row.id, p.key, body.data.deckId, [createdBy, displayName(p.viewer)]);
    if (!joined) return void res.status(409).json({ error: 'seat_taken' });
    res.json(await duels.summarize((await duels.find(row.id))!, p.key, false));
  });

  // The seat's view of the duel, sent now and after every change.
  router.get('/duels/:id/stream', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const row = await duels.find(req.params.id);
    if (!row || row.status === 'waiting') return void res.status(404).json({ error: 'not_started' });
    const seat = await duels.seatOf(row.id, p.key);
    if (seat === null) return void res.status(403).json({ error: 'not_a_player' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no', // keeps nginx from buffering the stream
    });
    const stop = await duels.watch(row.id, seat, (view) => res.write(`data: ${JSON.stringify(view)}\n\n`));
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      stop();
    });
  });

  router.post('/duels/:id/intents', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = intent.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || row.status === 'waiting') return void res.status(404).json({ error: 'not_started' });
    const result = await duels.act(row.id, p.key, body.data);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(204).end();
  });

  return router;
}
