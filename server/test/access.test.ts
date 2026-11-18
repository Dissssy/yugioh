import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Me, User } from '@yugioh/shared';
import { ADMIN_EMAIL, Browser, startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

async function login(claims: Parameters<Harness['setIdentity']>[0]) {
  const browser = new Browser();
  h.setIdentity(claims);
  const res = await browser.fetch(`${h.baseUrl}/auth/login`);
  expect(new URL(res.url).pathname).toBe('/'); // back home after the provider's redirect
  return browser;
}

const me = (b: Browser) => b.json<Me>(`${h.baseUrl}/api/me`).then((r) => r.body);

describe('accounts and approval', () => {
  let admin: Browser;
  let player: Browser;

  it('treats visitors as anonymous and keeps private endpoints closed', async () => {
    const visitor = new Browser();
    expect(await me(visitor)).toEqual({ kind: 'anonymous' });
    expect((await visitor.json(`${h.baseUrl}/api/duels`)).status).toBe(401);
    expect((await visitor.json(`${h.baseUrl}/api/admin/users`)).status).toBe(403);
  });

  it('approves the admin automatically, but only with a verified email', async () => {
    const unverified = await login({ sub: 'fake-admin', email: ADMIN_EMAIL, email_verified: false });
    expect(await me(unverified)).toMatchObject({ kind: 'user', user: { status: 'pending', isAdmin: false } });

    admin = await login({ sub: 'admin', email: ADMIN_EMAIL.toUpperCase(), email_verified: true, name: 'Ethan' });
    expect(await me(admin)).toMatchObject({ kind: 'user', user: { status: 'approved', isAdmin: true } });
  });

  it('puts new accounts in pending until the admin approves them', async () => {
    player = await login({ sub: 'player', email: 'p@example.com', email_verified: true, name: 'Yugi' });
    const before = await me(player);
    expect(before).toMatchObject({ kind: 'user', user: { status: 'pending' } });
    expect((await player.json(`${h.baseUrl}/api/duels`, { method: 'POST', body: '{"deckId":1}' })).status).toBe(403);
    expect((await player.json(`${h.baseUrl}/api/admin/users`)).status).toBe(403);

    const { body: users } = await admin.json<User[]>(`${h.baseUrl}/api/admin/users`);
    const yugi = users.find((u) => u.name === 'Yugi')!;
    const approve = await admin.json<User>(`${h.baseUrl}/api/admin/users/${yugi.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(approve.body.status).toBe('approved');
    expect(await me(player)).toMatchObject({ user: { status: 'approved' } });
  });

  it("keeps an account's status across logins and refuses to change the admin", async () => {
    player = await login({ sub: 'player', email: 'p@example.com', email_verified: true, name: 'Yugi' });
    expect(await me(player)).toMatchObject({ user: { status: 'approved' } });

    const { body: self } = await admin.json<Me>(`${h.baseUrl}/api/me`);
    const id = self.kind === 'user' ? self.user.id : -1;
    const demote = await admin.json(`${h.baseUrl}/api/admin/users/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'rejected' }),
    });
    expect(demote.status).toBe(404);
  });

  it('logs out', async () => {
    const b = await login({ sub: 'temp', email: 't@example.com', email_verified: true });
    await b.fetch(`${h.baseUrl}/auth/logout`).catch(() => undefined);
    expect(await me(b)).toEqual({ kind: 'anonymous' });
  });

  it('sends the visitor back to the page they logged in from, but only on this site', async () => {
    const b = new Browser();
    h.setIdentity({ sub: 'player', email: 'p@example.com', email_verified: true, name: 'Yugi' });
    const back = await b.fetch(`${h.baseUrl}/auth/login?returnTo=${encodeURIComponent('/duel/abc')}`);
    expect(new URL(back.url).pathname).toBe('/duel/abc');
    const offsite = await new Browser().fetch(`${h.baseUrl}/auth/login?returnTo=${encodeURIComponent('//evil.example/x')}`);
    expect(new URL(offsite.url).host).toBe(new URL(h.baseUrl).host);
    expect(new URL(offsite.url).pathname).toBe('/');
  });

});
