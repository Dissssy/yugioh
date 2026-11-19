import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { auth } from 'express-openid-connect';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Me } from '@yugioh/shared';
import { findUserBySub, listUsers, setStatus, setUsername, syncUser, toUser, type LoginClaims } from './accounts.ts';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { duelRoutes, type GuestCookie } from './duelRoutes.ts';
import { Duels, type Ai } from './duels.ts';
import { adoptGuest, findGuestByToken } from './guests.ts';
import { username } from './usernames.ts';
import { userKey, viewerOf, type Viewer } from './viewer.ts';

const GUEST_COOKIE = 'guest';
/** The guest cookie outlives any reasonable duel; the guest row, not the cookie, decides access. */
const GUEST_COOKIE_MS = 365 * 24 * 60 * 60 * 1000;
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function createApp(config: Config, db: Db, ai: Ai) {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  const secure = config.BASE_URL.startsWith('https:');

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
    const to = req.query.returnTo;
    const returnTo = typeof to === 'string' && /^\/(?![/\\])/.test(to) ? to : '/';
    res.oidc.login({ returnTo });
  });
  app.use(cookieParser(config.SESSION_SECRET));
  app.use(express.json());

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

    if (req.oidc.isAuthenticated()) {
      const claims = req.oidc.idTokenClaims as unknown as LoginClaims;
      const user = toUser((await findUserBySub(db, claims.sub)) ?? (await syncUser(db, claims, config.ADMIN_EMAIL)));
      // A guest who signs in to an approved account keeps playing their duels as that account.
      if (guest && user.status === 'approved' && (await adoptGuest(db, guest.id, userKey(user.id)))) guestCookie.clear(res);
      return { kind: 'user', user };
    }
    if (guest) return { kind: 'guest', guest: { name: guest.name }, guestId: guest.id };
    return { kind: 'anonymous' };
  }

  const viewer = viewerOf;

  function requireAdmin(_req: Request, res: Response, next: NextFunction) {
    const v = viewer(res);
    if (v.kind === 'user' && v.user.isAdmin) return next();
    res.status(403).json({ error: 'admin_required' });
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

  app.get('/api/admin/users', requireAdmin, async (_req, res) => {
    res.json(await listUsers(db));
  });

  const statusBody = z.object({ status: z.enum(['pending', 'approved', 'rejected']) });
  app.post('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
    const id = z.coerce.number().int().safeParse(req.params.id);
    const body = statusBody.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: 'bad_request' });
    const user = await setStatus(db, id.data, body.data.status);
    if (!user) return void res.status(404).json({ error: 'not_found' });
    res.json(user);
  });

  app.use('/api', duelRoutes(db, new Duels(db, ai), guestCookie));
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
