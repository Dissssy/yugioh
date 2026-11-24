// Admin API keys and review requests (docs/review-api.md): an admin sends a duel to Claude, and a tool holding a key
// reads the queue, fetches the bundle and reports back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKey, DeckSummary, ReviewRequest } from '@yugioh/shared';
import { syncCards } from '../src/cards.ts';
import type { ReviewBundle } from '../src/reviews.ts';
import { importSheetFiles } from '../src/sheets.ts';
import { ADMIN_EMAIL, Browser, startDuelVia, startHarness, type Harness } from './harness.ts';

let h: Harness;
let admin: Browser;
let duelId: string;
beforeAll(async () => {
  h = await startHarness();
  await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
  await importSheetFiles(h.db);
  admin = new Browser();
  h.setIdentity({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
  await admin.fetch(`${h.baseUrl}/auth/login`);
  await admin.json(`${h.baseUrl}/api/me/username`, { method: 'POST', body: JSON.stringify({ username: 'Ethan' }) });
  const decks = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
  duelId = (await startDuelVia(h.baseUrl, admin, new Browser(), [decks[0]!.id, decks[1]!.id], { guestName: 'Kaiba' })).id;
});
afterAll(() => h.close());

/** A request made with an API key, as a tool would make it. */
const withKey = async <T,>(key: string, path: string, init: RequestInit = {}) => {
  const res = await fetch(`${h.baseUrl}/api${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T };
};

describe('admin API keys', () => {
  let key: string;

  it('are made by the super admin and shown once', async () => {
    const made = await admin.json<{ id: number; key: string }>(`${h.baseUrl}/api/admin/keys`, { method: 'POST', body: JSON.stringify({ name: 'Review thread' }) });
    expect(made.status).toBe(201);
    key = made.body.key;
    const { body: keys } = await admin.json<ApiKey[]>(`${h.baseUrl}/api/admin/keys`);
    expect(keys).toEqual([expect.objectContaining({ name: 'Review thread', createdBy: 'Ethan', lastUsedAt: null })]);
    expect(JSON.stringify(keys)).not.toContain(key);
  });

  it('act as an admin on the admin API only, never as the super admin', async () => {
    expect((await withKey(key, '/admin/reviews')).status).toBe(200);
    expect((await withKey(key, `/admin/duels/${duelId}/report?format=json`)).status).toBe(200);
    expect((await withKey(key, '/admin/keys')).status).toBe(403);
    expect((await withKey(key, '/me')).status).toBe(403);
    expect((await withKey(key, '/duels')).status).toBe(403);
    expect((await withKey('ygo_not-a-key', '/admin/reviews')).status).toBe(403);
    const { body: keys } = await admin.json<ApiKey[]>(`${h.baseUrl}/api/admin/keys`);
    expect(keys[0]!.lastUsedAt).not.toBeNull();
  });

  it('stop working once revoked', async () => {
    const { body: keys } = await admin.json<ApiKey[]>(`${h.baseUrl}/api/admin/keys`);
    expect((await admin.json(`${h.baseUrl}/api/admin/keys/${keys[0]!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await withKey(key, '/admin/reviews')).status).toBe(403);
  });
});

describe('review requests', () => {
  it('go from an admin to the queue, give a tool the whole context, and take its findings back', async () => {
    const { key } = (await admin.json<{ key: string }>(`${h.baseUrl}/api/admin/keys`, { method: 'POST', body: JSON.stringify({ name: 'Queue' }) })).body;
    const sent = await admin.json<ReviewRequest>(`${h.baseUrl}/api/admin/reviews`, {
      method: 'POST',
      body: JSON.stringify({ matchId: duelId, seq: 1, note: 'Nothing could be activated here.' }),
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ matchId: duelId, seq: 1, code: null, sentBy: 'Ethan', status: 'open' });
    const send = (body: object) => admin.json(`${h.baseUrl}/api/admin/reviews`, { method: 'POST', body: JSON.stringify(body) });
    expect((await send({ matchId: 'nope', note: 'x' })).status).toBe(404);
    expect((await send({ matchId: duelId, seq: 9999, note: 'x' })).status).toBe(404);

    const open = await withKey<ReviewRequest[]>(key, '/admin/reviews?status=open');
    expect(open.body.map((r) => r.id)).toEqual([sent.body.id]);

    const { body: bundle } = await withKey<ReviewBundle>(key, `/admin/reviews/${sent.body.id}/bundle`);
    expect(bundle.commit).toBe('test-sha');
    expect(bundle.report.id).toBe(duelId);
    expect(bundle.board.before).toBe(1);
    expect(bundle.board.seats).toHaveLength(2);
    expect(bundle.board.state.cards).toBeTypeOf('object');

    await withKey(key, `/admin/reviews/${sent.body.id}`, { method: 'POST', body: JSON.stringify({ status: 'claimed' }) });
    expect((await withKey<ReviewRequest[]>(key, '/admin/reviews?status=open')).body).toEqual([]);
    const done = await withKey<ReviewRequest>(key, `/admin/reviews/${sent.body.id}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'fixed', result: 'A reset took every sheet away.', prUrl: 'https://github.com/Dissssy/yugioh/pull/80' }),
    });
    expect(done.body).toMatchObject({ status: 'fixed', result: 'A reset took every sheet away.', prUrl: 'https://github.com/Dissssy/yugioh/pull/80' });
  });
});
