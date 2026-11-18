// Card data: imports the whole YGOPRODeck database into Postgres, builds the premade decks from it,
// and downloads the images the decks need. The game only ever reads from our own copy.
//
// YGOPRODeck's API guide (checked 2026-11-18) asks clients to store data locally, stay under 20 requests
// a second (or be blocked for an hour), and download images instead of hotlinking them.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CardData } from '@yugioh/engine';
import type { Db, Tx } from './db/client.ts';
import { cardImports, cards, decks } from './db/schema.ts';

export const YGOPRODECK_API = 'https://db.ygoprodeck.com/api/v7';

/** The premade decks, each exactly the cards printed in one YGOPRODeck set. */
export const PREMADE_DECKS = [
  { slug: '5ds-2008', name: "Yu-Gi-Oh! 5D's Starter Deck (2008)", set: "Starter Deck: Yu-Gi-Oh! 5D's" },
  { slug: 'dawn-of-the-xyz', name: 'Starter Deck: Dawn of the Xyz', set: 'Starter Deck: Dawn of the Xyz' },
] as const;

const apiCard = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  frameType: z.string(),
  desc: z.string(),
  atk: z.number().int().nullish(),
  def: z.number().int().nullish(),
  level: z.number().int().nullish(),
  race: z.string(),
  attribute: z.string().nullish(),
  archetype: z.string().nullish(),
  card_sets: z.array(z.looseObject({ set_name: z.string(), set_code: z.string() })).optional(),
  card_images: z.array(z.looseObject({ id: z.number().int(), image_url: z.string(), image_url_small: z.string() })),
});
type ApiCard = z.infer<typeof apiCard>;

export interface SyncOptions {
  /** Where card images are stored: `<dir>/<id>.jpg` and `<dir>/small/<id>.jpg`. */
  imageDir: string;
  api?: string;
  /** Re-import even if YGOPRODeck's database version hasn't changed. */
  force?: boolean;
  /** Pause between image downloads; the default keeps well under YGOPRODeck's 20 requests a second. */
  imageGapMs?: number;
  log?: (message: string) => void;
}

/** Brings our card database, premade decks and their images up to date. Cheap when nothing changed. */
export async function syncCards(db: Db, options: SyncOptions) {
  const { api = YGOPRODECK_API, force = false, log = () => {} } = options;
  const [{ database_version: version }] = z
    .tuple([z.looseObject({ database_version: z.string() })])
    .parse(await getJson(`${api}/checkDBVer.php`));
  const last = await db.query.cardImports.findFirst({ orderBy: [desc(cardImports.importedAt)] });

  if (force || last?.databaseVersion !== version) {
    log(`Importing YGOPRODeck database version ${version}…`);
    const all = z.object({ data: z.array(apiCard) }).parse(await getJson(`${api}/cardinfo.php`)).data;
    await db.transaction(async (tx) => {
      await upsertCards(tx, all);
      await buildPremadeDecks(tx, all);
      await tx.insert(cardImports).values({ databaseVersion: version, cardCount: all.length });
    });
    log(`Imported ${all.length} cards.`);
  }
  await downloadDeckImages(db, options.imageDir, options.imageGapMs ?? 100, log);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function upsertCards(db: Tx, all: ApiCard[]) {
  const rows = all.map((c) => {
    const { card_prices: _, ...raw } = c;
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      frameType: c.frameType,
      text: c.desc,
      textHash: createHash('sha256').update(c.desc).digest('hex'),
      atk: c.atk ?? null,
      def: c.def ?? null,
      level: c.level ?? null,
      race: c.race,
      attribute: c.attribute ?? null,
      archetype: c.archetype ?? null,
      raw,
    };
  });
  const changed = (column: string) => sql.raw(`excluded.${column}`);
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(cards)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: cards.id,
        set: {
          name: changed('name'),
          type: changed('type'),
          frameType: changed('frame_type'),
          text: changed('text'),
          textHash: changed('text_hash'),
          atk: changed('atk'),
          def: changed('def'),
          level: changed('level'),
          race: changed('race'),
          attribute: changed('attribute'),
          archetype: changed('archetype'),
          raw: changed('raw'),
          updatedAt: sql`now()`,
        },
      });
  }
}

const isExtraDeck = (frameType: string) => /^(fusion|synchro|xyz|link)/.test(frameType);

/** One copy of a card per printing in the set, in set-number order. */
async function buildPremadeDecks(db: Tx, all: ApiCard[]) {
  for (const deck of PREMADE_DECKS) {
    const printings = all
      .flatMap((c) => (c.card_sets ?? []).filter((s) => s.set_name === deck.set).map((s) => ({ code: s.set_code, card: c })))
      .sort((a, b) => a.code.localeCompare(b.code));
    if (printings.length === 0) throw new Error(`No cards found for set "${deck.set}"`);
    const main = printings.filter((p) => !isExtraDeck(p.card.frameType)).map((p) => p.card.id);
    const extra = printings.filter((p) => isExtraDeck(p.card.frameType)).map((p) => p.card.id);
    await db
      .insert(decks)
      .values({ slug: deck.slug, name: deck.name, main, extra })
      .onConflictDoUpdate({ target: decks.slug, set: { name: deck.name, main, extra } });
  }
}

/** Downloads the full and small image of every card in a premade deck that we don't have yet. */
async function downloadDeckImages(db: Db, imageDir: string, gapMs: number, log: (message: string) => void) {
  const all = await db.select({ main: decks.main, extra: decks.extra }).from(decks);
  const ids = [...new Set(all.flatMap((d) => [...d.main, ...d.extra]))];
  if (ids.length === 0) return;
  const rows = await db.select({ id: cards.id, raw: cards.raw }).from(cards).where(inArray(cards.id, ids));
  await mkdir(join(imageDir, 'small'), { recursive: true });
  let fetched = 0;
  for (const row of rows) {
    const image = (row.raw as ApiCard).card_images[0];
    if (!image) continue;
    for (const [url, path] of [
      [image.image_url, join(imageDir, `${row.id}.jpg`)],
      [image.image_url_small, join(imageDir, 'small', `${row.id}.jpg`)],
    ] as const) {
      if (existsSync(path)) continue;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
      fetched++;
      await sleep(gapMs);
    }
  }
  if (fetched > 0) log(`Downloaded ${fetched} card images.`);
}

/** Runs the sync now and then once a day. Failures are logged and retried at the next run. */
export function scheduleCardSync(db: Db, options: SyncOptions) {
  const run = () =>
    syncCards(db, options).catch((error: unknown) => console.error('Card sync failed:', error));
  void run();
  return setInterval(run, 24 * 60 * 60 * 1000);
}

type CardRow = typeof cards.$inferSelect;

export function toCardData(row: CardRow): CardData {
  const kind = row.frameType === 'spell' ? 'spell' : row.frameType === 'trap' ? 'trap' : 'monster';
  return {
    code: row.id,
    name: row.name,
    type: row.type,
    kind,
    extraDeck: isExtraDeck(row.frameType),
    text: row.text,
    level: row.level,
    atk: row.atk,
    def: row.def,
    attribute: row.attribute,
    race: row.race,
  };
}

/** Card data for the given passcodes, keyed by passcode. */
export async function loadCards(db: Db, ids: number[]): Promise<Record<number, CardData>> {
  if (ids.length === 0) return {};
  const rows = await db.select().from(cards).where(inArray(cards.id, [...new Set(ids)]));
  return Object.fromEntries(rows.map((r) => [r.id, toCardData(r)]));
}

if (import.meta.main) {
  const { cardImageDir } = await import('./config.ts');
  const { connect } = await import('./db/client.ts');
  const { runMigrations } = await import('./db/migrate.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  await runMigrations(db);
  await syncCards(db, { imageDir: cardImageDir(), force: process.argv.includes('--force'), log: console.log });
  await db.$client.end();
}
