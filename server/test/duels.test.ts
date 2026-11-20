import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuelUpdate, Intent, PlayerView } from '@yugioh/engine';
import type { AdminDuels, AdminUser, DeckDetail, DeckSummary, DuelSummary, Me, Replay } from '@yugioh/shared';
import { syncCards } from '../src/cards.ts';
import { and, eq } from 'drizzle-orm';
import { guests, matchEvents } from '../src/db/schema.ts';
import { deleteIdleGuests, GUEST_GRACE_MS } from '../src/guests.ts';
import { ADMIN_EMAIL, Browser, startHarness, Stream, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

async function login(claims: Parameters<Harness['setIdentity']>[0], browser = new Browser()) {
  h.setIdentity(claims);
  await browser.fetch(`${h.baseUrl}/auth/login`);
  return browser;
}

const me = (b: Browser) => b.json<Me>(`${h.baseUrl}/api/me`).then((r) => r.body);
const guestCount = async () => (await h.db.select().from(guests)).length;

describe('card data', () => {
  it('imports cards, builds both starter decks from their sets and downloads their images', async () => {
    await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
    const admin = await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
    const { body: decks } = await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`);
    expect(decks.map((d) => [d.name, d.mainCount, d.extraCount])).toEqual([
      ["Yu-Gi-Oh! 5D's Starter Deck (2008)", 40, 3],
      ['Starter Deck: Dawn of the Xyz', 40, 3],
    ]);
    const { body: xyz } = await admin.json<DeckDetail>(`${h.baseUrl}/api/decks/${decks[1]!.id}`);
    expect(xyz.main[0]!.name).toBe('Spirit of the Harp');
    expect(xyz.extra.map((c) => c.name)).toEqual(['Number 39: Utopia', 'Gachi Gachi Gantetsu', 'Grenosaurus']);
    expect(xyz.extra.every((c) => c.extraDeck)).toBe(true);
    expect(existsSync(join(h.imageDir, `${xyz.main[0]!.code}.jpg`))).toBe(true);
    expect(existsSync(join(h.imageDir, 'small', `${xyz.main[0]!.code}.jpg`))).toBe(true);
    expect((await admin.fetch(`${h.baseUrl}/card-images/small/${xyz.main[0]!.code}.jpg`)).status).toBe(200);
  });

  it('shows decks to anyone, so a visitor can pick one from a challenge link', async () => {
    expect((await new Browser().json(`${h.baseUrl}/api/decks`)).status).toBe(200);
  });
});

describe('a challenge link played by a guest', () => {
  let admin: Browser;
  let guest: Browser;
  let duel: DuelSummary;
  let decks: DeckSummary[];

  const challenge = async (by: Browser) =>
    (await by.json<DuelSummary>(`${h.baseUrl}/api/duels`, { method: 'POST', body: JSON.stringify({ deckId: decks[0]!.id }) })).body;

  it('lets a signed-out visitor accept a challenge link as a guest', async () => {
    admin = await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
    await admin.json(`${h.baseUrl}/api/me/username`, { method: 'POST', body: JSON.stringify({ username: 'Ethan' }) });
    decks = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
    const created = await admin.json<DuelSummary>(`${h.baseUrl}/api/duels`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[0]!.id }),
    });
    expect(created.status).toBe(201);
    duel = created.body;
    expect(duel).toMatchObject({ status: 'waiting', yourSeat: 0, canJoin: false, players: [{ name: 'Ethan', deck: decks[0]!.name }, null], result: null });

    guest = new Browser();
    const preview = await guest.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`);
    expect(preview.body).toMatchObject({ status: 'waiting', yourSeat: null, canJoin: true, players: [{ name: 'Ethan' }, null] });

    // Joining signed out needs a name to play under.
    const nameless = await guest.json(`${h.baseUrl}/api/duels/${duel.id}/join`, { method: 'POST', body: JSON.stringify({ deckId: decks[1]!.id }) });
    expect(nameless.status).toBe(401);
    expect(await guestCount()).toBe(0);

    const joined = await guest.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id, guestName: ' Kaiba ' }),
    });
    expect(joined.body).toMatchObject({
      status: 'active',
      yourSeat: 1,
      players: [
        { name: 'Ethan', deck: decks[0]!.name },
        { name: 'Kaiba (guest)', deck: decks[1]!.name },
      ],
    });
    expect(await me(guest)).toEqual({ kind: 'guest', guest: { name: 'Kaiba' } });
    expect((await guest.json<DuelSummary[]>(`${h.baseUrl}/api/duels`)).body).toEqual([expect.objectContaining({ id: duel.id, yourSeat: 1 })]);

    // Guests can't create challenges.
    expect((await guest.json(`${h.baseUrl}/api/duels`, { method: 'POST', body: JSON.stringify({ deckId: decks[0]!.id }) })).status).toBe(403);
  });

  it('turns away a third visitor without creating a guest for them, but lets them watch', async () => {
    const late = new Browser();
    const seen = await late.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`);
    expect(seen.body).toMatchObject({ status: 'active', yourSeat: null });
    const again = await late.json(`${h.baseUrl}/api/duels/${duel.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id, guestName: 'Joey' }),
    });
    expect(again.status).toBe(409);
    expect(await me(late)).toEqual({ kind: 'anonymous' });
    expect(await guestCount()).toBe(1);
    expect((await late.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream?from=2`)).status).toBe(400);
    // Anyone holding the link watches, seeing only what both players can: no hands, no Deck list, nothing to do.
    const watching = new Stream(await late.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream?from=1`));
    const view = await watching.next();
    watching.close();
    expect(view.you).toBe(1);
    expect(view.deckList).toEqual([]);
    expect(view.actions).toEqual([]);
    expect(view.start).toEqual({ at: 'rps', yours: null, theirsIn: false, last: null });
    expect(view.players.every((p) => p.hand.every((c) => 'hidden' in c) && p.extra.every((c) => 'hidden' in c))).toBe(true);
    expect(await guestCount()).toBe(1);
  });

  it('streams each player their own view and applies intents', async () => {
    const mine = new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const theirs = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const send = (who: Browser, intent: Intent) =>
      who.json<{ error?: string }>(`${h.baseUrl}/api/duels/${duel.id}/intents`, { method: 'POST', body: JSON.stringify(intent) });
    const sync = await mine.update();
    expect(sync.type).toBe('sync');
    let a = (sync as Extract<DuelUpdate, { type: 'sync' }>).view;
    let b = await theirs.next();
    expect(a.you).toBe(0);
    expect(b.you).toBe(1);
    expect(a.players[0].name).toBe('Ethan');
    expect(a.players[1].name).toBe('Kaiba (guest)');

    // Rock-paper-scissors first: a pick reaches the opponent only as "they've picked".
    expect(a.start).toEqual({ at: 'rps', yours: null, theirsIn: false, last: null });
    expect((await send(guest, { type: 'endTurn', discard: [] })).status).toBe(422);
    expect((await send(guest, { type: 'rps', hand: 'lizard' } as unknown as Intent)).status).toBe(400);
    expect((await send(admin, { type: 'rps', hand: 'rock' })).status).toBe(204);
    const picked = await theirs.update();
    expect(picked.type === 'steps' && picked.steps.at(-1)!.view.start).toEqual({ at: 'rps', yours: null, theirsIn: true, last: null });
    expect(JSON.stringify(picked)).not.toContain('rock');
    await mine.next();
    expect((await send(guest, { type: 'rps', hand: 'paper' })).status).toBe(204);
    b = await theirs.next();
    expect(b.start).toEqual({ at: 'order', chooser: 1, hands: ['rock', 'paper'] });
    await mine.next();
    expect((await send(admin, { type: 'chooseOrder', goFirst: true })).status).toBe(422);
    expect((await send(guest, { type: 'chooseOrder', goFirst: true })).status).toBe(204);
    do a = await mine.next();
    while (a.turn < 1);
    b = await theirs.next();
    expect(a.start).toBeNull();
    expect(a.turnPlayer).toBe(1);

    expect(a.players[1].hand.every((c) => 'hidden' in c)).toBe(true);
    expect(b.players[1].hand.every((c) => 'id' in c)).toBe(true);
    expect(a.players[0].extra).toHaveLength(3);
    expect(b.players[0].extra.every((c) => 'hidden' in c)).toBe(true);

    const [first, second, firstStream, secondStream] = [guest, admin, theirs, mine];

    // The player who isn't on turn is refused.
    const early = await send(second, { type: 'enterBattle' });
    expect(early).toEqual({ status: 422, body: { error: "It's not your turn." } });
    expect((await send(first, { type: 'attack', attacker: 'x', target: 9 } as Intent)).status).toBe(400);

    let view = b;
    const set = view.actions.find((x) => x.type === 'setMonster' && x.tributes === 0);
    expect(set).toBeDefined();
    expect((await send(first, { type: 'setMonster', card: (set as { card: string }).card, tributes: [], zone: 0 })).status).toBe(204);
    view = await firstStream.next();
    const otherUpdate = await secondStream.update();
    if (otherUpdate.type !== 'steps') throw new Error('expected steps');
    const other = otherUpdate.steps.at(-1)!.view;
    expect(view.players[view.you].monsters[0]).toMatchObject({ faceUp: false, card: { id: (set as { card: string }).card } });
    expect(other.players[view.you].monsters[0]).toEqual({ card: { hidden: true }, position: 'defense', faceUp: false, stats: null, materials: [], spellCounters: 0 });
    expect(otherUpdate.steps.map((s) => s.entry?.text)).toEqual([expect.stringMatching(/Set a monster$/)]);
    expect(JSON.stringify(otherUpdate)).not.toContain((set as { card: string }).card);

    // Ending the turn opens the End Phase window first; once the opponent passes (the server passes for a player who
    // holds nothing) the next turn starts. That is several events; each is a step, and only the last offers actions.
    expect((await send(first, { type: 'endTurn', discard: [] })).status).toBe(204);
    let turnSteps: DuelUpdate;
    do turnSteps = await secondStream.update();
    while (turnSteps.type !== 'steps' || !turnSteps.steps.some((s) => s.entry?.event.type === 'turnStarted'));
    expect(turnSteps.steps.map((s) => s.entry?.event.type)).toContain('turnStarted');
    expect(turnSteps.steps.slice(0, -1).every((s) => s.view.actions.length === 0)).toBe(true);
    expect(turnSteps.steps.at(-1)!.view.actions.length).toBeGreaterThan(0);

    a = turnSteps.steps.at(-1)!.view;
    expect(a.turn).toBe(2);
    expect(a.turnPlayer).toBe(view.you === 0 ? 1 : 0);

    // A spectator follows along without seeing either player's hidden cards.
    const watching = new Stream(await new Browser().fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    await watching.next();
    expect((await send(second, { type: 'surrender' })).status).toBe(204);
    let w: PlayerView;
    do w = await watching.next();
    while (!w.result);
    watching.close();
    expect(w.result).toEqual({ winner: view.you, reason: 'surrender' });
    expect(w.players.every((p) => p.hand.every((c) => 'hidden' in c))).toBe(true);
    do a = await mine.next();
    while (!a.result);
    expect(a.result).toEqual({ winner: view.you, reason: 'surrender' });
    mine.close();
    theirs.close();
    const { body: summary } = await admin.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`);
    expect(summary).toMatchObject({ status: 'finished', result: { winner: view.you, reason: 'surrender', turn: a.turn } });
    expect(summary.finishedAt).not.toBeNull();
  });

  it('puts chat in both logs in order with the duel, even after it ends', async () => {
    const url = `${h.baseUrl}/api/duels/${duel.id}`;
    const mine = new Stream(await admin.fetch(`${url}/stream`));
    const theirs = new Stream(await guest.fetch(`${url}/stream`));
    await mine.update();
    await theirs.update();
    const chat = (who: Browser, text: string) => who.json(`${url}/chat`, { method: 'POST', body: JSON.stringify({ text }) });
    expect((await chat(guest, '   ')).status).toBe(400);
    expect((await chat(new Browser(), 'hi')).status).toBe(401);
    expect((await chat(guest, '  gg, Copycat never activated  ')).status).toBe(204);
    for (const stream of [mine, theirs]) {
      const update = await stream.update();
      if (update.type !== 'steps') throw new Error('expected steps');
      expect(update.steps.map((s) => [s.entry?.event, s.entry?.text])).toEqual([
        [{ type: 'chatted', player: 1, text: 'gg, Copycat never activated' }, 'Kaiba (guest): gg, Copycat never activated'],
      ]);
    }
    mine.close();
    theirs.close();
    const again = new Stream(await admin.fetch(`${url}/stream`));
    const sync = await again.update();
    if (sync.type !== 'sync') throw new Error('expected sync');
    expect(sync.log.at(-1)!.text).toBe('Kaiba (guest): gg, Copycat never activated');
    expect(sync.log.at(-2)!.event.type).toBe('duelEnded');
    again.close();
  });

  it('gives only the admin the whole duel to review, hidden cards and all', async () => {
    const report = `${h.baseUrl}/api/admin/duels/${duel.id}/report`;
    expect((await guest.fetch(report)).status).toBe(403);
    const text = await (await admin.fetch(report)).text();
    expect(text).toContain(`Duel ${duel.id} (finished)`);
    expect(text).toMatch(/^#\d+ \d\d:\d\d:\d\d T1 \S.* Set .+ \[.+\] in zone 0$/m);
    expect(text).toMatch(/asked for \{"type":"surrender"\}$/m);
    expect(text).toMatch(/Kaiba \(guest\): gg, Copycat never activated\n$/);
    const { body } = await admin.json<{ events: { seq: number; event: { type: string } }[] }>(`${report}?format=json`);
    expect(body.events[0]!.event.type).toBe('duelStarted');
    expect(body.events.at(-1)!.event.type).toBe('chatted');
    const { body: list } = await admin.json<AdminDuels>(`${h.baseUrl}/api/admin/duels`);
    expect(list.duels.find((d) => d.id === duel.id)).toMatchObject({ judgeCalls: 0, appeals: 0, aiCalls: 0, cost: 0 });
  });

  it('replays a finished duel to anyone with the link, from either seat or both, keeping questions private', async () => {
    const url = (from: string) => `${h.baseUrl}/api/duels/${duel.id}/replay?from=${from}`;
    const replay = async (who: Browser, from: string) => (await who.json<Replay>(url(from))).body;
    const raw = await guest.fetch(url('1'), { headers: { 'accept-encoding': 'gzip' } });
    expect(raw.headers.get('content-encoding')).toBe('gzip');

    const own = await replay(guest, '1');
    expect(own.from).toBe(1);
    expect(own.steps[0]!.entry).toBeNull();
    expect(own.steps.every((s) => s.view.you === 1 && s.view.actions.length === 0 && s.view.blocked.length === 0)).toBe(true);
    const end = own.steps.at(-1)!.view;
    expect(end.result).toEqual({ winner: 1, reason: 'surrender' });
    expect(end.players[1].hand.every((c) => 'id' in c)).toBe(true);
    expect(end.players[0].hand.every((c) => 'hidden' in c)).toBe(true);
    // The steps are the live log, entry for entry.
    const live = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const sync = await live.update();
    live.close();
    if (sync.type !== 'sync') throw new Error('expected sync');
    expect(own.steps.slice(1).map((s) => s.entry)).toEqual(sync.log);

    const theirs = await replay(guest, '0');
    expect(theirs.steps.at(-1)!.view.players[1].hand.every((c) => 'hidden' in c)).toBe(true);
    const both = await replay(guest, 'both');
    expect(both.steps.at(-1)!.view.players.every((p) => p.hand.every((c) => 'id' in c))).toBe(true);
    expect(both.steps.some((s) => s.entry?.event.type === 'monsterSet' && s.entry.event.card !== null)).toBe(true);

    // A question the admin's seat asked shows in their replays and an admin's, never in the guest's.
    const seq = (await h.db.select().from(matchEvents).where(eq(matchEvents.matchId, duel.id))).length;
    const record = { player: 0, question: 'Can I respond?', card: null, answer: 'No.', verdict: 'explained', about: null, model: 'm', usage: [], error: null };
    await h.db.insert(matchEvents).values({ matchId: duel.id, seq, event: { type: 'asked', record } });
    const asked = (r: Replay) => r.steps.some((s) => s.entry?.event.type === 'asked');
    expect(asked(await replay(guest, 'both'))).toBe(false);
    expect(asked(await replay(guest, '0'))).toBe(false);
    expect(asked(await replay(admin, '1'))).toBe(true);
    expect(asked(await replay(new Browser(), 'both'))).toBe(false);
    await h.db.delete(matchEvents).where(and(eq(matchEvents.matchId, duel.id), eq(matchEvents.seq, seq)));

    expect((await guest.json(url('2'))).status).toBe(400);
    expect((await replay(new Browser(), 'both')).steps.at(-1)!.view.result).toEqual({ winner: 1, reason: 'surrender' });
    const ongoing = await challenge(admin);
    expect((await admin.json(`${h.baseUrl}/api/duels/${ongoing.id}/replay`)).status).toBe(404);
  });

  it("tells the admin why the duel list failed, so the page shows the reason instead of hiding the list", async () => {
    // A judge call logged before costs were tracked has no token counts.
    await h.db.insert(matchEvents).values({ matchId: duel.id, seq: 9999, event: { type: 'judged', record: { model: 'claude-haiku-5-5' } } });
    const { status, body } = await admin.json<{ error: string }>(`${h.baseUrl}/api/admin/duels`);
    await h.db.delete(matchEvents).where(and(eq(matchEvents.matchId, duel.id), eq(matchEvents.seq, 9999)));
    expect(status).toBe(500);
    expect(body.error).toContain(`Duel ${duel.id} has a judged event without token counts`);
  });

  it('lets the guest take more challenges under the same identity', async () => {
    const second = await challenge(admin);
    const joined = await guest.json<DuelSummary>(`${h.baseUrl}/api/duels/${second.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id }),
    });
    expect(joined.body).toMatchObject({ status: 'active', yourSeat: 1 });
    expect((await guest.json<DuelSummary[]>(`${h.baseUrl}/api/duels`)).body).toHaveLength(2);
    expect(await guestCount()).toBe(1);
    // Finish it, so only finished duels hold the guest.
    expect((await guest.json(`${h.baseUrl}/api/duels/${second.id}/intents`, { method: 'POST', body: '{"type":"surrender"}' })).status).toBe(204);
  });

  it('deletes the guest a day after their last duel finishes', async () => {
    expect(await deleteIdleGuests(h.db)).toBe(0);
    expect(await me(guest)).toMatchObject({ kind: 'guest' });
    expect(await deleteIdleGuests(h.db, new Date(Date.now() + GUEST_GRACE_MS + 60_000))).toBe(1);
    expect(await me(guest)).toEqual({ kind: 'anonymous' });
  });

  it('keeps a guest with a duel still going, and hands their seats to an approved account they log in to', async () => {
    const third = await challenge(admin);
    const visitor = new Browser();
    await visitor.json(`${h.baseUrl}/api/duels/${third.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id, guestName: 'Mai' }),
    });
    expect(await deleteIdleGuests(h.db, new Date(Date.now() + 10 * GUEST_GRACE_MS))).toBe(0);

    // A pending account doesn't take the guest's seats.
    await login({ sub: 'mai', email: 'mai@example.com', email_verified: true }, visitor);
    expect(await me(visitor)).toMatchObject({ kind: 'user', user: { status: 'pending' } });
    expect(await guestCount()).toBe(1);

    const { body: users } = await admin.json<AdminUser[]>(`${h.baseUrl}/api/admin/users`);
    const mai = users.find((u) => u.email === 'mai@example.com')!;
    await admin.json(`${h.baseUrl}/api/admin/users/${mai.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) });
    expect((await visitor.json<DuelSummary[]>(`${h.baseUrl}/api/duels`)).body).toEqual([expect.objectContaining({ id: third.id, yourSeat: 1 })]);
    expect(await guestCount()).toBe(0);
    expect((await visitor.json(`${h.baseUrl}/api/duels/${third.id}/intents`, { method: 'POST', body: '{"type":"surrender"}' })).status).toBe(204);
  });

  it("leaves a guest's seat alone when the account they log in to is the challenger", async () => {
    const own = await challenge(admin);
    const self = new Browser();
    await self.json(`${h.baseUrl}/api/duels/${own.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id, guestName: 'Also Ethan' }),
    });
    await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true }, self);
    expect(await me(self)).toMatchObject({ kind: 'user' });
    expect((await self.json<DuelSummary>(`${h.baseUrl}/api/duels/${own.id}`)).body).toMatchObject({ yourSeat: 0 });
    expect(await guestCount()).toBe(1);
  });
});
