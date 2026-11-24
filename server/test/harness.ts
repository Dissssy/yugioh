// Runs the real app against a test database and a mock OpenID provider standing in for Auth0.
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { OAuth2Server } from 'oauth2-mock-server';
import type Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../src/app.ts';
import type { ModelCall } from '../src/judge/judge.ts';
import type { DuelUpdate, PlayerView } from '@yugioh/engine';
import type { DuelSummary } from '@yugioh/shared';
import type { LoginClaims } from '../src/accounts.ts';
import { connect, type Db } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

export const ADMIN_EMAIL = 'admin@example.com';

export interface Harness {
  db: Db;
  baseUrl: string;
  /** A stand-in for the YGOPRODeck API, serving the cards of the two starter decks. */
  ygoprodeck: string;
  imageDir: string;
  /** The identity the mock provider puts in the next ID token it issues. */
  setIdentity(claims: LoginClaims): void;
  /** Stands in for Claude, for both the judge and appeals. Unset, any model call fails the test. */
  setModel(model: ModelCall): void;
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

  const ygoprodeck = await startFakeYgoprodeck();
  const imageDir = await mkdtemp(join(tmpdir(), 'card-images-'));

  // The app needs its own public URL up front, so bind a port first and attach the app after.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  let model: ModelCall = () => Promise.reject(new Error('No model set for this test'));
  const call = (params: Anthropic.MessageCreateParamsNonStreaming) => model(params);
  const ai = { judge: call, appeal: call, judgeCalls: 300, appeals: 10, questions: 20, opponent: { call, model: 'claude-haiku-5-5', calls: 400, paceMs: 0 } };
  server.on('request', createApp({ ...fakeConfig(baseUrl, oidc.issuer.url!), CARD_IMAGE_DIR: imageDir, JUDGE_CALLS_PER_DUEL: 300, APPEALS_PER_DUEL: 10, QUESTIONS_PER_DUEL: 20, AI_OPPONENT_MODEL: 'claude-haiku-5-5', AI_CALLS_PER_DUEL: 400, RESPONSE_FLOOR_MS: 0, RESET_SHEETS: false }, db, ai, seeded(1)));

  return {
    db,
    baseUrl,
    ygoprodeck: ygoprodeck.url,
    imageDir,
    setIdentity: (claims) => void (identity = claims),
    setModel: (m) => void (model = m),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await new Promise((r) => ygoprodeck.server.close(r));
      await oidc.stop();
      await db.$client.end();
      await rm(imageDir, { recursive: true, force: true });
    },
  };
}

/** Serves the database version, the fixture cards and a placeholder for every image. */
async function startFakeYgoprodeck() {
  const cards = await readFile(new URL('./fixtures/cardinfo.json', import.meta.url), 'utf8');
  let base = '';
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    if (path === '/checkDBVer.php') return void res.end(JSON.stringify([{ database_version: '1.0', last_update: '' }]));
    // Point image URLs at this server.
    if (path === '/cardinfo.php') return void res.end(cards.replaceAll('https://images.ygoprodeck.com', base));
    if (path.startsWith('/images/')) return void res.end('jpg');
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { server, url: base };
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

/** Reads a Server-Sent Events stream one update at a time. */
export class Stream {
  private buffer = '';
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }
  /** The board after the next update. */
  async next(): Promise<PlayerView> {
    for (;;) {
      const update = await this.update();
      if (update.type !== 'judging') return update.type === 'sync' ? update.view : update.steps.at(-1)!.view;
    }
  }
  async update(): Promise<DuelUpdate> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const message = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (message.startsWith('data: ')) return JSON.parse(message.slice(6)) as DuelUpdate;
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('stream ended');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
  close() {
    void this.reader.cancel();
  }
}

/** A small seeded generator (mulberry32), so the duels in a test run are dealt the same way every time. */
export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plays out the start of a duel through the API: `host` challenges, `guest` takes the seat (as a guest named
 * `guestName` if signed out), each picks their deck, and both press Ready, so the duel starts. Returns the duel as the
 * host sees it.
 */
export async function startDuelVia(
  baseUrl: string,
  host: Browser,
  guest: Browser,
  [deck0, deck1]: [number, number],
  { banlistId, guestName }: { banlistId?: number; guestName?: string } = {},
): Promise<DuelSummary> {
  const ok = async <T>(res: Promise<{ status: number; body: T }>) => {
    const { status, body } = await res;
    if (status >= 300) throw new Error(`Starting the duel failed with ${status}: ${JSON.stringify(body)}`);
    return body;
  };
  const post = (b: Browser, path: string, body: unknown, method = 'POST') => b.json<DuelSummary>(`${baseUrl}/api${path}`, { method, body: JSON.stringify(body) });
  const duel = await ok(post(host, '/duels', { banlistId }));
  await ok(post(guest, `/duels/${duel.id}/join`, guestName ? { guestName } : {}));
  await ok(post(host, `/duels/${duel.id}/deck`, { deckId: deck0 }, 'PUT'));
  await ok(post(guest, `/duels/${duel.id}/deck`, { deckId: deck1 }, 'PUT'));
  await ok(post(guest, `/duels/${duel.id}/ready`, { ready: true }));
  return ok(post(host, `/duels/${duel.id}/ready`, { ready: true }));
}
