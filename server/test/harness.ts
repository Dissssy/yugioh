// Runs the real app against a test database and a mock OpenID provider standing in for Auth0.
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { sql } from 'drizzle-orm';
import { OAuth2Server } from 'oauth2-mock-server';
import { createApp } from '../src/app.ts';
import type { LoginClaims } from '../src/accounts.ts';
import { connect, type Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

export const ADMIN_EMAIL = 'admin@example.com';

export interface Harness {
  db: Db;
  baseUrl: string;
  /** The identity the mock provider puts in the next ID token it issues. */
  setIdentity(claims: LoginClaims): void;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const db = connect(process.env.TEST_DATABASE_URL ?? 'postgres://yugioh:yugioh@localhost:5432/yugioh_test');
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);

  const oidc = new OAuth2Server();
  await oidc.issuer.keys.generate('RS256');
  await oidc.start(0, 'localhost');
  let identity: LoginClaims = { sub: 'nobody' };
  oidc.service.on('beforeTokenSigning', (token) => {
    Object.assign(token.payload, identity);
  });

  // The app needs its own public URL up front, so bind a port first and attach the app after.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  server.on('request', createApp(fakeConfig(baseUrl, oidc.issuer.url!), db));

  return {
    db,
    baseUrl,
    setIdentity: (claims) => void (identity = claims),
    async close() {
      await new Promise((r) => server.close(r));
      await oidc.stop();
      await db.$client.end();
    },
  };
}

function fakeConfig(baseUrl: string, issuer: string) {
  return {
    BASE_URL: baseUrl,
    PORT: 0,
    DATABASE_URL: '',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    AUTH0_ISSUER_BASE_URL: issuer,
    AUTH0_CLIENT_ID: 'testclient',
    AUTH0_CLIENT_SECRET: 'test-client-secret',
    ADMIN_EMAIL,
  };
}

/** A browser stand-in: keeps cookies and follows redirects across the app and the provider. */
export class Browser {
  private cookies = new Map<string, Map<string, string>>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    let target = new URL(url);
    let req = init;
    for (let hops = 0; hops < 10; hops++) {
      const jar = this.cookies.get(target.host) ?? new Map();
      const headers = new Headers(req.headers);
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await fetch(target, { ...req, headers, redirect: 'manual' });
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair!.indexOf('=');
        const name = pair!.slice(0, eq).trim();
        const value = pair!.slice(eq + 1).trim();
        const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim())) || value === '';
        if (expired) jar.delete(name);
        else jar.set(name, value);
      }
      this.cookies.set(target.host, jar);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      target = new URL(location, target);
      req = {};
    }
    throw new Error('too many redirects');
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
}
