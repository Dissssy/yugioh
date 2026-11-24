// The card search's terms (docs/deck-builder.md, Search): `field:value` terms beside the words that search names and
// card text, such as `atk:>=1800 level:4 attr:dark dragon`. The filter menus write the same terms into the search box,
// so the box always shows the whole search.

import type { CatalogCard } from './api.ts';

type NumberField = 'atk' | 'def' | 'level';
type TextField = 'attr' | 'type' | 'kind' | 'arch' | 'name' | 'text' | 'is';
export type QueryField = NumberField | TextField;

/** What each field matches, for the help menu, with the names it also answers to. */
export const QUERY_FIELDS: { field: QueryField; aliases: string[]; help: string; example: string }[] = [
  { field: 'atk', aliases: [], help: 'ATK: a number, a comparison or a range', example: 'atk:>=1800' },
  { field: 'def', aliases: [], help: 'DEF, the same way', example: 'def:<=1000' },
  { field: 'level', aliases: ['lv', 'rank'], help: 'Level or Rank', example: 'level:5-6' },
  { field: 'attr', aliases: ['attribute'], help: 'Attribute', example: 'attr:dark' },
  { field: 'type', aliases: ['race'], help: "Monster type, or a Spell or Trap's property", example: 'type:dragon' },
  { field: 'kind', aliases: [], help: 'monster, spell, trap or extra (Extra Deck monsters)', example: 'kind:trap' },
  { field: 'arch', aliases: ['archetype'], help: 'Archetype, or part of its name', example: 'arch:"blue-eyes"' },
  { field: 'is', aliases: [], help: 'A word of the card type: tuner, effect, normal, fusion, ritual, synchro, xyz, link, flip…', example: 'is:tuner' },
  { field: 'name', aliases: [], help: 'Part of the name, exactly', example: 'name:dragon' },
  { field: 'text', aliases: [], help: 'Part of the card text, exactly', example: 'text:"draw 1 card"' },
];

const FIELD_BY_NAME = new Map(QUERY_FIELDS.flatMap((f) => [f.field, ...f.aliases].map((name) => [name, f.field] as const)));
const NUMBER_FIELDS = new Set<QueryField>(['atk', 'def', 'level']);

export type Comparison = '=' | '>' | '>=' | '<' | '<=';

export interface QueryTerm {
  field: QueryField;
  /** A `-` before the term keeps the cards that don't match it. */
  negated: boolean;
  /** The comparison typed after the colon; `=` when none was. */
  op: Comparison;
  /** As typed after it, without quotes. */
  value: string;
  /** For number fields: what the value means. */
  test?: (n: number) => boolean;
}

export interface ParsedQuery {
  /** The rest of the search, matched against names and card text. */
  words: string;
  terms: QueryTerm[];
  /** Terms that can't be read, as messages. */
  errors: string[];
}

/** A term (`-field:op"value"`) or a word, each possibly quoted. */
const TOKEN = /(-?)([a-z]+):(>=|<=|>|<|=)?("[^"]*"?|[^\s"]*)|"[^"]*"?|\S+/gi;
const unquote = (s: string) => s.replace(/^"|"$/g, '');

export function parseQuery(text: string): ParsedQuery {
  const words: string[] = [];
  const terms: QueryTerm[] = [];
  const errors: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const field = m[2] === undefined ? undefined : FIELD_BY_NAME.get(m[2].toLowerCase());
    if (!field) {
      words.push(unquote(m[0]));
      continue;
    }
    const value = unquote(m[4] ?? '').trim();
    if (value === '') continue; // still being typed
    const term: QueryTerm = { field, negated: m[1] === '-', op: (m[3] ?? '=') as Comparison, value };
    if (NUMBER_FIELDS.has(field)) {
      term.test = numberTest(term.op, value);
      if (!term.test) {
        errors.push(`${field}: needs a number, a comparison like >=1800, or a range like 4-6`);
        continue;
      }
    }
    terms.push(term);
  }
  return { words: words.join(' '), terms, errors };
}

function numberTest(op: Comparison, value: string): ((n: number) => boolean) | undefined {
  const range = /^(\d+)-(\d+)$/.exec(value);
  if (range && op === '=') {
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    return (n) => n >= lo && n <= hi;
  }
  if (!/^\d+$/.test(value)) return undefined;
  const v = Number(value);
  return { '=': (n: number) => n === v, '>': (n: number) => n > v, '>=': (n: number) => n >= v, '<': (n: number) => n < v, '<=': (n: number) => n <= v }[op];
}

/** Whether the card meets every term. */
export function matchesTerms(card: CatalogCard, terms: QueryTerm[]): boolean {
  return terms.every((t) => matchesTerm(card, t) !== t.negated);
}

function matchesTerm(card: CatalogCard, { field, value, test }: QueryTerm): boolean {
  const v = value.toLowerCase();
  const has = (s: string | null) => s !== null && s.toLowerCase().includes(v);
  switch (field) {
    case 'atk':
    case 'def':
    case 'level': {
      const n = card[field];
      return n !== null && test!(n);
    }
    case 'attr':
      return card.attribute?.toLowerCase() === v;
    case 'type':
      return card.race.toLowerCase() === v;
    case 'kind':
      return v === 'extra' ? card.extraDeck : card.kind === v;
    case 'arch':
      return has(card.archetype);
    case 'is':
      return card.type.toLowerCase().split(/[\s-]+/).includes(v);
    case 'name':
      return has(card.name);
    case 'text':
      return has(card.text);
  }
}

/** The value of the search's plain `field:value` term, as the filter menus show it; null if it has none. */
export function termValue(text: string, field: QueryField): string | null {
  return parseQuery(text).terms.find((t) => t.field === field && !t.negated && t.op === '=')?.value ?? null;
}

/** The search with its `field` terms replaced by `field:value`, or removed when `value` is null. */
export function setTerm(text: string, field: QueryField, value: string | null): string {
  const kept = [...text.matchAll(TOKEN)].filter((m) => m[2] === undefined || FIELD_BY_NAME.get(m[2].toLowerCase()) !== field).map((m) => m[0]);
  if (value !== null) kept.push(`${field}:${/[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value}`);
  return kept.join(' ');
}
