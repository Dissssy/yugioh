// The deck builder's view of the card database (docs/deck-builder.md): every card, and whether each is in the game yet.
// Built once per card import and kept in memory, since the pool only changes with an import or a deploy.

import { gzipSync } from 'node:zlib';
import { desc } from 'drizzle-orm';
import { deckProblems, type Banlist, type CatalogCard, type DeckList, type RuleCard } from '@yugioh/shared';
import { poolCardIds, toCardData } from './cards.ts';
import type { Db } from './db/client.ts';
import { cardImports, cards } from './db/schema.ts';

export interface CatalogData {
  cards: Map<number, CatalogCard>;
  /** The JSON list of every card, and gzipped once for every request. */
  json: string;
  gzipped: Buffer;
  etag: string;
}

export class Catalog {
  private db: Db;
  private built: { key: string; data: Promise<CatalogData> } | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  async get(): Promise<CatalogData> {
    const [latest] = await this.db.select({ id: cardImports.id }).from(cardImports).orderBy(desc(cardImports.id)).limit(1);
    const key = String(latest?.id ?? 0);
    if (this.built?.key !== key) {
      const data = this.build(key);
      this.built = { key, data };
      data.catch(() => {
        if (this.built?.data === data) this.built = null;
      });
    }
    return this.built.data;
  }

  /** What keeps a deck out of a duel under the banlist. */
  async problems(deck: DeckList, banlist: Banlist, premade: boolean): Promise<string[]> {
    const { cards } = await this.get();
    return deckProblems(deck, (code) => cards.get(code) satisfies RuleCard | undefined, banlist, { premade });
  }

  private async build(key: string): Promise<CatalogData> {
    const [rows, pool] = await Promise.all([this.db.select().from(cards).orderBy(cards.name), poolCardIds(this.db)]);
    const inPool = new Set(pool);
    const list = rows.map((r): CatalogCard => {
      // Alternate artworks have passcodes of their own, which `.ydk` files from other tools may use.
      const art = ((r.raw as { card_images?: { id: number }[] }).card_images ?? []).map((i) => i.id).filter((id) => id !== r.id);
      return { ...toCardData(r), archetype: r.archetype, inPool: inPool.has(r.id), ...(art.length > 0 && { altCodes: art }) };
    });
    const json = JSON.stringify(list);
    return {
      cards: new Map(list.map((c) => [c.code, c])),
      json,
      gzipped: gzipSync(json),
      etag: `"catalog-${key}-${pool.length}"`,
    };
  }
}
