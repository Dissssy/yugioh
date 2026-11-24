import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { auth } from 'express-openid-connect';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { isAdmin, NO_BANLIST, type AdminDuels, type Me, type Rulings, type UserSettings } from '@yugioh/shared';
import { findUserBySub, listUsers, loginsOf, setRole, setStatus, setUsername, settingsOf, syncUser, toUser, updateSettings, type LoginClaims } from './accounts.ts';
import type { Config } from './config.ts';
import { duelCosts } from './costs.ts';
import { banlistRoutes } from './banlistRoutes.ts';
import { Catalog } from './catalog.ts';
import type { Db } from './db/client.ts';
import { deckForDuel, deckRoutes } from './deckRoutes.ts';
import type { DiscordApi } from './discord.ts';
import { discordRoutes, endDiscordSession, safeReturnTo } from './discordRoutes.ts';
import { duelRoutes, type GuestCookie } from './duelRoutes.ts';
import { Duels, type Ai } from './duels.ts';
import { adoptGuest, findGuestByToken } from './guests.ts';
import { matchReport, reportText } from './matchReport.ts';
import { Opponents } from './opponent/opponent.ts';
import { editSheet, resolveReport, rulings } from './rulings.ts';
import { username } from './usernames.ts';
import { userKey, viewerOf, type Viewer } from './viewer.ts';

const GUEST_COOKIE = 'guest';
/** The guest cookie outlives any reasonable duel; the guest row, not the cookie, decides access. */
const GUEST_COOKIE_MS = 365 * 24 * 60 * 60 * 1000;
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function createApp(config: Config, db: Db, ai: Ai, discord: DiscordApi | null, random?: () => number) {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  const secure = config.BASE_URL.startsWith('https:');

  // Logging out also ends a Discord login. Auth0's logout below then finishes it, or just goes home without one.
  app.get('/auth/logout', (_req, res, next) => {
    endDiscordSession(res);
    next();
  });
  app.use(
    auth({
      authRequired: false,
      auth0Logout: true,
      baseURL: config.BASE_URL,
      issuerBaseURL: config.AUTH0_ISSUER_BASE_URL,
      clientID: config.AUTH0_CLIENT_ID,
      clientSecret: config.AUTH0_CLIENT_SECRET,
      secret: config.SESSION_SECRET,
      authorizationParams: { response_type: 'code', scope: 'openid email' },
      routes: { login: false, logout: '/auth/logout', callback: '/auth/callback', postLogoutRedirect: '/' },
      afterCallback: async (_req, _res, session) => {
        await syncUser(db, decodeJwt(session.id_token) as unknown as LoginClaims, config.ADMIN_EMAIL);
        return session;
      },
    }),
  );
  // Login returns to the page that sent the visitor, such as a challenge link. Only paths on this site.
  app.get('/auth/login', (req, res) => {
    res.oidc.login({ returnTo: safeReturnTo(req.query.returnTo) });
  });
  app.use(cookieParser(config.SESSION_SECRET));
  app.use(express.json());

  // Linking a Discord account to an Auth0 login lands here after the Auth0 login (see discordRoutes.ts).
  app.get('/auth/link/finish', async (req, res) => {
    if (!req.oidc.isAuthenticated()) return void res.redirect('/account');
    const claims = req.oidc.idTokenClaims as unknown as LoginClaims;
    const row = (await findUserBySub(db, claims.sub)) ?? (await syncUser(db, claims, config.ADMIN_EMAIL));
    await discordLogins.finishAuth0Link(req, res, row.id);
  });

  const guestCookie: GuestCookie = {
    set: (res, token) =>
      void res.cookie(GUEST_COOKIE, token, { signed: true, httpOnly: true, sameSite: 'lax', secure, maxAge: GUEST_COOKIE_MS }),
    clear: (res) => void res.clearCookie(GUEST_COOKIE),
  };

  // Works out who is asking: a signed-in account, a guest, or nobody.
  app.use('/api', async (req, res, next) => {
    res.locals.viewer = await resolveViewer(req, res);
    next();
  });

  async function resolveViewer(req: Request, res: Response): Promise<Viewer> {
    const token: unknown = req.signedCookies[GUEST_COOKIE];
    const guest = typeof token === 'string' ? await findGuestByToken(db, token) : undefined;
    if (token !== undefined && !guest) guestCookie.clear(res);

    const row = await accountOf(req, res);
    if (row) {
      const user = toUser(row);
      // A guest who signs in to an approved account keeps playing their duels as that account.
      if (guest && user.status === 'approved' && (await adoptGuest(db, guest.id, userKey(user.id)))) guestCookie.clear(res);
      return { kind: 'user', user, settings: settingsOf(row), logins: loginsOf(row) };
    }
    if (guest) return { kind: 'guest', guest: { name: guest.name }, guestId: guest.id };
    return { kind: 'anonymous' };
  }

  /** The account signed in through Auth0 or, failing that, through Discord. */
  async function accountOf(req: Request, res: Response) {
    if (req.oidc.isAuthenticated()) {
      const claims = req.oidc.idTokenClaims as unknown as LoginClaims;
      return (await findUserBySub(db, claims.sub)) ?? (await syncUser(db, claims, config.ADMIN_EMAIL));
    }
    const discordId = discordLogins.discordIdOf(req);
    if (discordId === null) return null;
    const row = await discordLogins.findAccount(discordId);
    if (!row) endDiscordSession(res);
    return row ?? null;
  }

  const discordLogins = discordRoutes(app, config, db, discord);

  const viewer = viewerOf;

  function requireAdmin(_req: Request, res: Response, next: NextFunction) {
    const v = viewer(res);
    if (v.kind === 'user' && isAdmin(v.user.role)) return next();
    res.status(403).json({ error: 'admin_required' });
  }

  function requireSuperAdmin(_req: Request, res: Response, next: NextFunction) {
    const v = viewer(res);
    if (v.kind === 'user' && v.user.role === 'superAdmin') return next();
    res.status(403).json({ error: 'super_admin_required' });
  }

  app.get('/api/me', (_req, res) => {
    const v = viewer(res);
    const me: Me = v.kind === 'guest' ? { kind: 'guest', guest: v.guest } : v;
    res.json(me);
  });

  // Any account may rename itself, as often as it likes, to a name no other account has.
  const usernameBody = z.object({ username });
  app.post('/api/me/username', async (req, res) => {
    const v = viewer(res);
    if (v.kind !== 'user') return void res.status(401).json({ error: 'account_required' });
    const body = usernameBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'invalid_username' });
    const user = await setUsername(db, v.user.id, body.data.username);
    if (!user) return void res.status(409).json({ error: 'username_taken' });
    res.json(user);
  });

  // Settings change one or more at a time; the response is all of them.
  const settingsBody = z
    .strictObject({ opponentCards: z.enum(['faceThem', 'faceYou']) } satisfies { [K in keyof UserSettings]: z.ZodType<UserSettings[K]> })
    .partial();
  app.patch('/api/me/settings', async (req, res) => {
    const v = viewer(res);
    if (v.kind !== 'user') return void res.status(401).json({ error: 'account_required' });
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'invalid_settings' });
    res.json(await updateSettings(db, v.user.id, body.data));
  });

  app.get('/api/admin/users', requireAdmin, async (_req, res) => {
    res.json(await listUsers(db));
  });

  const statusBody = z.object({ status: z.enum(['pending', 'approved', 'rejected']) });
  app.post('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
    const id = z.coerce.number().int().safeParse(req.params.id);
    const body = statusBody.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'bad_request' });
    const user = await setStatus(db, id.data, body.data.status);
    if (!user) return void res.status(409).json({ error: "Only a player's status can change. Take away an admin's admin first." });
    res.json(user);
  });

  // Only the super admin makes admins, and only of approved accounts.
  const roleBody = z.object({ role: z.enum(['player', 'admin']) });
  app.post('/api/admin/users/:id/role', requireSuperAdmin, async (req, res) => {
    const id = z.coerce.number().int().safeParse(req.params.id);
    const body = roleBody.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'bad_request' });
    const user = await setRole(db, id.data, body.data.role);
    if (!user) return void res.status(409).json({ error: 'Only approved accounts can be made admins, and the super admin stays one.' });
    res.json(user);
  });

  const duels = new Duels(db, ai, random, config.RESPONSE_FLOOR_MS);
  const catalog = new Catalog(db);
  if (ai.opponent) {
    const opponents = new Opponents(duels, db, ai.opponent, config.RESPONSE_FLOOR_MS, random);
    duels.onAiSeat = (id, seat) => void opponents.attach(id, seat).catch((error: unknown) => console.error(`AI opponent in duel ${id} didn't start:`, error));
  }

  // A duel against the AI opponent (docs/ai-opponent.md): the super admin picks their deck and Claude's.
  const aiDuelBody = z.object({ deckId: z.number().int(), aiDeckId: z.number().int() });
  app.post('/api/admin/duels/ai', requireSuperAdmin, async (req, res) => {
    const v = viewer(res);
    if (v.kind !== 'user') return;
    if (!ai.opponent) return void res.status(503).json({ error: "Playing against Claude needs an Anthropic API key, and this server has none." });
    const body = aiDuelBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Pick a deck for each side.' });
    // Claude plays premade decks only: its deck plans (docs/ai-opponent.md) are written for them. No banlist applies.
    const [deck, aiDeck] = await Promise.all([deckForDuel(db, body.data.deckId, v.user.id), deckForDuel(db, body.data.aiDeckId, null)]);
    if (!deck || !aiDeck || !aiDeck.premade) return void res.status(404).json({ error: "That deck doesn't exist." });
    const [mine, claudes] = await Promise.all([catalog.problems(deck, NO_BANLIST, deck.premade), catalog.problems(aiDeck, NO_BANLIST, true)]);
    if (mine.length > 0 || claudes.length > 0) return void res.status(422).json({ error: mine[0] ?? claudes[0] });
    const id = await duels.createAgainstAi(v.user.id, userKey(v.user.id), v.user.username, deck, aiDeck);
    res.status(201).json(await duels.summarize((await duels.find(id))!, userKey(v.user.id), false));
  });

  app.get('/api/admin/duels', requireAdmin, async (_req, res) => {
    const { total, byDuel } = await duelCosts(db);
    const none = { judgeCalls: 0, appeals: 0, aiCalls: 0, questions: 0, cost: 0 };
    const list = await Promise.all((await duels.recent()).map(async (row) => ({ ...(await duels.summarize(row, null, false)), ...(byDuel.get(row.id) ?? none) })));
    res.json({ totalCost: total, duels: list } satisfies AdminDuels);
  });

  // A whole duel with nothing hidden, for review: plain text, or JSON with every event (judge transcripts included).
  app.get('/api/admin/duels/:id/report', requireAdmin, async (req, res) => {
    const report = await matchReport(db, String(req.params.id));
    if (!report) return void res.status(404).json({ error: 'not_found' });
    if (req.query.format === 'json') return void res.json(report);
    res.type('text/plain').send(reportText(report));
  });

  // Rulings: reported cards and set-aside scripts, the admin's sheet edits, and closing reports.
  app.get('/api/admin/rulings', requireAdmin, async (_req, res) => {
    res.json((await rulings(db)) satisfies Rulings);
  });

  const sheetBody = z.object({ sheet: z.unknown(), note: z.string().trim().min(1).max(1000) });
  app.post('/api/admin/sheets/:code', requireAdmin, async (req, res) => {
    const code = z.coerce.number().int().safeParse(req.params.code);
    const body = sheetBody.safeParse(req.body);
    if (!code.success || !body.success) return void res.status(400).json({ error: 'Give the sheet and a note on what changed.' });
    const saved = await editSheet(db, code.data, body.data.sheet, body.data.note);
    if ('error' in saved) return void res.status(400).json(saved);
    await duels.sheetChanged(code.data, saved.sheet);
    res.json(saved.sheet);
  });

  app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
    const id = z.coerce.number().int().safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: 'bad_request' });
    if (!(await resolveReport(db, id.data))) return void res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  // An admin request that fails says why, so the admin page can show it.
  app.use('/api/admin', (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  app.use('/api', deckRoutes(db, catalog));
  app.use('/api', banlistRoutes(db, catalog));
  app.use('/api', duelRoutes(db, catalog, duels, guestCookie));
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not_found' }));

  // Card images, downloaded by the card sync. They never change, so browsers may cache them for long.
  app.use('/card-images', express.static(config.CARD_IMAGE_DIR, { maxAge: '30d', fallthrough: false }));

  // In production the server also serves the built web app.
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: webDist }));
  }

  return app;
}
