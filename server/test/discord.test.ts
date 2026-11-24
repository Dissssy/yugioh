import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdminUser, DeckSummary, DiscordServer, DuelSummary, Me, OpenGames } from '@yugioh/shared';
import { syncCards } from '../src/cards.ts';
import { decks, discordServers } from '../src/db/schema.ts';
import { ADMIN_EMAIL, Browser, startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  // The tests' Activity runs in this server unless they say otherwise, and an admin trusts it.
  await h.db.insert(discordServers).values({ id: 'test-server', trusted: true });
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

  it("tells the Activity its client ID and the site's address", async () => {
    expect((await new Browser().json(`${h.baseUrl}/api/discord`)).body).toEqual({ clientId: 'discord-client', siteUrl: h.baseUrl });
  });

  it('signs in someone inside a running instance in a trusted server as an approved account, with an iframe cookie', async () => {
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

  it('leaves someone who opens it outside a trusted server waiting, until an admin trusts that server', async () => {
    const mai = { id: '1003', username: 'mai' };
    h.discord.instances.set('elsewhere', [mai.id]);
    h.discord.places.set('elsewhere', 'guild:harpie-server');
    h.discord.instances.set('mai-dm', [mai.id]);
    h.discord.places.set('mai-dm', 'dm:42');
    const opened = (await openActivity(mai, 'elsewhere')).browser;
    expect(await me(opened)).toMatchObject({ user: { status: 'pending' } });
    expect(await me((await openActivity(mai, 'mai-dm')).browser)).toMatchObject({ user: { status: 'pending' } });

    // The admin sees the servers the Activity was opened in, and trusts this one.
    const admin = await auth0Login('admin', ADMIN_EMAIL);
    const servers = (await admin.json<DiscordServer[]>(`${h.baseUrl}/api/admin/discord-servers`)).body;
    const opener = await me(opened);
    expect(servers.find((s) => s.id === 'harpie-server')).toMatchObject({ trusted: false, lastOpenedBy: opener.kind === 'user' && opener.user.username });
    expect((await opened.json(`${h.baseUrl}/api/admin/discord-servers/harpie-server`, { method: 'POST', body: JSON.stringify({ trusted: true }) })).status).toBe(403);
    expect((await admin.json(`${h.baseUrl}/api/admin/discord-servers/nowhere`, { method: 'POST', body: JSON.stringify({ trusted: true }) })).status).toBe(404);
    expect((await admin.json(`${h.baseUrl}/api/admin/discord-servers/harpie-server`, { method: 'POST', body: JSON.stringify({ trusted: true }) })).status).toBe(200);

    expect(await me((await openActivity(mai, 'elsewhere')).browser)).toMatchObject({ user: { status: 'approved' } });
    // Approved stays approved anywhere.
    expect(await me((await openActivity(mai, 'mai-dm')).browser)).toMatchObject({ user: { status: 'approved' } });
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

/** Logs in through the mock Auth0 provider, as the website's Log in button does. */
async function auth0Login(sub: string, email: string, browser = new Browser()) {
  h.setIdentity({ sub, email, email_verified: true });
  await browser.fetch(`${h.baseUrl}/auth/login`);
  return browser;
}

const idOf = (m: Me) => (m.kind === 'user' ? m.user.id : -1);

async function approve(id: number) {
  const admin = await auth0Login('admin', ADMIN_EMAIL);
  await admin.json(`${h.baseUrl}/api/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'approved' }) });
}

/** Clicks a Link button on the account page and follows the logins it leads through. */
async function link(browser: Browser, to: 'discord' | 'auth0') {
  const { status, body } = await browser.json<{ url: string }>(`${h.baseUrl}/api/me/link/${to}`, { method: 'POST' });
  expect(status).toBe(200);
  const res = await browser.fetch(new URL(body.url, h.baseUrl).href);
  return new URL(res.url);
}

describe('Discord logins on the website', () => {
  it('logs in with Discord as a pending account, and logs out', async () => {
    h.discord.webUser = { id: '2001', username: 'tea' };
    const browser = new Browser();
    const res = await browser.fetch(`${h.baseUrl}/auth/discord/login?returnTo=/decks`);
    expect(new URL(res.url).pathname).toBe('/decks');
    expect(await me(browser)).toMatchObject({ kind: 'user', user: { status: 'pending' }, logins: { auth0: false, discord: true } });

    await browser.fetch(`${h.baseUrl}/auth/logout`);
    expect(await me(browser)).toEqual({ kind: 'anonymous' });
  });

  it('ignores a Discord callback it never started', async () => {
    const browser = new Browser();
    const res = await browser.fetch(`${h.baseUrl}/auth/discord/callback?code=${h.discord.codeFor({ id: '2002', username: 'x' })}&state=made-up`);
    expect(new URL(res.url).pathname).toBe('/');
    expect(await me(browser)).toEqual({ kind: 'anonymous' });
  });

  it('adds Discord to an Auth0 account, which the Activity then signs in to', async () => {
    const browser = await auth0Login('bakura', 'bakura@example.com');
    const before = await me(browser);
    h.discord.webUser = { id: '2003', username: 'bakura' };
    expect((await link(browser, 'discord')).pathname).toBe('/account');
    expect(await me(browser)).toMatchObject({ user: { id: idOf(before) }, logins: { auth0: true, discord: true } });

    h.discord.instances.set('call-2', ['2003']);
    expect(idOf(await me((await openActivity(h.discord.webUser, 'call-2')).browser))).toBe(idOf(before));
  });

  it("keeps the Discord account when only it is approved, and moves the other's decks to it", async () => {
    // An approved tester from the Activity, and a pending website account with a deck, for the same person.
    h.discord.instances.set('call-3', ['2004']);
    const tester = await me((await openActivity({ id: '2004', username: 'mai' }, 'call-3')).browser);
    const site = await auth0Login('mai', 'mai@example.com');
    const pending = await me(site);
    await h.db.insert(decks).values({ ownerId: idOf(pending), name: 'Harpies', main: [], extra: [] });

    h.discord.webUser = { id: '2004', username: 'mai' };
    expect((await link(site, 'discord')).pathname).toBe('/account');
    expect(await me(site)).toMatchObject({ user: { id: idOf(tester), status: 'approved' }, logins: { auth0: true, discord: true } });
    const [deck] = await h.db.select().from(decks).where(eq(decks.name, 'Harpies'));
    expect(deck!.ownerId).toBe(idOf(tester));
  });

  it('adds an Auth0 login to a Discord account, keeping the Auth0 account when both are approved', async () => {
    h.discord.webUser = { id: '2005', username: 'kaiba' };
    const browser = new Browser();
    await browser.fetch(`${h.baseUrl}/auth/discord/login`);
    await approve(idOf(await me(browser)));
    const auth0Side = await me(await auth0Login('kaiba', 'kaiba@example.com'));
    await approve(idOf(auth0Side));

    h.setIdentity({ sub: 'kaiba', email: 'kaiba@example.com', email_verified: true });
    expect((await link(browser, 'auth0')).pathname).toBe('/account');
    expect(await me(browser)).toMatchObject({ user: { id: idOf(auth0Side) }, logins: { auth0: true, discord: true } });
  });

  it('refuses to link a Discord account that already has a website login', async () => {
    const other = await auth0Login('pegasus', 'pegasus@example.com');
    h.discord.webUser = { id: '2005', username: 'kaiba' }; // linked to kaiba's website login above
    const back = await link(other, 'discord');
    expect(back.pathname).toBe('/account');
    expect(back.searchParams.get('linkError')).toMatch(/already linked/);
    expect(await me(other)).toMatchObject({ logins: { auth0: true, discord: false } });
  });
});

describe('open games in the Activity', () => {
  const challenge = (b: Browser) => b.json<DuelSummary>(`${h.baseUrl}/api/duels`, { method: 'POST', body: '{}' });
  const openGames = (b: Browser) => b.json<OpenGames>(`${h.baseUrl}/api/open-games`);

  it("lists the duels started in this server's Activity, for anyone there to join or watch", async () => {
    await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
    h.discord.instances.set('table-call', ['3001', '3002']);
    const ishizu = (await openActivity({ id: '3001', username: 'ishizu' }, 'table-call')).browser;
    const odion = (await openActivity({ id: '3002', username: 'odion' }, 'table-call')).browser;
    const { body: duel } = await challenge(ishizu);

    const { body: seen } = await openGames(odion);
    expect(seen.dm).toBe(false);
    expect(seen.games.map((d) => d.id)).toEqual([duel.id]);
    expect(seen.games[0]).toMatchObject({ status: 'waiting', canJoin: true, yourSeat: null });
    expect((await openGames(ishizu)).body.games[0]).toMatchObject({ id: duel.id, yourSeat: 0, canJoin: false });
  });

  it("keeps each server's open games to itself, and the website's challenges off them", async () => {
    h.discord.instances.set('other-call', ['3003']);
    h.discord.places.set('other-call', 'guild:other-server');
    const rex = (await openActivity({ id: '3003', username: 'rex' }, 'other-call')).browser;
    expect((await openGames(rex)).body.games).toEqual([]);

    const site = await auth0Login('admin', ADMIN_EMAIL);
    await challenge(site);
    expect((await openGames(site)).status).toBe(404);
    h.discord.instances.set('table-call-2', ['3001']);
    const again = (await openActivity({ id: '3001', username: 'ishizu' }, 'table-call-2')).browser;
    expect((await openGames(again)).body.games).toHaveLength(1);
  });

  it('lets the challenger choose a deck and get ready before anyone sits down', async () => {
    const ishizu = (await openActivity({ id: '3001', username: 'ishizu' }, 'table-call')).browser;
    const odion = (await openActivity({ id: '3002', username: 'odion' }, 'table-call')).browser;
    const { body: duel } = await challenge(ishizu);
    const at = (path: string) => `${h.baseUrl}/api/duels/${duel.id}${path}`;
    const [deck] = (await ishizu.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
    expect((await ishizu.json(at('/deck'), { method: 'PUT', body: JSON.stringify({ deckId: deck!.id }) })).status).toBe(200);
    const ready = await ishizu.json<DuelSummary>(at('/ready'), { method: 'POST', body: JSON.stringify({ ready: true }) });
    expect(ready.body).toMatchObject({ status: 'waiting', players: [{ ready: true }, null] });

    await odion.json(at('/join'), { method: 'POST', body: '{}' });
    await odion.json(at('/deck'), { method: 'PUT', body: JSON.stringify({ deckId: deck!.id }) });
    expect((await odion.json<DuelSummary>(at('/ready'), { method: 'POST', body: JSON.stringify({ ready: true }) })).body.status).toBe('active');

    // Everyone there sees a small picture of it: names and LP, how many cards each holds, and nothing hidden.
    const { previews } = (await openGames(odion)).body;
    expect(previews[duel.id]).toMatchObject({ turn: 0, players: [{ lp: 8000, hand: 0 }, { lp: 8000, hand: 0 }] });
    expect(previews[duel.id]!.players[0].monsters).toHaveLength(7);
  });

  it('says when the Activity was opened in a DM', async () => {
    h.discord.instances.set('dm-call', ['3004']);
    h.discord.places.set('dm-call', 'dm:555');
    const weevil = (await openActivity({ id: '3004', username: 'weevil' }, 'dm-call')).browser;
    expect((await openGames(weevil)).body).toEqual({ dm: true, games: [], previews: {} });
  });
});
