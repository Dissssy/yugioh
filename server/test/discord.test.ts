import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminUser, Me } from '@yugioh/shared';
import { ADMIN_EMAIL, Browser, startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const me = (b: Browser) => b.json<Me>(`${h.baseUrl}/api/me`).then((r) => r.body);

/** Opens the Activity as this Discord user in this instance and signs in, as the web app does. */
async function openActivity(user: { id: string; username: string }, instanceId: string, browser = new Browser()) {
  const res = await browser.json<{ accessToken?: string; error?: string }>(`${h.baseUrl}/api/discord/session`, {
    method: 'POST',
    body: JSON.stringify({ code: h.discord.codeFor(user), instanceId }),
  });
  return { browser, ...res };
}

describe('signing in from the Discord Activity', () => {
  const yugi = { id: '1001', username: 'yugi' };
  const joey = { id: '1002', username: 'joey' };

  it('tells the Activity its client ID', async () => {
    expect((await new Browser().json(`${h.baseUrl}/api/discord`)).body).toEqual({ clientId: 'discord-client' });
  });

  it('signs in a tester inside a running instance as an approved account, with an iframe cookie', async () => {
    h.discord.instances.set('call-1', [yugi.id, joey.id]);
    const browser = new Browser();
    const raw = await browser.fetch(`${h.baseUrl}/api/discord/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: h.discord.codeFor(yugi), instanceId: 'call-1' }),
    });
    expect(raw.status).toBe(200);
    expect(await raw.json()).toEqual({ accessToken: expect.any(String) });
    const cookie = raw.headers.getSetCookie().find((c) => c.startsWith('discord='))!;
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Partitioned/);
    expect(cookie).toMatch(/Secure/);

    expect(await me(browser)).toMatchObject({ kind: 'user', user: { status: 'approved', role: 'player' } });
  });

  it('gives the same Discord user the same account every time', async () => {
    const first = await me((await openActivity(joey, 'call-1')).browser);
    const again = await me((await openActivity(joey, 'call-1')).browser);
    expect(first.kind === 'user' && again.kind === 'user' && first.user.id === again.user.id).toBe(true);
  });

  it("refuses anyone Discord doesn't show inside a running instance", async () => {
    const outsider = { id: '666', username: 'marik' };
    const notInCall = await openActivity(outsider, 'call-1');
    expect(notInCall.status).toBe(403);
    expect(await me(notInCall.browser)).toEqual({ kind: 'anonymous' });
    expect((await openActivity(yugi, 'no-such-call')).status).toBe(403);

    const badCode = await new Browser().json(`${h.baseUrl}/api/discord/session`, { method: 'POST', body: JSON.stringify({ code: 'forged', instanceId: 'call-1' }) });
    expect(badCode.status).toBe(401);
  });

  it('keeps an account the admin rejected rejected', async () => {
    const admin = new Browser();
    h.setIdentity({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
    await admin.fetch(`${h.baseUrl}/auth/login`);
    const joeyMe = await me((await openActivity(joey, 'call-1')).browser);
    const id = joeyMe.kind === 'user' ? joeyMe.user.id : -1;
    const reject = await admin.json<AdminUser>(`${h.baseUrl}/api/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
    expect(reject.body.status).toBe('rejected');

    expect(await me((await openActivity(joey, 'call-1')).browser)).toMatchObject({ user: { status: 'rejected' } });
  });
});
