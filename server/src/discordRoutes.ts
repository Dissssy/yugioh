// Discord logins (docs/discord.md): signing in inside the Activity, "Log in with Discord" on the website, and linking
// a Discord login to an account that logs in through Auth0.
import { randomBytes } from 'node:crypto';
import type { CookieOptions, Express, Request, Response } from 'express';
import { z } from 'zod';
import { findUserByDiscordId, linkAccounts, syncDiscordUser, syncWebDiscordUser } from './accounts.ts';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import type { DiscordApi } from './discord.ts';
import { viewerOf } from './viewer.ts';

/** Holds the Discord user ID of whoever signed in with Discord. The account is looked up by it on every request. */
const SESSION_COOKIE = 'discord';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Where the Activity was opened, as `guild:<id>` or `dm:<id>`. Its open games are the duels started there.
 * Set only inside the Activity, from what Discord reports about the instance, so it can't be made up.
 */
const PLACE_COOKIE = 'discord_place';
/** The website's Discord login in progress: the state it sent, where to go after, and the account to link. */
const LOGIN_COOKIE = 'discord_login';
/** An Auth0 login in progress that should be linked to this Discord account once it lands. */
const LINK_COOKIE = 'link_auth0';
const LOGIN_MS = 10 * 60 * 1000;

const loginState = z.object({ state: z.string(), returnTo: z.string(), link: z.number().int().optional() });

/** Only paths on this site, so a login can't be made to send someone elsewhere. */
export const safeReturnTo = (to: unknown) => (typeof to === 'string' && /^\/(?![/\\])/.test(to) ? to : '/');

/** Logs out of a Discord login, in the Activity's iframe or on the website. */
export function endDiscordSession(res: Response) {
  for (const name of [SESSION_COOKIE, PLACE_COOKIE]) {
    res.clearCookie(name, { secure: true, sameSite: 'none', partitioned: true });
    res.clearCookie(name);
  }
}

/** The Discord server or DM the Activity was opened in, inside the Activity; null on the website. */
export function placeOf(req: Request): string | null {
  const place: unknown = req.signedCookies[PLACE_COOKIE];
  return typeof place === 'string' ? place : null;
}

export function discordRoutes(app: Express, config: Config, db: Db, discord: DiscordApi | null) {
  const secure = config.BASE_URL.startsWith('https:');
  const redirectUri = `${config.BASE_URL}/auth/discord/callback`;
  // The Activity runs in an iframe on discord.com, where browsers only send a cookie marked SameSite=None. Partitioned
  // keeps it to Discord's frames, as Discord's docs advise. The website keeps the usual SameSite=Lax.
  const inFrame: CookieOptions = { signed: true, httpOnly: true, secure: true, sameSite: 'none', partitioned: true };
  const onSite: CookieOptions = { signed: true, httpOnly: true, secure, sameSite: 'lax' };

  const startSession = (res: Response, discordId: string, options: CookieOptions) =>
    res.cookie(SESSION_COOKIE, discordId, { ...options, maxAge: SESSION_MS });

  // The Activity asks for its client ID before it can ask Discord to sign the player in, and for the site's own address,
  // since links copied inside Discord must point at the website rather than Discord's proxy.
  app.get('/api/discord', (_req, res) => {
    if (!discord) return void res.status(404).json({ error: 'discord_off' });
    res.json({ clientId: discord.clientId, siteUrl: config.BASE_URL });
  });

  // Signs in someone in the Activity, from the code Discord's `authorize` gave it. Anyone can run Discord's login
  // against the app outside Discord, so only people Discord shows inside a running copy of the Activity get in, and
  // only members of a server the app was added to, and its testers, can open it. Answers with the access token the
  // Activity needs for Discord's `authenticate`.
  const sessionBody = z.object({ code: z.string().min(1), instanceId: z.string().min(1) });
  app.post('/api/discord/session', async (req, res) => {
    if (!discord) return void res.status(404).json({ error: 'discord_off' });
    const body = sessionBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'bad_request' });
    const accessToken = await discord.exchangeCode(body.data.code);
    if (!accessToken) return void res.status(401).json({ error: 'Discord refused the sign-in. Close the Activity and open it again.' });
    const user = await discord.user(accessToken);
    const instance = await discord.instance(body.data.instanceId);
    if (!instance?.users.includes(user.id)) return void res.status(403).json({ error: 'Open the Activity from a Discord call to sign in.' });
    await syncDiscordUser(db, user.id);
    startSession(res, user.id, inFrame);
    res.cookie(PLACE_COOKIE, instance.place, { ...inFrame, maxAge: SESSION_MS });
    res.json({ accessToken });
  });

  /** Starts a Discord login on the website, to sign in or, with `link`, to add Discord to that account. */
  function sendToDiscord(res: Response, returnTo: string, link?: number): string {
    const state = randomBytes(16).toString('base64url');
    res.cookie(LOGIN_COOKIE, JSON.stringify({ state, returnTo, link }), { ...onSite, maxAge: LOGIN_MS });
    return discord!.authorizeUrl(state, redirectUri);
  }

  app.get('/auth/discord/login', (req, res) => {
    if (!discord) return void res.status(404).send('Discord login is off on this server.');
    res.redirect(sendToDiscord(res, safeReturnTo(req.query.returnTo)));
  });

  app.get('/auth/discord/callback', async (req, res) => {
    const raw: unknown = req.signedCookies[LOGIN_COOKIE];
    res.clearCookie(LOGIN_COOKIE, onSite);
    const login = typeof raw === 'string' ? loginState.safeParse(JSON.parse(raw)) : null;
    const code = req.query.code;
    if (!discord || !login?.success || req.query.state !== login.data.state || typeof code !== 'string') return void res.redirect('/');
    const accessToken = await discord.exchangeCode(code, redirectUri);
    if (!accessToken) return void res.redirect('/');
    const user = await discord.user(accessToken);
    const { returnTo, link } = login.data;
    if (link === undefined) {
      await syncWebDiscordUser(db, user.id);
      startSession(res, user.id, onSite);
      return void res.redirect(returnTo);
    }
    const linked = await linkAccounts(db, link, (await syncWebDiscordUser(db, user.id)).id);
    res.redirect('error' in linked ? `/account?linkError=${encodeURIComponent(linked.error)}` : '/account');
  });

  // Linking, from the account page. An Auth0 account goes to Discord to add a Discord login.
  app.post('/api/me/link/discord', (_req, res) => {
    const v = viewerOf(res);
    if (v.kind !== 'user') return void res.status(401).json({ error: 'account_required' });
    if (!discord) return void res.status(404).json({ error: 'Discord login is off on this server.' });
    if (v.logins.discord) return void res.status(409).json({ error: 'This account already has a Discord login.' });
    res.json({ url: sendToDiscord(res, '/account', v.user.id) });
  });

  // A Discord account logs in through Auth0, then comes back to /auth/link/finish to join the two.
  app.post('/api/me/link/auth0', (req, res) => {
    const v = viewerOf(res);
    if (v.kind !== 'user') return void res.status(401).json({ error: 'account_required' });
    if (v.logins.auth0) return void res.status(409).json({ error: 'This account already has a website login.' });
    const discordId: unknown = req.signedCookies[SESSION_COOKIE];
    if (typeof discordId !== 'string') return void res.status(409).json({ error: 'Log in with Discord first.' });
    res.cookie(LINK_COOKIE, String(v.user.id), { ...onSite, maxAge: LOGIN_MS });
    res.json({ url: '/auth/login?returnTo=/auth/link/finish' });
  });

  return {
    /** The Discord user ID of whoever signed in with Discord on this browser, if anyone. */
    discordIdOf: (req: Request): string | null => {
      const id: unknown = req.signedCookies[SESSION_COOKIE];
      return typeof id === 'string' ? id : null;
    },
    /** Finishes linking after the Auth0 login, now that the browser holds both logins. */
    finishAuth0Link: async (req: Request, res: Response, auth0Account: number) => {
      const raw: unknown = req.signedCookies[LINK_COOKIE];
      res.clearCookie(LINK_COOKIE, onSite);
      if (typeof raw !== 'string') return void res.redirect('/account');
      const linked = await linkAccounts(db, auth0Account, Number(raw));
      res.redirect('error' in linked ? `/account?linkError=${encodeURIComponent(linked.error)}` : '/account');
    },
    findAccount: (discordId: string) => findUserByDiscordId(db, discordId),
  };
}
