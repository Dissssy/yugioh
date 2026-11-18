import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Intent, PlayerView } from '@yugioh/engine';
import type { DeckDetail, DeckSummary, DuelSummary, Me, User } from '@yugioh/shared';
import { syncCards } from '../src/cards.ts';
import { guests } from '../src/db/schema.ts';
import { deleteIdleGuests, GUEST_GRACE_MS } from '../src/guests.ts';
import { ADMIN_EMAIL, Browser, startHarness, type Harness } from './harness.ts';

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

/** Reads a Server-Sent Events stream one view at a time. */
class Stream {
  private buffer = '';
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }
  async next(): Promise<PlayerView> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const message = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (message.startsWith('data: ')) return JSON.parse(message.slice(6)) as PlayerView;
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('stream ended');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
  close() {
    void this.reader.cancel();
  }
}

describe('card data', () => {
  it('imports cards, builds both starter decks from their sets and downloads their images', async () => {
    await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
    const admin = await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true, name: 'Ethan' });
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
    admin = await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true, name: 'Ethan' });
    decks = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
    const created = await admin.json<DuelSummary>(`${h.baseUrl}/api/duels`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[0]!.id }),
    });
    expect(created.status).toBe(201);
    duel = created.body;
    expect(duel).toMatchObject({ status: 'waiting', yourSeat: 0, canJoin: false, createdBy: 'Ethan' });

    guest = new Browser();
    const preview = await guest.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`);
    expect(preview.body).toMatchObject({ status: 'waiting', yourSeat: null, canJoin: true, createdBy: 'Ethan' });

    // Joining signed out needs a name to play under.
    const nameless = await guest.json(`${h.baseUrl}/api/duels/${duel.id}/join`, { method: 'POST', body: JSON.stringify({ deckId: decks[1]!.id }) });
    expect(nameless.status).toBe(401);
    expect(await guestCount()).toBe(0);

    const joined = await guest.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id, guestName: ' Kaiba ' }),
    });
    expect(joined.body).toMatchObject({ status: 'active', yourSeat: 1, decks: [decks[0]!.name, decks[1]!.name] });
    expect(await me(guest)).toEqual({ kind: 'guest', guest: { name: 'Kaiba' } });
    expect((await guest.json<DuelSummary[]>(`${h.baseUrl}/api/duels`)).body).toEqual([expect.objectContaining({ id: duel.id, yourSeat: 1 })]);

    // Guests can't create challenges.
    expect((await guest.json(`${h.baseUrl}/api/duels`, { method: 'POST', body: JSON.stringify({ deckId: decks[0]!.id }) })).status).toBe(403);
  });

  it('turns away a third visitor without creating a guest for them', async () => {
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
    expect((await late.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`)).status).toBe(401);
  });

  it('streams each player their own view and applies intents', async () => {
    const mine = new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const theirs = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    let a = await mine.next();
    let b = await theirs.next();
    expect(a.you).toBe(0);
    expect(b.you).toBe(1);
    expect(a.players[0].name).toBe('Ethan');
    expect(a.players[1].name).toBe('Kaiba');
    expect(a.players[1].hand.every((c) => 'hidden' in c)).toBe(true);
    expect(b.players[1].hand.every((c) => 'id' in c)).toBe(true);
    expect(a.players[0].extra).toHaveLength(3);
    expect(b.players[0].extra.every((c) => 'hidden' in c)).toBe(true);

    const [first, second, firstStream, secondStream] = a.turnPlayer === 0 ? [admin, guest, mine, theirs] : [guest, admin, theirs, mine];
    const send = (who: Browser, intent: Intent) =>
      who.json<{ error?: string }>(`${h.baseUrl}/api/duels/${duel.id}/intents`, { method: 'POST', body: JSON.stringify(intent) });

    // The player who isn't on turn is refused.
    const early = await send(second, { type: 'enterBattle' });
    expect(early).toEqual({ status: 422, body: { error: "It's not your turn." } });
    expect((await send(first, { type: 'attack', attacker: 'x', target: 9 } as Intent)).status).toBe(400);

    let view = a.turnPlayer === 0 ? a : b;
    const set = view.actions.find((x) => x.type === 'setMonster' && x.tributes === 0);
    expect(set).toBeDefined();
    expect((await send(first, { type: 'setMonster', card: (set as { card: string }).card, tributes: [] })).status).toBe(204);
    view = await firstStream.next();
    const other = await secondStream.next();
    expect(view.players[view.you].monsters[0]).toMatchObject({ faceUp: false, card: { id: (set as { card: string }).card } });
    expect(other.players[view.you].monsters[0]).toEqual({ card: { hidden: true }, position: 'defense', faceUp: false });
    expect(other.log.at(-1)).toMatch(/Set a monster$/);

    expect((await send(first, { type: 'endTurn', discard: [] })).status).toBe(204);
    a = await mine.next();
    b = await theirs.next();
    expect(a.turn).toBe(2);
    expect(a.turnPlayer).toBe(view.you === 0 ? 1 : 0);

    expect((await send(second, { type: 'surrender' })).status).toBe(204);
    a = await mine.next();
    expect(a.result).toEqual({ winner: view.you, reason: 'surrender' });
    mine.close();
    theirs.close();
    const { body: summary } = await admin.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`);
    expect(summary.status).toBe('finished');
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
    await login({ sub: 'mai', email: 'mai@example.com', email_verified: true, name: 'Mai' }, visitor);
    expect(await me(visitor)).toMatchObject({ kind: 'user', user: { status: 'pending' } });
    expect(await guestCount()).toBe(1);

    const { body: users } = await admin.json<User[]>(`${h.baseUrl}/api/admin/users`);
    const mai = users.find((u) => u.name === 'Mai')!;
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
    await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true, name: 'Ethan' }, self);
    expect(await me(self)).toMatchObject({ kind: 'user' });
    expect((await self.json<DuelSummary>(`${h.baseUrl}/api/duels/${own.id}`)).body).toMatchObject({ yourSeat: 0 });
    expect(await guestCount()).toBe(1);
  });
});
