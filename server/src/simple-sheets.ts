// Sheets written by code, for cards whose whole text is one of a few fixed wordings: an Extra Deck monster that lists
// only its materials, an Equip Spell or Field Spell that only changes ATK/DEF, a Normal Spell that only deals damage,
// gains LP or draws, and a monster that only inflicts piercing damage. These need no model and cost nothing; every
// other card with text needs a written sheet (docs/card-pool.md).

import type { CardFilter, Continuous, EffectSheet, Materials, SheetEffect, Step } from '@yugioh/engine';

export interface SimpleCard {
  id: number;
  type: string;
  race: string;
  frameType: string;
  text: string;
  textHash: string;
}

const RACES = [
  'Aqua', 'Beast', 'Beast-Warrior', 'Creator-God', 'Cyberse', 'Dinosaur', 'Divine-Beast', 'Dragon', 'Fairy', 'Fiend',
  'Fish', 'Illusion', 'Insect', 'Machine', 'Plant', 'Psychic', 'Pyro', 'Reptile', 'Rock', 'Sea Serpent', 'Spellcaster',
  'Thunder', 'Warrior', 'Winged Beast', 'Wyrm', 'Zombie',
];
const ATTRIBUTES = ['DARK', 'DIVINE', 'EARTH', 'FIRE', 'LIGHT', 'WATER', 'WIND'];

const N = String.raw`(\d+)`;
/** One Type or Attribute as old and new texts word it: "FIRE", "Beast-Type", "Winged Beast". */
const KIND = String.raw`([A-Z][A-Za-z -]*?)(?:-Type)?`;
/** "Insect, Beast, Plant, and Beast-Warrior", "Warrior and Beast-Warrior", "LIGHT". */
const KINDS = String.raw`([A-Z][A-Za-z ,-]*?)(?:-Type)?`;

/** The sheet code writes for this card, or null if its text isn't one of the fixed wordings. */
export function simpleSheet(card: SimpleCard): EffectSheet | null {
  const text = card.text.trim();
  const sheet = (effects: SheetEffect[], materials: Materials | null = null): EffectSheet => ({
    code: card.id,
    textHash: card.textHash,
    model: 'generated',
    effects,
    materials,
    normalSummon: true,
  });
  if (/^(fusion|synchro|xyz)/.test(card.frameType)) {
    const materials = materialsOf(card.frameType, text);
    return materials && sheet([], materials);
  }
  if (card.frameType === 'spell' && card.race === 'Equip') {
    const equip = equipOf(text);
    return equip && sheet([activation(text, equip.target), effect('continuous', 'While this card is equipped to a monster', text, { continuous: equip.continuous })]);
  }
  if (card.frameType === 'spell' && card.race === 'Field') {
    const stats = fieldStatsOf(text);
    return stats && sheet([activation(text, null), ...stats.map((continuous) => effect('continuous', 'While this card is face-up on the field', text, { continuous }))]);
  }
  if (card.frameType === 'spell' && card.race === 'Normal') {
    const step = spellStepOf(text);
    return step && sheet([activation(text, null, [step])]);
  }
  if (card.frameType === 'effect') {
    const continuous = monsterContinuousOf(text);
    return continuous && sheet(continuous.map((c) => effect('continuous', 'While this card is face-up on the field', text, { continuous: c })));
  }
  return null;
}

function materialsOf(frameType: string, text: string): Materials | null {
  if (frameType.startsWith('fusion')) {
    if (!/^"[^"]+"( \+ "[^"]+")+$/.test(text)) return null;
    return { summon: 'fusion', materials: [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) };
  }
  if (frameType.startsWith('synchro')) {
    const m = /^(?:1 Tuner|"([^"]+)") \+ 1\+ non-Tuner monsters?$/.exec(text);
    return m && { summon: 'synchro', tuner: m[1] ?? null, nonTuners: { min: 1, max: null } };
  }
  const m = new RegExp(String.raw`^${N} Level ${N} monsters$`).exec(text);
  return m && { summon: 'xyz', count: Number(m[1]), level: Number(m[2]) };
}

/** "FIRE" or "Beast-Warrior" as a filter's attributes or races, or null if it is neither. */
function kindFilter(words: string[]): Pick<CardFilter, 'races' | 'attributes'> | null {
  const races = words.filter((w) => RACES.includes(w));
  const attributes = words.filter((w) => ATTRIBUTES.includes(w));
  return races.length + attributes.length === words.length ? { races, attributes } : null;
}

/** "Insect, Beast, Plant, and Beast-Warrior" → its words. */
const kindList = (words: string) => words.split(/,? and |, /).map((w) => w.trim());

const monsters = (overrides: Partial<CardFilter>): CardFilter => ({
  side: 'either',
  places: ['monsters'],
  kinds: ['monster'],
  types: [],
  races: [],
  attributes: [],
  named: null,
  except: null,
  extraDeck: null,
  faceUp: true,
  position: null,
  level: null,
  atk: null,
  def: null,
  original: false,
  ...overrides,
});

const stats = (to: 'self' | 'linked' | CardFilter, atk: number, def: number): Continuous => ({
  apply: 'stats',
  to,
  atk,
  def,
  per: null,
  levelDelta: 0,
  levelSet: null,
  while: [],
});

/** "ATK", "DEF" or both, gaining or losing an amount. */
function change(stat: string, amount: number): { atk: number; def: number } {
  const both = /ATK(\/| and )DEF/.test(stat);
  return { atk: both || stat === 'ATK' ? amount : 0, def: both || stat === 'DEF' ? amount : 0 };
}

const add = (a: { atk: number; def: number }, b: { atk: number; def: number }) => ({ atk: a.atk + b.atk, def: a.def + b.def });

const STAT = '(ATK/DEF|ATK and DEF|ATK|DEF)';

/** An Equip Spell's target and what it does to the equipped monster. */
function equipOf(text: string): { target: CardFilter; continuous: Continuous } | null {
  const patterns: [RegExp, (m: RegExpExecArray) => { kind: string | null; atk: number; def: number }][] = [
    [
      new RegExp(String.raw`^(?:Equip only to an? ${KIND} monster\. )?(?:It|The equipped monster) gains ${N} ${STAT}(?: and loses ${N} ${STAT})?\.$`),
      (m) => ({ kind: m[1] ?? null, ...add(change(m[3]!, Number(m[2])), m[4] ? change(m[5]!, -Number(m[4])) : { atk: 0, def: 0 }) }),
    ],
    [
      new RegExp(String.raw`^An? ${KIND} monster equipped with this card increases its ${STAT} by ${N} points(?: and decreases its ${STAT} by ${N} points)?\.$`),
      (m) => ({ kind: m[1]!, ...add(change(m[2]!, Number(m[3])), m[4] ? change(m[4], -Number(m[5])) : { atk: 0, def: 0 }) }),
    ],
    [
      new RegExp(String.raw`^Increase the ${STAT} of an? ${KIND} monster equipped with this card by ${N} points\.$`),
      (m) => ({ kind: m[2]!, ...change(m[1]!, Number(m[3])) }),
    ],
  ];
  for (const [pattern, read] of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    const { kind, atk, def } = read(m);
    const filter = kind ? kindFilter([kind]) : { races: [], attributes: [] };
    return filter && { target: monsters(filter), continuous: stats('linked', atk, def) };
  }
  if (/^If the equipped monster attacks a Defense Position monster, inflict piercing battle damage to your opponent\.$/.test(text)) {
    return { target: monsters({}), continuous: { apply: 'battle', to: 'linked', attacks: 1, piercing: true, noDamageToYou: false, direct: false, while: [] } };
  }
  return null;
}

/** "All X monsters (on the field) gain/lose ..." clauses, each a stats effect on those monsters. */
function allMonstersStats(text: string): Continuous[] | null {
  const clauses = text.replace(/\.$/, '').split(/, also |\. /);
  const out: Continuous[] = [];
  for (const clause of clauses) {
    const m = new RegExp(String.raw`^[Aa]ll ${KINDS} monsters(?: on the field)? (gain|lose) ${N} ${STAT}(?: and (gain|lose) ${N} ${STAT})?$`).exec(clause);
    const old = new RegExp(String.raw`^Increase the ${STAT} of all ${KINDS} monsters by ${N} points(?: and decreases? their ${STAT} by ${N} points)?$`).exec(clause);
    if (m) {
      const filter = kindFilter(kindList(m[1]!));
      if (!filter) return null;
      const first = change(m[4]!, m[2] === 'gain' ? Number(m[3]) : -Number(m[3]));
      const second = m[5] ? change(m[7]!, m[5] === 'gain' ? Number(m[6]) : -Number(m[6])) : { atk: 0, def: 0 };
      const { atk, def } = add(first, second);
      out.push(stats(monsters(filter), atk, def));
    } else if (old) {
      const filter = kindFilter(kindList(old[2]!));
      if (!filter) return null;
      const { atk, def } = add(change(old[1]!, Number(old[3])), old[4] ? change(old[4], -Number(old[5])) : { atk: 0, def: 0 });
      out.push(stats(monsters(filter), atk, def));
    } else return null;
  }
  return out;
}

function fieldStatsOf(text: string): Continuous[] | null {
  return allMonstersStats(text);
}

function monsterContinuousOf(text: string): Continuous[] | null {
  if (/^If this card attacks a Defense Position monster, inflict piercing battle damage(?: to your opponent)?\.$/.test(text)) {
    return [{ apply: 'battle', to: 'self', attacks: 1, piercing: true, noDamageToYou: false, direct: false, while: [] }];
  }
  return allMonstersStats(text);
}

/** A Normal Spell that only deals damage, gains LP or draws. */
function spellStepOf(text: string): Step | null {
  let m = new RegExp(String.raw`^(?:Inflict ${N} (?:points of )?damage to your opponent(?:'s Life Points)?|Decrease your opponent's Life Points by ${N} points)\.$`).exec(text);
  if (m) return { do: 'change_lp', player: 'opponent', amount: Number(m[1] ?? m[2]), per: null, kind: 'damage' };
  m = new RegExp(String.raw`^(?:Increase your Life Points by ${N}(?: points)?|Gain ${N} (?:Life Points|LP))\.$`).exec(text);
  if (m) return { do: 'change_lp', player: 'you', amount: Number(m[1] ?? m[2]), per: null, kind: 'gain' };
  m = /^Draw (1|2|3) cards?\.$/.exec(text);
  if (m) return { do: 'draw', player: 'you', count: Number(m[1]), per: null };
  return null;
}

function effect(kind: SheetEffect['kind'], window: string, text: string, parts: Partial<SheetEffect> = {}): SheetEffect {
  return {
    kind,
    speed: 1,
    mandatory: false,
    from: 'field',
    opt: 'none',
    window,
    cost: '',
    effect: text,
    targets: null,
    when: null,
    script: null,
    continuous: null,
    status: 'unverified',
    ...parts,
  };
}

/** A Spell's activation: equip to a target if it has one, else run these steps. */
function activation(text: string, target: CardFilter | null, steps: Step[] = []): SheetEffect {
  return effect('activation', 'Your Main Phase', text, {
    targets: target && 'a face-up monster the card can equip to',
    script: {
      conditions: [],
      cost: [],
      targets: target && { filter: target, min: 1, max: 1, others: true, event: false },
      options: [{ label: '', cost: [], steps: target ? [{ do: 'link', cards: { from: 'targets' } }] : steps }],
      unapplied: null,
    },
  });
}
