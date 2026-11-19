// The judge's eval suite: hand-written boards, an activation, and the expected outcome. Runs against the real
// model, so it costs a little (Haiku 5.5, a few cents for the whole suite) and needs ANTHROPIC_API_KEY and a
// database with the cards imported. Run it after any change to the rules reference, the tools or the model settings:
//
//   npm run judge:eval            all cases
//   npm run judge:eval -- vortex  cases whose name contains "vortex"
//
// Each verified ruling (layer 6) becomes another case here.

import Anthropic from '@anthropic-ai/sdk';
import { inArray } from 'drizzle-orm';
import {
  cardOf,
  decide,
  evolve,
  replay,
  statsOf,
  type CardData,
  type DuelEvent,
  type DuelState,
  type Seat,
} from '@yugioh/engine';
import { toCardData } from '../cards.ts';
import type { Db } from '../db/client.ts';
import { cards } from '../db/schema.ts';
import { loadSheets } from '../sheets.ts';
import { judge, type ModelCall, type Question } from './judge.ts';

/** One side of a board, by card name. Field monsters are face-up in Attack Position unless listed under `setMonsters`. */
interface Side {
  hand?: string[];
  monsters?: string[];
  defense?: string[];
  setMonsters?: string[];
  /** Set Spells/Traps, Set on an earlier turn. */
  set?: string[];
  /** Face-up Continuous Spells/Traps. */
  faceUp?: string[];
  gy?: string[];
  banished?: string[];
  deck?: string[];
  extra?: string[];
}

export interface EvalCase {
  name: string;
  /** Player 0 is on turn, in Main Phase 1 of turn 3. */
  board: [Side, Side];
  activate: string;
  /** Names or choices to pick, one list per question, in order. Unlisted questions get the first options. */
  picks?: string[][];
  legal: boolean;
  /** Checks the board after resolution; returns a problem, or null. */
  check?: (b: Board) => string | null;
}

/** The board after the effect, with lookups by card name. */
class Board {
  state: DuelState;
  constructor(state: DuelState) {
    this.state = state;
  }
  where(name: string, seat?: Seat): string[] {
    const found: string[] = [];
    for (const s of [0, 1] as Seat[]) {
      if (seat !== undefined && s !== seat) continue;
      const p = this.state.players[s];
      const places = { hand: p.hand, deck: p.deck, gy: p.graveyard, banished: p.banished, extra: p.extra };
      for (const [place, ids] of Object.entries(places)) for (const id of ids) if (cardOf(this.state, id).name === name) found.push(`${s}:${place}`);
      for (const c of p.monsters) if (c && cardOf(this.state, c.id).name === name) found.push(`${s}:monsters`);
      for (const c of p.spellTraps) if (c && cardOf(this.state, c.id).name === name) found.push(`${s}:spellTraps`);
    }
    return found;
  }
  monster(name: string) {
    const m = this.state.players.flatMap((p) => p.monsters).find((c) => c && cardOf(this.state, c.id).name === name);
    return m ? { ...m, ...statsOf(this.state, m.id) } : null;
  }
  lp = (seat: Seat) => this.state.players[seat].lp;
}

const expectAt = (b: Board, name: string, place: string) => (b.where(name).includes(place) ? null : `${name} is at ${b.where(name).join(', ') || 'nowhere'}, expected ${place}`);
const all = (...problems: (string | null)[]) => problems.find((p) => p !== null) ?? null;

export const CASES: EvalCase[] = [
  {
    name: 'monster reincarnation returns a monster',
    board: [{ hand: ['Monster Reincarnation', 'Sonic Chick'], gy: ['Junk Synchron'] }, {}],
    activate: 'Monster Reincarnation',
    legal: true,
    check: (b) => all(expectAt(b, 'Junk Synchron', '0:hand'), expectAt(b, 'Sonic Chick', '0:gy'), expectAt(b, 'Monster Reincarnation', '0:gy')),
  },
  {
    name: 'monster reincarnation needs a monster in your GY',
    board: [{ hand: ['Monster Reincarnation', 'Sonic Chick'], gy: ['Twister'] }, { gy: ['Junk Synchron'] }],
    activate: 'Monster Reincarnation',
    legal: false,
  },
  {
    name: 'lightning vortex destroys face-up monsters only',
    board: [{ hand: ['Lightning Vortex', 'Twister'] }, { monsters: ['Speed Warrior', 'Sonic Chick'], setMonsters: ['Mystic Tomato'] }],
    activate: 'Lightning Vortex',
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '1:gy'), expectAt(b, 'Sonic Chick', '1:gy'), expectAt(b, 'Mystic Tomato', '1:monsters'), expectAt(b, 'Twister', '0:gy')),
  },
  {
    name: 'lightning vortex needs a card to discard',
    board: [{ hand: ['Lightning Vortex'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Lightning Vortex',
    legal: false,
  },
  {
    name: 'twister pays 500 and destroys a face-up spell',
    board: [{ hand: ['Twister'] }, { faceUp: ['Banner of Courage'] }],
    activate: 'Twister',
    legal: true,
    check: (b) => all(expectAt(b, 'Banner of Courage', '1:gy'), b.lp(0) === 7500 ? null : `LP ${b.lp(0)}, expected 7500`),
  },
  {
    name: 'twister needs a face-up spell or trap',
    board: [{ hand: ['Twister'] }, { set: ['Trap Hole'] }],
    activate: 'Twister',
    legal: false,
  },
  {
    name: 'double summon grants a second normal summon',
    board: [{ hand: ['Double Summon'] }, {}],
    activate: 'Double Summon',
    legal: true,
    check: (b) => (b.state.normalSummonLimit === 2 ? null : `limit ${b.state.normalSummonLimit}`),
  },
  {
    name: 'smashing ground destroys the highest DEF',
    board: [{ hand: ['Smashing Ground'] }, { monsters: ['Speed Warrior', 'Sonic Chick'], defense: ['Ganbara Knight'] }],
    activate: 'Smashing Ground',
    legal: true,
    check: (b) => all(expectAt(b, 'Ganbara Knight', '1:gy'), expectAt(b, 'Speed Warrior', '1:monsters')),
  },
  {
    name: 'fissure destroys the lowest ATK',
    board: [{ hand: ['Fissure'] }, { monsters: ['Speed Warrior', 'Sonic Chick'] }],
    activate: 'Fissure',
    legal: true,
    check: (b) => all(expectAt(b, 'Sonic Chick', '1:gy'), expectAt(b, 'Speed Warrior', '1:monsters')),
  },
  {
    name: 'fissure needs a face-up monster',
    board: [{ hand: ['Fissure'] }, { setMonsters: ['Sonic Chick'] }],
    activate: 'Fissure',
    legal: false,
  },
  {
    name: 'rush recklessly gives 700 ATK',
    board: [{ hand: ['Rush Recklessly'], monsters: ['Speed Warrior'] }, {}],
    activate: 'Rush Recklessly',
    legal: true,
    check: (b) => (b.monster('Speed Warrior')?.atk === 1600 ? null : `ATK ${b.monster('Speed Warrior')?.atk}`),
  },
  {
    name: 'the warrior returning alive needs a warrior in your GY',
    board: [{ hand: ['The Warrior Returning Alive'], gy: ['Sonic Chick'] }, {}],
    activate: 'The Warrior Returning Alive',
    legal: false,
  },
  {
    name: 'the warrior returning alive returns a warrior',
    board: [{ hand: ['The Warrior Returning Alive'], gy: ['Sonic Chick', 'Speed Warrior'] }, {}],
    activate: 'The Warrior Returning Alive',
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '0:hand'), expectAt(b, 'Sonic Chick', '0:gy')),
  },
  {
    name: 'synchro blast wave needs a synchro monster',
    board: [{ hand: ['Synchro Blast Wave'], monsters: ['Speed Warrior'] }, { monsters: ['Sonic Chick'] }],
    activate: 'Synchro Blast Wave',
    legal: false,
  },
  {
    name: 'poison of the old man inflicts 800 when chosen',
    board: [{ hand: ['Poison of the Old Man'] }, {}],
    activate: 'Poison of the Old Man',
    picks: [['800']],
    legal: true,
    check: (b) => (b.lp(1) === 7200 && b.lp(0) === 8000 ? null : `LP ${b.lp(0)} / ${b.lp(1)}`),
  },
  {
    name: 'exiled force tributes itself to destroy a monster',
    board: [{ monsters: ['Exiled Force'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Exiled Force',
    picks: [['Speed Warrior']],
    legal: true,
    check: (b) => all(expectAt(b, 'Exiled Force', '0:gy'), expectAt(b, 'Speed Warrior', '1:gy')),
  },
  {
    name: 'key man becomes level 3',
    board: [{ monsters: ['Key Man the Key Warrior'] }, {}],
    activate: 'Key Man the Key Warrior',
    legal: true,
    check: (b) => (b.monster('Key Man the Key Warrior')?.level === 3 ? null : `Level ${b.monster('Key Man the Key Warrior')?.level}`),
  },
  {
    name: 'blustering winds gives 1000 ATK and DEF',
    board: [{ hand: ['Blustering Winds'], monsters: ['Sonic Chick'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Blustering Winds',
    legal: true,
    check: (b) => {
      const m = b.monster('Sonic Chick');
      return m?.atk === 1300 && m.def === 1300 ? null : `ATK/DEF ${m?.atk}/${m?.def}`;
    },
  },
  {
    name: 'mystical space typhoon destroys a set card',
    board: [{ hand: ['Mystical Space Typhoon'] }, { set: ['Mirror Force'] }],
    activate: 'Mystical Space Typhoon',
    legal: true,
    check: (b) => expectAt(b, 'Mirror Force', '1:gy'),
  },
  {
    name: 'sakuretsu armor needs an attack',
    board: [{ set: ['Sakuretsu Armor'], monsters: ['Speed Warrior'] }, { monsters: ['Sonic Chick'] }],
    activate: 'Sakuretsu Armor',
    legal: false,
  },
  {
    name: 'reinforce truth summons a level 2 warrior from the deck',
    board: [{ set: ['Reinforce Truth'], deck: ['Speed Warrior', 'Sonic Chick', 'Exiled Force'] }, {}],
    activate: 'Reinforce Truth',
    picks: [['Speed Warrior']],
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '0:monsters'), expectAt(b, 'Reinforce Truth', '0:gy')),
  },
  {
    name: 'backup soldier needs 5 monsters in the GY',
    board: [{ set: ['Backup Soldier'], gy: ['Sonic Chick', 'Speed Warrior'] }, {}],
    activate: 'Backup Soldier',
    legal: false,
  },
  {
    name: 'raigeki break discards to destroy a card',
    board: [{ set: ['Raigeki Break'], hand: ['Twister'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Raigeki Break',
    picks: [['Twister'], ['Speed Warrior']],
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '1:gy'), expectAt(b, 'Twister', '0:gy')),
  },
];

/** Builds a case's board: every listed card is put in place from its owner's Deck. */
export function buildBoard(c: EvalCase, data: Record<number, CardData>, sheets: Awaited<ReturnType<typeof loadSheets>>): DuelState {
  const byName = new Map(Object.values(data).map((d) => [d.name, d.code]));
  const instances: Record<string, { code: number; owner: Seat }> = {};
  const places: { id: string; seat: Seat; how: keyof Side }[] = [];
  const decks: [string[], string[]] = [[], []];
  const extras: [string[], string[]] = [[], []];
  c.board.forEach((side, s) => {
    const seat = s as Seat;
    let n = 0;
    for (const [how, names] of Object.entries(side) as [keyof Side, string[]][]) {
      for (const name of names) {
        const code = byName.get(name);
        if (code === undefined) throw new Error(`${c.name}: unknown card ${name}`);
        const id = `${'ab'[seat]}${n++}`;
        instances[id] = { code, owner: seat };
        if (how === 'extra') extras[seat].push(id);
        else decks[seat].push(id);
        if (how !== 'deck' && how !== 'extra') places.push({ id, seat, how });
      }
    }
    // Something to draw, so the Deck is never what decides an effect.
    for (let i = 0; i < 5; i++) {
      const id = `${'ab'[seat]}${n++}`;
      instances[id] = { code: byName.get('Sonic Chick')!, owner: seat };
      decks[seat].push(id);
    }
  });
  const events: DuelEvent[] = [
    {
      type: 'duelStarted',
      cards: data,
      sheets,
      instances,
      players: [
        { name: 'Yusei', deck: decks[0], extra: extras[0] },
        { name: 'Yuma', deck: decks[1], extra: extras[1] },
      ],
      first: 0,
    },
    { type: 'turnStarted', player: 0, turn: 2 },
  ];
  const zones: [number, number][] = [[0, 0], [0, 0]];
  for (const { id, seat, how } of places) {
    const to = how === 'gy' ? 'graveyard' : how === 'banished' ? 'banished' : 'hand';
    events.push({ type: 'moved', card: id, owner: seat, from: 'deck', to });
    if (how === 'monsters' || how === 'defense') {
      events.push({ type: 'specialSummoned', player: seat, card: id, zone: zones[seat]![0]++, position: how === 'monsters' ? 'attack' : 'defense' });
    } else if (how === 'setMonsters') {
      events.push({ type: 'monsterSet', player: seat, card: id, zone: zones[seat]![0]++ });
    } else if (how === 'set') {
      events.push({ type: 'spellTrapSet', player: seat, card: id, zone: zones[seat]![1]++ });
    } else if (how === 'faceUp') {
      events.push({ type: 'effectActivated', player: seat, card: id, effect: 0, zone: zones[seat]![1]++ }, { type: 'linkResolved' });
    }
  }
  events.push({ type: 'turnStarted', player: 0, turn: 3 }, { type: 'phaseChanged', phase: 'main1' });
  return replay(events);
}

export interface EvalResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Runs one case: the activation check, then (if legal) the resolution, answering questions from `picks`. */
export async function runCase(c: EvalCase, state: DuelState, model: ModelCall): Promise<EvalResult> {
  const id = [...state.players[0].hand, ...state.players[0].monsters.flatMap((m) => (m ? [m.id] : [])), ...state.players[0].spellTraps.flatMap((m) => (m ? [m.id] : []))].find(
    (x) => cardOf(state, x).name === c.activate,
  )!;
  const zone = state.players[0].hand.includes(id) ? state.players[0].spellTraps.indexOf(null) : null;
  const intent = decide(state, 0, { type: 'activate', card: id, effect: 0, zone });
  if (!intent.ok) return { name: c.name, passed: false, detail: `code refused the activation: ${intent.error}` };
  const picks = [...(c.picks ?? [])];
  const unmatched: string[] = [];
  // A pick names a card, or a phrase found in one of the judge's choices (its wording varies between runs).
  const ask = async (q: Question) => {
    const want = picks.shift() ?? [];
    const named = q.cards.filter((o) => want.includes(cardOf(state, o.id).name)).map((o) => o.id);
    const chosen = [...named, ...q.choices.filter((x) => want.some((w) => x.toLowerCase().includes(w.toLowerCase())))];
    if (chosen.length >= Math.max(q.min, 1)) return chosen.slice(0, q.max);
    if (c.picks && !want.length) unmatched.push(`the judge asked more questions than the case has picks: "${q.text}"`);
    else if (want.length) unmatched.push(`no option matched ${JSON.stringify(want)} in "${q.text}" (choices: ${JSON.stringify(q.choices)})`);
    return [...q.cards.map((o) => o.id), ...q.choices].slice(0, Math.max(q.min, 1));
  };
  const deps = { model, ask, random: Math.random };
  let scratch = intent.events.slice(1).reduce(evolve, state);
  const checked = await judge({ stage: 'activation', state: scratch, link: scratch.chain.at(-1)! }, deps);
  if (checked.record.error) return { name: c.name, passed: false, detail: `judge failed: ${checked.record.error}` };
  if (unmatched.length) return { name: c.name, passed: false, detail: unmatched[0]! };
  if (checked.record.legal !== c.legal) return { name: c.name, passed: false, detail: `ruled ${checked.record.legal ? 'legal' : 'illegal'}: ${checked.record.summary}` };
  if (!c.legal) return { name: c.name, passed: true, detail: checked.record.summary };
  scratch = checked.events.reduce(evolve, scratch);
  const resolved = await judge({ stage: 'resolution', state: scratch, link: scratch.chain.at(-1)! }, deps);
  if (resolved.record.error) return { name: c.name, passed: false, detail: `judge failed resolving: ${resolved.record.error}` };
  const after = [...resolved.events, { type: 'linkResolved' } as DuelEvent].reduce(evolve, scratch);
  if (picks.length) unmatched.push(`the judge never asked for ${JSON.stringify(picks[0])}`);
  const problem = unmatched[0] ?? c.check?.(new Board(after)) ?? null;
  return { name: c.name, passed: problem === null, detail: problem ?? resolved.record.summary };
}

export async function runEvals(db: Db, model: ModelCall, filter = ''): Promise<EvalResult[]> {
  const cases = CASES.filter((c) => c.name.includes(filter));
  const names = [...new Set(cases.flatMap((c) => [...c.board.flatMap((s) => Object.values(s).flat() as string[]), 'Sonic Chick']))];
  const rows = await db.select().from(cards).where(inArray(cards.name, names));
  const data = Object.fromEntries(rows.map((r) => [r.id, toCardData(r)]));
  const sheets = await loadSheets(data);
  return Promise.all(cases.map((c) => runCase(c, buildBoard(c, data, sheets), model)));
}

if (import.meta.main) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set; the evals call the real model.');
    process.exit(1);
  }
  const { connect } = await import('../db/client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  const client = new Anthropic();
  const results = await runEvals(db, (p) => client.messages.create(p), process.argv[2] ?? '');
  for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
  console.log(`\n${results.filter((r) => r.passed).length} of ${results.length} passed`);
  if (results.some((r) => !r.passed)) process.exitCode = 1;
  await db.$client.end();
}
