import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { auth } from 'express-openid-connect';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Me } from '@yugioh/shared';
import { findUserBySub, listUsers, setStatus, syncUser, toUser, type LoginClaims } from './accounts.ts';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { createInvite, listInvites, lookupInvite, markRedeemed, revokeInvite } from './invites.ts';

const GUEST_COOKIE = 'guest';
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

type Viewer = Me & { guestToken?: string };

export function createApp(config: Config, db: Db) {
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
      authorizationParams: { response_type: 'code', scope: 'openid profile email' },
      routes: { login: '/auth/login', logout: '/auth/logout', callback: '/auth/callback', postLogoutRedirect: '/' },
      afterCallback: async (_req, _res, session) => {
        await syncUser(db, decodeJwt(session.id_token) as unknown as LoginClaims, config.ADMIN_EMAIL);
        return session;
      },
    }),
  );
  app.use(cookieParser(config.SESSION_SECRET));
  app.use(express.json());

  // Works out who is asking: a signed-in account, a guest holding an invite, or nobody.
  app.use('/api', async (req, res, next) => {
    res.locals.viewer = await resolveViewer(req);
    next();
  });

  async function resolveViewer(req: Request): Promise<Viewer> {
    if (req.oidc.isAuthenticated()) {
      const claims = req.oidc.idTokenClaims as unknown as LoginClaims;
      const row = (await findUserBySub(db, claims.sub)) ?? (await syncUser(db, claims, config.ADMIN_EMAIL));
      return { kind: 'user', user: toUser(row) };
    }
    const token: unknown = req.signedCookies[GUEST_COOKIE];
    if (typeof token === 'string') {
      const found = await lookupInvite(db, token);
      if (found.ok) return { kind: 'guest', invite: found.preview, guestToken: token };
    }
    return { kind: 'anonymous' };
  }

  const viewer = (res: Response) => res.locals.viewer as Viewer;

  function requireApproved(_req: Request, res: Response, next: NextFunction) {
    const v = viewer(res);
    if (v.kind === 'user' && v.user.status === 'approved') return next();
    res.status(v.kind === 'user' ? 403 : 401).json({ error: 'approved_account_required' });
  }

  function requireAdmin(_req: Request, res: Response, next: NextFunction) {
    const v = viewer(res);
    if (v.kind === 'user' && v.user.isAdmin) return next();
    res.status(403).json({ error: 'admin_required' });
  }

  const userId = (res: Response) => (viewer(res) as Extract<Me, { kind: 'user' }>).user.id;

  app.get('/api/me', (_req, res) => {
    const { guestToken: _, ...me } = viewer(res);
    res.json(me satisfies Me);
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

  app.get('/api/invites', requireApproved, async (_req, res) => {
    res.json(await listInvites(db, userId(res)));
  });

  app.post('/api/invites', requireApproved, async (_req, res) => {
    res.status(201).json(await createInvite(db, userId(res)));
  });

  app.delete('/api/invites/:token', requireApproved, async (req, res) => {
    const removed = await revokeInvite(db, userId(res), String(req.params.token));
    res.status(removed ? 204 : 404).end();
  });

  // Public: what an invite link shows before it is used.
  app.get('/api/join/:token', async (req, res) => {
    const found = await lookupInvite(db, req.params.token);
    if (!found.ok) return void res.status(404).json({ problem: found.problem });
    const v = viewer(res);
    const mine = v.kind === 'guest' && v.guestToken === req.params.token;
    if (found.redeemed && !mine) return void res.status(404).json({ problem: 'used' });
    res.json(found.preview);
  });

  // Uses an invite: the visitor becomes a guest until the invite expires or is revoked.
  app.post('/api/join/:token', async (req, res) => {
    const v = viewer(res);
    if (v.kind === 'user') return void res.status(409).json({ error: 'signed_in' });
    const token = req.params.token;
    if (v.kind !== 'guest' || v.guestToken !== token) {
      const found = await lookupInvite(db, token);
      if (!found.ok) return void res.status(404).json({ problem: found.problem });
      if (!(await markRedeemed(db, token))) return void res.status(404).json({ problem: 'used' });
      res.cookie(GUEST_COOKIE, token, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        secure,
        expires: new Date(found.preview.expiresAt),
      });
      return void res.json({ kind: 'guest', invite: found.preview } satisfies Me);
    }
    res.json({ kind: 'guest', invite: v.invite } satisfies Me);
  });

  app.post('/api/guest/leave', (_req, res) => {
    res.clearCookie(GUEST_COOKIE).status(204).end();
  });

  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not_found' }));

  // In production the server also serves the built web app.
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: webDist }));
  }

  return app;
}
