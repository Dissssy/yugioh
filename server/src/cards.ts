// Card data: imports the whole YGOPRODeck database into Postgres, builds the premade decks from it,
// and downloads the images the decks need. The game only ever reads from our own copy.
//
// YGOPRODeck's API guide (checked 2026-11-18) asks clients to store data locally, stay under 20 requests
// a second (or be blocked for an hour), and download images instead of hotlinking them.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CardData } from '@yugioh/engine';
import type { Db, Tx } from './db/client.ts';
import { banlists, cardImports, cards, decks } from './db/schema.ts';
import { importSheetFiles } from './sheets.ts';
import { type SimpleCard, simpleSheet } from './simple-sheets.ts';

export const YGOPRODECK_API = 'https://db.ygoprodeck.com/api/v7';

/** The premade decks, each exactly the cards printed in one YGOPRODeck set. */
export const PREMADE_DECKS = [
  { slug: '5ds-2008', name: "Yu-Gi-Oh! 5D's Starter Deck (2008)", set: "Starter Deck: Yu-Gi-Oh! 5D's" },
  { slug: 'dawn-of-the-xyz', name: 'Starter Deck: Dawn of the Xyz', set: 'Starter Deck: Dawn of the Xyz' },
  { slug: 'duelist-toolbox', name: 'Starter Deck: Duelist Toolbox', set: 'Starter Deck: Duelist Toolbox' },
  { slug: 'freezing-chains', name: 'Structure Deck: Freezing Chains', set: 'Structure Deck: Freezing Chains' },
  { slug: 'yugi-2002', name: 'Starter Deck: Yugi (2002)', set: 'Starter Deck: Yugi' },
  { slug: 'kaiba-2002', name: 'Starter Deck: Kaiba (2002)', set: 'Starter Deck: Kaiba' },
] as const;

/**
 * Every English TCG set by release date (server/card-sets.json, docs/card-pool.md): its list code, name, kind, release
 * date, and the YGOPRODeck set it maps to (null where YGOPRODeck has none).
 */
export interface CardSet {
  code: string;
  name: string;
  kind: string;
  released: string;
  ygoprodeck: string | null;
}

/**
 * The card pool grows down the set list, oldest first: every card printed in the sets up to and including this one
 * (by list code) is in the pool, along with the premade decks' cards. Pool cards get effect sheets and images.
 */
export const POOL_THROUGH = 'MRD';

/**
 * Cards that need no written sheet (Normal Monsters, and cards `simpleSheet` covers) join the pool ahead of their set
 * once they are printed in a set released in or before this year. It moves up a year at a time.
 */
export const POOL_YEAR = 2002;

/** Whether a card needs no written sheet: a Normal Monster, or one whose sheet code writes. */
export const isFreeCard = (card: SimpleCard) => card.frameType === 'normal' || simpleSheet(card) !== null;

export async function readCardSets(): Promise<CardSet[]> {
  return JSON.parse(await readFile(new URL('../card-sets.json', import.meta.url), 'utf8')) as CardSet[];
}

/** The YGOPRODeck set names of the sets in the pool. */
export async function poolSetNames(through = POOL_THROUGH): Promise<string[]> {
  const sets = await readCardSets();
  const end = sets.findIndex((s) => s.code === through);
  if (end < 0) throw new Error(`No set "${through}" in card-sets.json`);
  return sets.slice(0, end + 1).flatMap((s) => (s.ygoprodeck ? [s.ygoprodeck] : []));
}

/** The YGOPRODeck set names of the sets released in or before the year. */
export async function setNamesThrough(year = POOL_YEAR): Promise<string[]> {
  return (await readCardSets()).flatMap((s) => (s.ygoprodeck && Number(s.released.slice(0, 4)) <= year ? [s.ygoprodeck] : []));
}

const printedIn = (names: string[]) => sql`exists (select 1 from jsonb_array_elements(${cards.raw}->'card_sets') s where s->>'set_name' in ${names})`;

/** Passcodes of every card in the pool: printed in a pool set, a free card printed by POOL_YEAR, or in a premade deck. */
export async function poolCardIds(db: Db): Promise<number[]> {
  const printed = await db.select({ id: cards.id }).from(cards).where(printedIn(await poolSetNames()));
  const byYear = await db.select().from(cards).where(printedIn(await setNamesThrough()));
  const premade = await db.select({ main: decks.main, extra: decks.extra }).from(decks).where(sql`${decks.slug} is not null`);
  return [
    ...new Set([
      ...printed.map((r) => r.id),
      ...byYear.filter(isFreeCard).map((r) => r.id),
      ...premade.flatMap((d) => [...d.main, ...d.extra]),
    ]),
  ];
}

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

/** Brings our card database, premade decks and the pool's images up to date. Cheap when nothing changed. */
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
      await tx.insert(cardImports).values({ databaseVersion: version, cardCount: all.length });
    });
    log(`Imported ${all.length} cards.`);
  }
  // From our copy every time, so a deck added to PREMADE_DECKS appears without waiting for a new YGOPRODeck version.
  await buildPremadeDecks(db);
  await buildDefaultBanlists(db);
  await downloadPoolImages(db, options.imageDir, options.imageGapMs ?? 100, log);
  // Cards new to the database get their sheets from the repository (the server's start imports the rest).
  const imported = await importSheetFiles(db);
  if (imported) log(`Imported ${imported} effect sheets from server/effect-sheets/.`);
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
/**
 * The set codes of a card's copies in a premade deck. YGOPRODeck lists a deck's reprints in other regions under the
 * same set name (SDY-006 and SDY-E005 are the same Dark Magician), so only the card's largest family of codes counts.
 */
function copiesIn(card: ApiCard, set: string): string[] {
  const families = new Map<string, string[]>();
  for (const s of card.card_sets ?? []) {
    if (s.set_name !== set) continue;
    const family = s.set_code.replace(/\d+$/, '');
    families.set(family, [...(families.get(family) ?? []), s.set_code]);
  }
  return [...families.values()].reduce<string[]>((best, codes) => (codes.length > best.length ? codes : best), []);
}

async function buildPremadeDecks(db: Db) {
  for (const deck of PREMADE_DECKS) {
    const rows = await db
      .select({ raw: cards.raw })
      .from(cards)
      .where(sql`${cards.raw}->'card_sets' @> ${JSON.stringify([{ set_name: deck.set }])}::jsonb`);
    const printings = rows
      .map((r) => r.raw as ApiCard)
      .flatMap((c) => copiesIn(c, deck.set).map((code) => ({ code, card: c })))
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

/**
 * The default banlists (docs/deck-builder.md, Banlists), rebuilt from YGOPRODeck's `banlist_info` on every import, so
 * they follow the current lists. The first is preselected for a new challenge or deck.
 */
export const DEFAULT_BANLISTS = [
  { slug: 'tcg', name: 'TCG', field: 'ban_tcg' },
  { slug: 'ocg', name: 'OCG', field: 'ban_ocg' },
  { slug: 'goat', name: 'Goat', field: 'ban_goat' },
  { slug: 'none', name: 'No list', field: null },
] as const;

const LIMITS: Record<string, number> = { Forbidden: 0, Banned: 0, Limited: 1, 'Semi-Limited': 2 };

async function buildDefaultBanlists(db: Db) {
  const rows = await db
    .select({ id: cards.id, info: sql<Record<string, string>>`${cards.raw}->'banlist_info'` })
    .from(cards)
    .where(sql`${cards.raw} ? 'banlist_info'`);
  for (const list of DEFAULT_BANLISTS) {
    const limits: Record<string, number> = {};
    if (list.field)
      for (const row of rows) {
        const limit = LIMITS[row.info[list.field] ?? ''];
        if (limit !== undefined) limits[row.id] = limit;
      }
    await db
      .insert(banlists)
      .values({ slug: list.slug, name: list.name, limits })
      .onConflictDoUpdate({ target: banlists.slug, set: { name: list.name, limits, updatedAt: sql`now()` } });
  }
}

/** Downloads the full and small image of every pool card that we don't have yet. */
async function downloadPoolImages(db: Db, imageDir: string, gapMs: number, log: (message: string) => void) {
  const ids = await poolCardIds(db);
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
  // YGOPRODeck's `type` leaves "Effect" out for Extra Deck monsters ("Synchro Monster" for Brionac); its `typeline`
  // (the monster type, then the rest of the line) has every word, so filters on "Effect" fit them.
  const typeline = (row.raw as { typeline?: string[] }).typeline;
  return {
    code: row.id,
    name: row.name,
    type: typeline ? [...typeline.slice(1), 'Monster'].join(' ') : row.type,
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
