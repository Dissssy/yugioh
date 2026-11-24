import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminUser, Me, User, UserSettings } from '@yugioh/shared';
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

  it('makes the ADMIN_EMAIL account the approved super admin, but only with a verified email', async () => {
    const unverified = await login({ sub: 'fake-admin', email: ADMIN_EMAIL, email_verified: false });
    expect(await me(unverified)).toMatchObject({ kind: 'user', user: { status: 'pending', role: 'player' } });

    admin = await login({ sub: 'admin', email: ADMIN_EMAIL.toUpperCase(), email_verified: true });
    expect(await me(admin)).toMatchObject({ kind: 'user', user: { status: 'approved', role: 'superAdmin' } });
  });

  it('puts new accounts in pending until the admin approves them', async () => {
    player = await login({ sub: 'player', email: 'p@example.com', email_verified: true });
    const before = await me(player);
    expect(before).toMatchObject({ kind: 'user', user: { status: 'pending' } });
    expect((await player.json(`${h.baseUrl}/api/duels`, { method: 'POST', body: '{"deckId":1}' })).status).toBe(403);
    expect((await player.json(`${h.baseUrl}/api/admin/users`)).status).toBe(403);

    // The admin sees who is asking by their email.
    const { body: users } = await admin.json<AdminUser[]>(`${h.baseUrl}/api/admin/users`);
    const yugi = users.find((u) => u.email === 'p@example.com')!;
    const approve = await admin.json<AdminUser>(`${h.baseUrl}/api/admin/users/${yugi.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(approve.body.status).toBe('approved');
    expect(await me(player)).toMatchObject({ user: { status: 'approved' } });
  });

  it("keeps an account's status across logins and refuses to change the admin", async () => {
    player = await login({ sub: 'player', email: 'p@example.com', email_verified: true });
    expect(await me(player)).toMatchObject({ user: { status: 'approved' } });

    const { body: self } = await admin.json<Me>(`${h.baseUrl}/api/me`);
    const id = self.kind === 'user' ? self.user.id : -1;
    const demote = await admin.json(`${h.baseUrl}/api/admin/users/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'rejected' }),
    });
    expect(demote.status).toBe(409);
  });

  it('lets the super admin make admins, who approve players and edit rulings but make no admins', async () => {
    const { body: list } = await admin.json<AdminUser[]>(`${h.baseUrl}/api/admin/users`);
    const id = (email: string) => list.find((u) => u.email === email)!.id;
    const self = await me(admin);
    const superId = self.kind === 'user' ? self.user.id : -1;
    const setRole = (b: Browser, user: number, role: string) =>
      b.json<AdminUser>(`${h.baseUrl}/api/admin/users/${user}/role`, { method: 'POST', body: JSON.stringify({ role }) });
    const setStatus = (b: Browser, user: number, status: string) =>
      b.json<AdminUser>(`${h.baseUrl}/api/admin/users/${user}/status`, { method: 'POST', body: JSON.stringify({ status }) });

    // A pending account can't be made an admin, nor can the super admin be demoted.
    const newcomer = await login({ sub: 'newcomer', email: 'n@example.com', email_verified: true });
    const newcomerId = (await admin.json<AdminUser[]>(`${h.baseUrl}/api/admin/users`)).body.find((u) => u.email === 'n@example.com')!.id;
    expect((await setRole(admin, newcomerId, 'admin')).status).toBe(409);
    expect((await setRole(admin, superId, 'player')).status).toBe(409);

    expect((await setRole(admin, id('p@example.com'), 'admin')).body.role).toBe('admin');
    expect(await me(player)).toMatchObject({ user: { role: 'admin' } });
    // The admin keeps the role across logins.
    player = await login({ sub: 'player', email: 'p@example.com', email_verified: true });
    expect(await me(player)).toMatchObject({ user: { role: 'admin' } });

    // An admin approves players and reads rulings and logs, but can't make admins, change admins or play Claude.
    expect((await setStatus(player, newcomerId, 'approved')).body.status).toBe('approved');
    expect(await me(newcomer)).toMatchObject({ user: { status: 'approved' } });
    expect((await player.json(`${h.baseUrl}/api/admin/rulings`)).status).toBe(200);
    expect((await player.json(`${h.baseUrl}/api/admin/duels`)).status).toBe(200);
    expect((await setRole(player, newcomerId, 'admin')).status).toBe(403);
    expect((await setStatus(player, superId, 'rejected')).status).toBe(409);
    expect((await player.json(`${h.baseUrl}/api/admin/duels/ai`, { method: 'POST', body: '{"deckId":1,"aiDeckId":1}' })).status).toBe(403);
    // An admin's status can't change until they are a player again.
    expect((await setStatus(admin, id('p@example.com'), 'rejected')).status).toBe(409);

    expect((await setRole(admin, id('p@example.com'), 'player')).body.role).toBe('player');
    expect((await player.json(`${h.baseUrl}/api/admin/users`)).status).toBe(403);
  });

  it('gives each account a random username and keeps its email private', async () => {
    const self = await me(player);
    expect(self).toEqual({ kind: 'user', user: expect.not.objectContaining({ email: expect.anything() }), settings: expect.anything(), logins: { auth0: true, discord: false } });
    const user = (self as Extract<Me, { kind: 'user' }>).user;
    expect(user.username).toMatch(/^[A-Za-z]+_[A-Za-z]+_\d{1,4}$/);
    // Logging in again keeps the username.
    await login({ sub: 'player', email: 'p@example.com', email_verified: true });
    expect(await me(player)).toMatchObject({ user: { username: user.username } });
  });

  it('lets an account change its username as often as it likes, to any name nobody else has', async () => {
    const rename = (b: Browser, username: string) =>
      b.json<User>(`${h.baseUrl}/api/me/username`, { method: 'POST', body: JSON.stringify({ username }) });

    expect((await rename(admin, 'Ethan')).status).toBe(200);
    expect(await rename(player, 'ethan')).toMatchObject({ status: 409, body: { error: 'username_taken' } });
    expect(await rename(player, 'no spaces')).toMatchObject({ status: 400, body: { error: 'invalid_username' } });
    expect(await rename(player, 'ab')).toMatchObject({ status: 400 });
    expect((await rename(player, 'Yugi')).body.username).toBe('Yugi');
    expect((await rename(player, 'Yugi_Muto')).body.username).toBe('Yugi_Muto');
    expect((await rename(player, 'Yugi')).body.username).toBe('Yugi');
    // Changing only the case of your own name is fine.
    expect((await rename(admin, 'ETHAN')).body.username).toBe('ETHAN');
    expect((await new Browser().json(`${h.baseUrl}/api/me/username`, { method: 'POST', body: '{"username":"Joey"}' })).status).toBe(401);
  });

  it("keeps each account's settings, starting from the defaults", async () => {
    const change = (b: Browser, body: unknown) =>
      b.json<UserSettings>(`${h.baseUrl}/api/me/settings`, { method: 'PATCH', body: JSON.stringify(body) });

    expect(await me(player)).toMatchObject({ settings: { opponentCards: 'faceThem' } });
    expect((await change(player, { opponentCards: 'faceYou' })).body).toEqual({ opponentCards: 'faceYou' });
    expect(await me(player)).toMatchObject({ settings: { opponentCards: 'faceYou' } });
    // Another account's settings are its own.
    expect(await me(admin)).toMatchObject({ settings: { opponentCards: 'faceThem' } });

    expect(await change(player, { opponentCards: 'sideways' })).toMatchObject({ status: 400, body: { error: 'invalid_settings' } });
    expect(await change(player, { volume: 11 })).toMatchObject({ status: 400 });
    expect((await change(new Browser(), { opponentCards: 'faceYou' })).status).toBe(401);
  });

  it('logs out', async () => {
    const b = await login({ sub: 'temp', email: 't@example.com', email_verified: true });
    await b.fetch(`${h.baseUrl}/auth/logout`).catch(() => undefined);
    expect(await me(b)).toEqual({ kind: 'anonymous' });
  });

  it('sends the visitor back to the page they logged in from, but only on this site', async () => {
    const b = new Browser();
    h.setIdentity({ sub: 'player', email: 'p@example.com', email_verified: true });
    const back = await b.fetch(`${h.baseUrl}/auth/login?returnTo=${encodeURIComponent('/duel/abc')}`);
    expect(new URL(back.url).pathname).toBe('/duel/abc');
    const offsite = await new Browser().fetch(`${h.baseUrl}/auth/login?returnTo=${encodeURIComponent('//evil.example/x')}`);
    expect(new URL(offsite.url).host).toBe(new URL(h.baseUrl).host);
    expect(new URL(offsite.url).pathname).toBe('/');
  });

});
