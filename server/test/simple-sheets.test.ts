import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readSheetFiles, textHash } from '../src/sheets.ts';
import { simpleSheet } from '../src/simple-sheets.ts';

describe('sheets code writes', () => {
  it('match the written sheets of the cards they cover', async () => {
    const { data } = JSON.parse(await readFile(new URL('./fixtures/cardinfo.json', import.meta.url), 'utf8')) as {
      data: { id: number; name: string; type: string; race: string; frameType: string; desc: string }[];
    };
    const cards = Object.fromEntries(data.map((c) => [c.id, { code: c.id, name: c.name, text: c.desc } as never]));
    const files = await readSheetFiles(cards);
    const shape = (s: { materials: unknown; normalSummon: boolean; effects: { kind: string; script: unknown; continuous: unknown }[] }) => ({
      materials: s.materials,
      normalSummon: s.normalSummon,
      effects: s.effects.map((e) => [e.kind, e.script, e.continuous]),
    });
    let compared = 0;
    for (const c of data) {
      const generated = simpleSheet({ ...c, text: c.desc, textHash: textHash(c.desc) });
      const file = files[c.id];
      if (!generated || !file || file.model === 'generated') continue;
      expect(shape(generated), c.name).toEqual(shape(file));
      compared++;
    }
    expect(compared).toBeGreaterThan(30);
  });
});
