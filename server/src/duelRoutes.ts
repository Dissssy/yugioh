// HTTP API for decks and duels. Players send intents with POST and receive their view and its changes as Server-Sent Events.
// A challenge link is also the way in for people without an account: joining it signed out creates a guest.

import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Intent } from '@yugioh/engine';
import type { DeckDetail, DeckSummary } from '@yugioh/shared';
import { loadCards } from './cards.ts';
import type { Db } from './db/client.ts';
import { decks } from './db/schema.ts';
import type { Duels, SeatClaim } from './duels.ts';
import { createGuest } from './guests.ts';
import { displayName, guestKey, guestName, playerKey, viewerOf, type Viewer } from './viewer.ts';

const id = z.string();
const intent: z.ZodType<Intent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('normalSummon'), card: id, tributes: z.array(id).max(3), zone: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('setMonster'), card: id, tributes: z.array(id).max(3), zone: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('setSpellTrap'), card: id, zone: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('flipSummon'), card: id }),
  z.object({ type: z.literal('changePosition'), card: id }),
  z.object({ type: z.literal('enterBattle') }),
  z.object({ type: z.literal('attack'), attacker: id, target: z.union([z.number().int().min(0).max(4), z.literal('direct')]) }),
  z.object({ type: z.literal('enterMain2') }),
  z.object({ type: z.literal('endTurn'), discard: z.array(id).max(60) }),
  z.object({ type: z.literal('activate'), card: id, effect: z.number().int().min(0).max(9), zone: z.number().int().min(0).max(4).nullable() }),
  z.object({ type: z.literal('surrender') }),
]);

const answerBody = z.object({ prompt: z.string(), picks: z.array(z.string()).max(60) });
const chatBody = z.object({ text: z.string().trim().min(1).max(300) });
const contestBody = z.object({ seq: z.number().int().min(0), note: z.string().max(500).default('') });

const deckChoice = z.object({ deckId: z.number().int() });
/** Signed-out visitors also give the name they play under as a guest. */
const joinBody = deckChoice.extend({ guestName: z.string().trim().min(1).max(30).optional() });

/** Sets and clears the cookie that holds a guest's token. */
export interface GuestCookie {
  set(res: Response, token: string): void;
  clear(res: Response): void;
}

/** How often an idle event stream sends a comment, so proxies don't close it. */
const KEEPALIVE_MS = 25_000;

export function duelRoutes(db: Db, duels: Duels, guestCookie: GuestCookie) {
  const router = Router();

  /** Playing needs an approved account or a guest identity. */
  const player = (res: Response): { viewer: Viewer; key: string } | null => {
    const viewer = viewerOf(res);
    const key = playerKey(viewer);
    if (!key) {
      res.status(viewer.kind === 'anonymous' ? 401 : 403).json({ error: 'player_required' });
      return null;
    }
    return { viewer, key };
  };

  /** Players can take an empty seat, and so can signed-out visitors, who become guests by doing so. */
  const mayJoin = (viewer: Viewer) => viewer.kind === 'anonymous' || playerKey(viewer) !== null;

  // Decks are public: a visitor opening a challenge link picks one before deciding to play as a guest.
  router.get('/decks', async (_req, res) => {
    const rows = await db.select().from(decks).orderBy(decks.id);
    res.json(rows.map((d): DeckSummary => ({ id: d.id, name: d.name, mainCount: d.main.length, extraCount: d.extra.length })));
  });

  router.get('/decks/:id', async (req, res) => {
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
    const rows = await duels.list(p.key);
    res.json(await Promise.all(rows.map((row) => duels.summarize(row, p.key, true))));
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

  // Anyone holding the link may look at a duel; the random ID is what keeps it private.
  router.get('/duels/:id', async (req, res) => {
    const viewer = viewerOf(res);
    const row = await duels.find(req.params.id);
    if (!row) return void res.status(404).json({ error: 'not_found' });
    res.json(await duels.summarize(row, playerKey(viewer), mayJoin(viewer)));
  });

  router.post('/duels/:id/join', async (req, res) => {
    const viewer = viewerOf(res);
    const body = joinBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    let claim: SeatClaim;
    const created: { guestToken?: string } = {};
    if (viewer.kind === 'anonymous') {
      const name = body.data.guestName;
      if (!name) return void res.status(401).json({ error: 'player_required' });
      claim = async (tx) => {
        const guest = await createGuest(tx, name);
        created.guestToken = guest.token;
        return { key: guestKey(guest.id), name: guestName(guest.name) };
      };
    } else {
      const p = player(res);
      if (!p) return;
      claim = async () => ({ key: p.key, name: displayName(p.viewer) });
    }
    const row = await duels.find(req.params.id);
    if (!row) return void res.status(404).json({ error: 'not_found' });
    if (!(await db.query.decks.findFirst({ where: eq(decks.id, body.data.deckId) })))
      return void res.status(404).json({ error: 'deck_not_found' });
    const { createdBy } = await duels.summarize(row, null, false);
    if (!(await duels.join(row.id, body.data.deckId, createdBy, claim))) return void res.status(409).json({ error: 'seat_taken' });
    if (created.guestToken) guestCookie.set(res, created.guestToken);
    const started = (await duels.find(row.id))!;
    res.json(await duels.summarize(started, started.seat1, false));
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
    const stop = await duels.watch(row.id, seat, (update) => res.write(`data: ${JSON.stringify(update)}\n\n`));
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

  // The answer to the judge's open question (a PromptView): the picked card IDs or choices.
  router.post('/duels/:id/answer', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = answerBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || row.status === 'waiting') return void res.status(404).json({ error: 'not_started' });
    const result = await duels.answer(row.id, p.key, body.data.prompt, body.data.picks);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(204).end();
  });

  // Contests the judge decision at log entry `seq`. The appeal's verdict arrives later as a log entry.
  router.post('/duels/:id/contest', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = contestBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || row.status === 'waiting') return void res.status(404).json({ error: 'not_started' });
    const result = await duels.contest(row.id, p.key, body.data.seq, body.data.note);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(202).end();
  });

  // A chat message, which joins the duel log for both players.
  router.post('/duels/:id/chat', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = chatBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || row.status === 'waiting') return void res.status(404).json({ error: 'not_started' });
    const result = await duels.chat(row.id, p.key, body.data.text);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(204).end();
  });

  return router;
}
