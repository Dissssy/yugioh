// HTTP API for decks and duels. Players send intents with POST and receive their view and its changes as Server-Sent Events.
// A challenge link is also the way in for people without an account: joining it signed out creates a guest.

import { gzipSync } from 'node:zlib';
import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { HANDS, type Intent } from '@yugioh/engine';
import { isAdmin, isSideSwap, SECTION_SIZE, type DuelDeckSave, type DuelPrep } from '@yugioh/shared';
import type { Catalog } from './catalog.ts';
import type { Db } from './db/client.ts';
import { defaultBanlist, toBanlist, visibleBanlist } from './banlistRoutes.ts';
import { deckForDuel } from './deckRoutes.ts';
import { started, type Duels, type SeatClaim } from './duels.ts';
import { createGuest } from './guests.ts';
import { displayName, guestKey, guestName, placeOfRes, playerKey, viewerOf, type Viewer } from './viewer.ts';

const id = z.string();
const intent: z.ZodType<Intent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('normalSummon'), card: id, tributes: z.array(id).max(3), zone: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('setMonster'), card: id, tributes: z.array(id).max(3), zone: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('setSpellTrap'), card: id, zone: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('extraSummon'), card: id, materials: z.array(id).min(1).max(7), zone: z.number().int().min(0).max(6), position: z.enum(['attack', 'defense']) }),
  z.object({ type: z.literal('flipSummon'), card: id }),
  z.object({ type: z.literal('changePosition'), card: id }),
  z.object({ type: z.literal('enterBattle') }),
  z.object({ type: z.literal('attack'), attacker: id, target: z.union([z.number().int().min(0).max(6), z.literal('direct')]) }),
  z.object({ type: z.literal('enterMain2') }),
  z.object({ type: z.literal('endTurn'), discard: z.array(id).max(60) }),
  z.object({ type: z.literal('activate'), card: id, effect: z.number().int().min(0).max(9), zone: z.number().int().min(0).max(4).nullable() }),
  z.object({ type: z.literal('pass') }),
  z.object({ type: z.literal('rps'), hand: z.enum(HANDS) }),
  z.object({ type: z.literal('chooseOrder'), goFirst: z.boolean() }),
  z.object({ type: z.literal('replace'), materials: z.array(z.string()) }),
  z.object({ type: z.literal('tax'), discard: id.nullable() }),
  z.object({ type: z.literal('rollback'), accept: z.boolean() }),
  z.object({ type: z.literal('surrender') }),
]);

const answerBody = z.object({ prompt: z.string(), picks: z.array(z.string()).max(60) });
const chatBody = z.object({ text: z.string().trim().min(1).max(300) });
const askBody = z.object({ text: z.string().trim().min(1).max(500), card: z.number().int().nullable().default(null) });
const escalateBody = z.object({ seq: z.number().int().min(0), note: z.string().max(500).default('') });
const contestBody = z.object({ seq: z.number().int().min(0), note: z.string().max(500).default('') });
const reportBody = z.object({ code: z.number().int(), note: z.string().trim().min(1).max(1000) });

/** A challenge names the banlist both decks follow (the default list if none), and whether decks must be premade. */
const challengeBody = z.object({ banlistId: z.number().int().optional(), premadeOnly: z.boolean().default(false) });
const codes = (max: number) => z.array(z.number().int()).max(max);
const deckBody: z.ZodType<DuelDeckSave> = z.union([
  z.object({ deckId: z.number().int() }),
  z.object({ name: z.string().trim().min(1).max(60), main: codes(SECTION_SIZE.main.max), extra: codes(SECTION_SIZE.extra.max), side: codes(SECTION_SIZE.side.max) }),
]);
const readyBody = z.object({ ready: z.boolean() });
const replayFrom = z.enum(['0', '1', 'both']).transform((v) => (v === 'both' ? v : (Number(v) as 0 | 1)));
/** The seat a spectator has at the bottom of the board. */
const watchFrom = z.enum(['0', '1']).transform((v) => Number(v) as 0 | 1);
/** Signed-out visitors also give the name they play under as a guest. */
const joinBody = z.object({ guestName: z.string().trim().min(1).max(30).optional() });

/** Sets and clears the cookie that holds a guest's token. */
export interface GuestCookie {
  set(res: Response, token: string): void;
  clear(res: Response): void;
}

/** How often an idle event stream sends a comment, so proxies don't close it. */
const KEEPALIVE_MS = 25_000;

export function duelRoutes(db: Db, catalog: Catalog, duels: Duels, guestCookie: GuestCookie) {
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
    const body = challengeBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const banlist = await (body.data.banlistId === undefined ? defaultBanlist(db) : visibleBanlist(db, body.data.banlistId, p.viewer.user.id));
    if (!banlist) return void res.status(404).json({ error: "That banlist doesn't exist." });
    // A challenge made in the Discord Activity goes on the tables of the server (or DM) it was opened in.
    const duelId = await duels.create(p.viewer.user.id, p.key, displayName(p.viewer), toBanlist(banlist), body.data.premadeOnly, placeOfRes(res));
    res.status(201).json(await duels.summarize((await duels.find(duelId))!, p.key, false));
  });

  // The Discord Activity's tables (docs/discord.md): every duel started where the Activity was opened, to join or watch.
  router.get('/tables', async (_req, res) => {
    const viewer = viewerOf(res);
    const place = placeOfRes(res);
    if (place === null) return void res.status(404).json({ error: 'Tables are only in the Discord Activity.' });
    const rows = await duels.tables(place);
    res.json(await Promise.all(rows.map((row) => duels.summarize(row, playerKey(viewer), mayJoin(viewer)))));
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
    if (!(await duels.join(row.id, claim))) return void res.status(409).json({ error: 'Someone else took the seat.' });
    if (created.guestToken) guestCookie.set(res, created.guestToken);
    const joined = (await duels.find(row.id))!;
    res.json(await duels.summarize(joined, joined.seat1, false));
  });

  // The pre-duel stage (docs/deck-builder.md): each player's copy of their deck for this duel, and Ready.
  router.get('/duels/:id/deck', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const row = await duels.find(req.params.id);
    const seat = row && (await duels.seatOf(row.id, p.key));
    if (!row || seat === null || seat === undefined) return void res.status(404).json({ error: 'not_found' });
    res.json({ deck: seat === 0 ? row.deck0 : row.deck1, banlist: row.banlist } satisfies DuelPrep);
  });

  router.put('/duels/:id/deck', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = deckBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const save = body.data;
    let next: Parameters<Duels['setDeck']>[2];
    if ('deckId' in save) {
      const picked = await deckForDuel(db, save.deckId, p.viewer.kind === 'user' ? p.viewer.user.id : null);
      if (!picked) return void res.status(404).json({ error: "That deck doesn't exist." });
      next = (row) => (row.premadeOnly && !picked.premade ? 'This challenge is for premade decks only.' : picked);
    } else {
      const list = { main: save.main, extra: save.extra, side: save.side };
      const { cards } = await catalog.get();
      if (![...list.main, ...list.extra, ...list.side].every((c) => cards.has(c))) return void res.status(422).json({ error: "That deck has a card that doesn't exist." });
      next = (row, current) => {
        // A premade deck stays premade through Side Deck swaps; any other change makes it the player's own.
        const swap = current !== null && isSideSwap(current, list);
        if (row.premadeOnly && !swap) return 'This challenge is for premade decks only: swap cards with the Side Deck one for one.';
        return { name: save.name, ...list, premade: swap && current.premade };
      };
    }
    const result = await duels.setDeck(req.params.id, p.key, next);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ deck: result.deck });
  });

  router.post('/duels/:id/ready', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = readyBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const result = await duels.ready(req.params.id, p.key, body.data.ready, (deck, banlist) => catalog.problems(deck, banlist, deck.premade));
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json(await duels.summarize((await duels.find(req.params.id))!, p.key, false));
  });

  // The duel as the viewer may see it, sent now and after every change: a player's own seat, or for anyone else
  // holding the link, only what both players can see (`?from=0|1` picks the seat at the bottom).
  router.get('/duels/:id/stream', async (req, res) => {
    const from = watchFrom.safeParse(req.query.from ?? '0');
    if (!from.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
    const key = playerKey(viewerOf(res));
    const seat = key === null ? null : await duels.seatOf(row.id, key);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no', // keeps nginx from buffering the stream
    });
    const stop = await duels.watch(row.id, seat ?? from.data, seat ?? 'none', (update) => res.write(`data: ${JSON.stringify(update)}\n\n`));
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      stop();
    });
  });

  // A finished duel to watch again, by anyone holding the link, from either seat or with every card face up
  // (`?from=0|1|both`). Questions to the judge stay private to the player who asked; admins see them all.
  router.get('/duels/:id/replay', async (req, res) => {
    const viewer = viewerOf(res);
    const from = replayFrom.safeParse(req.query.from ?? '0');
    if (!from.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || row.status !== 'finished') return void res.status(404).json({ error: 'not_finished' });
    const admin = viewer.kind === 'user' && isAdmin(viewer.user.role);
    const key = playerKey(viewer);
    const seat = key === null ? null : await duels.seatOf(row.id, key);
    // A few hundred steps that each carry the whole board: about a megabyte as JSON, a tenth of that compressed.
    const body = JSON.stringify(await duels.replay(row.id, from.data, admin ? 'both' : seat));
    res.type('json');
    if (!req.acceptsEncodings('gzip')) return void res.send(body);
    res.set({ 'content-encoding': 'gzip', vary: 'accept-encoding' }).send(gzipSync(body));
  });

  router.post('/duels/:id/intents', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = intent.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
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
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
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
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
    const result = await duels.contest(row.id, p.key, body.data.seq, body.data.note);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(202).end();
  });

  // A question to the judge (docs/ask-the-judge.md). The answer arrives later in the asker's log only.
  router.post('/duels/:id/ask', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = askBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
    const result = await duels.ask(row.id, p.key, body.data.text, body.data.card);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(202).end();
  });

  // Escalates the question at log entry `seq` to the appeal model. Its finding arrives later in the asker's log.
  router.post('/duels/:id/escalate', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = escalateBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
    const result = await duels.escalate(row.id, p.key, body.data.seq, body.data.note);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(202).end();
  });

  // Reports that a card is ruled wrongly. Its scripts are set aside at once; the admin sees the report.
  router.post('/duels/:id/report', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = reportBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
    const result = await duels.report(row.id, p.key, body.data.code, body.data.note);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(204).end();
  });

  // A chat message, which joins the duel log for both players.
  router.post('/duels/:id/chat', async (req, res) => {
    const p = player(res);
    if (!p) return;
    const body = chatBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const row = await duels.find(req.params.id);
    if (!row || !started(row)) return void res.status(404).json({ error: 'not_started' });
    const result = await duels.chat(row.id, p.key, body.data.text);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(204).end();
  });

  return router;
}
