import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Intent, PlayerView } from '@yugioh/engine';
import type { DeckDetail, DeckSummary, DuelSummary, Invite, Me } from '@yugioh/shared';
import { syncCards } from '../src/cards.ts';
import { ADMIN_EMAIL, Browser, startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

async function login(claims: Parameters<Harness['setIdentity']>[0]) {
  const browser = new Browser();
  h.setIdentity(claims);
  await browser.fetch(`${h.baseUrl}/auth/login`);
  return browser;
}

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

  it('keeps decks to players', async () => {
    expect((await new Browser().json(`${h.baseUrl}/api/decks`)).status).toBe(401);
  });
});

describe('a duel between an account and their guest', () => {
  let admin: Browser;
  let guest: Browser;
  let duel: DuelSummary;
  let decks: DeckSummary[];

  it('lets an approved user create a challenge that their guest can see and join', async () => {
    admin = await login({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true, name: 'Ethan' });
    decks = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
    const created = await admin.json<DuelSummary>(`${h.baseUrl}/api/duels`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[0]!.id }),
    });
    expect(created.status).toBe(201);
    duel = created.body;
    expect(duel).toMatchObject({ status: 'waiting', yourSeat: 0, canJoin: false, createdBy: 'Ethan' });

    const invite = (await admin.json<Invite>(`${h.baseUrl}/api/invites`, { method: 'POST' })).body;
    guest = new Browser();
    await guest.json<Me>(`${h.baseUrl}/api/join/${invite.token}`, { method: 'POST' });
    const { body: open } = await guest.json<DuelSummary[]>(`${h.baseUrl}/api/duels`);
    expect(open).toEqual([expect.objectContaining({ id: duel.id, canJoin: true, yourSeat: null })]);

    // Guests can't create challenges.
    expect((await guest.json(`${h.baseUrl}/api/duels`, { method: 'POST', body: JSON.stringify({ deckId: decks[0]!.id }) })).status).toBe(403);

    const joined = await guest.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ deckId: decks[1]!.id }),
    });
    expect(joined.body).toMatchObject({ status: 'active', yourSeat: 1, decks: [decks[0]!.name, decks[1]!.name] });

    const again = await new Browser().json(`${h.baseUrl}/api/duels/${duel.id}/join`, { method: 'POST', body: '{"deckId":1}' });
    expect(again.status).toBe(401);
  });

  it('streams each player their own view and applies intents', async () => {
    const mine = new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const theirs = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    let a = await mine.next();
    let b = await theirs.next();
    expect(a.you).toBe(0);
    expect(b.you).toBe(1);
    expect(a.players[0].name).toBe('Ethan');
    expect(a.players[1].name).toBe("Ethan's guest");
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
});
