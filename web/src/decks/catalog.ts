import { useQuery } from '@tanstack/react-query';
import type { CatalogCard } from '@yugioh/shared';
import MiniSearch from 'minisearch';
import { useMemo } from 'react';
import { api } from '../api.ts';

/** Every card, and a fuzzy index over names and text, names counting most (docs/deck-builder.md, Search). */
export interface Catalog {
  cards: CatalogCard[];
  byCode: Map<number, CatalogCard>;
  /** A card by its passcode or an alternate artwork's, as `.ydk` files may list it. */
  resolve(code: number): CatalogCard | undefined;
  /** Passcodes of the best matches first. */
  search(text: string): number[];
}

function buildCatalog(cards: CatalogCard[]): Catalog {
  const index = new MiniSearch<CatalogCard>({
    idField: 'code',
    fields: ['name', 'text'],
    searchOptions: { boost: { name: 4 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
  });
  index.addAll(cards);
  const byCode = new Map(cards.map((c) => [c.code, c]));
  const byArt = new Map(cards.flatMap((c) => (c.altCodes ?? []).map((a) => [a, c] as const)));
  return {
    cards,
    byCode,
    resolve: (code) => byCode.get(code) ?? byArt.get(code),
    search: (text) => index.search(text).map((r) => r.id as number),
  };
}

/** The catalog changes only with a card import; the browser revalidates it with its ETag. */
export function useCatalog() {
  const list = useQuery({ queryKey: ['catalog'], queryFn: () => api<CatalogCard[]>('/cards'), staleTime: Infinity });
  const catalog = useMemo(() => (list.data ? buildCatalog(list.data) : null), [list.data]);
  return { catalog, isError: list.isError };
}
