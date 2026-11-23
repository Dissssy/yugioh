// Writes server/test/fixtures/cardinfo.json: the YGOPRODeck cards the tests import, which are every card of the
// premade decks and the card pool (see POOL_THROUGH in src/cards.ts). Run it again whenever the pool grows:
//
//   NODE_USE_ENV_PROXY=1 node server/scripts/fixture.ts

import { writeFile } from 'node:fs/promises';
import { PREMADE_DECKS, poolSetNames, YGOPRODECK_API } from '../src/cards.ts';

const res = await fetch(`${YGOPRODECK_API}/cardinfo.php`);
if (!res.ok) throw new Error(`cardinfo.php answered ${res.status}`);
const { data } = (await res.json()) as { data: Record<string, unknown>[] };
const sets = new Set([...PREMADE_DECKS.map((d) => d.set), ...(await poolSetNames())]);
const cards = data
  .filter((c) => (c.card_sets as { set_name: string }[] | undefined)?.some((s) => sets.has(s.set_name)))
  .map(({ card_prices: _, ygoprodeck_url: __, typeline: ___, ...c }) => c)
  .sort((a, b) => (a.id as number) - (b.id as number));
await writeFile(new URL('../test/fixtures/cardinfo.json', import.meta.url), `${JSON.stringify({ data: cards })}\n`);
console.log(`Wrote ${cards.length} cards.`);
