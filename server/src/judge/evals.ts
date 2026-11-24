// The judge's eval suite: hand-written boards, an activation, and the expected outcome. Runs against the real
// model, so it costs a little (Haiku 5.5) and needs ANTHROPIC_API_KEY and a database with the cards imported.
// Run it after any change to the rules reference, the tools, the model settings or the effect sheets:
//
//   npm run judge:eval                        every case once
//   npm run judge:eval -- vortex              cases whose name contains "vortex"
//   npm run judge:eval -- --repeat 5          every case 5 times, reporting each case's pass rate
//
// Each run writes a summary and the full judge transcripts of every failed attempt to server/eval-runs/<time>/.
// The iteration loop is in docs/effects.md. Each verified ruling (layer 6) becomes another case here.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { inArray } from 'drizzle-orm';
import {
  cardOf,
  decide,
  FIELD_ZONE,
  evolve,
  isProcedure,
  locate,
  nextStep,
  procedureDone,
  triggerEvent,
  replay,
  statsOf,
  zonePick,
  type CardData,
  type DuelEvent,
  type DuelState,
  type Intent,
  type JudgeRecord,
  type ModelUsage,
  type Seat,
} from '@yugioh/engine';
import { toCardData } from '../cards.ts';
import type { Db } from '../db/client.ts';
import { cards } from '../db/schema.ts';
import { loadSheets } from '../sheets.ts';
import { PROMPT_VERSION, type ModelCall, type Question } from './judge.ts';
import { rule } from './script.ts';
import { costOf, usageOf } from './pricing.ts';

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
  /** Face-up Xyz Monsters in Attack Position, each as [its name, ...the names of its Xyz Materials]. */
  xyz?: string[][];
}

export interface EvalCase {
  name: string;
  /** In Main Phase 1 of turn 3, on the activating player's turn, or player 0's when the case has `before`. */
  board: [Side, Side];
  /**
   * What happens first, each by the player named, given card IDs by name: an activation here is ruled on but doesn't
   * resolve, and then the duel goes on by itself as the server runs it (passes for a player with nothing to activate,
   * battle steps, mandatory triggers and the chains they start) until a player must act.
   */
  before?: (id: (name: string) => string) => [Seat, Intent][];
  /** The player who activates (default 0). */
  seat?: Seat;
  /** The card to activate; without one, the case checks the board once `before` is over (a mandatory trigger). */
  activate?: string;
  /** Which of the card's effects to activate, by its index in the sheet (default 0). */
  effect?: number;
  /** Names or choices to pick, one list per question, in order (`before` first). Unlisted questions get the first options. */
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
      for (const c of p.monsters) for (const m of c?.materials ?? []) if (cardOf(this.state, m).name === name) found.push(`${s}:materials`);
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
    name: 'the warrior returning alive works for the second player',
    board: [
      { hand: ['Sonic Chick'], gy: ['Speed Warrior', 'Junk Synchron'], monsters: ['Axe Raider'], set: ['Trap Hole'] },
      { hand: ['The Warrior Returning Alive', 'Sonic Chick'], gy: ['Exiled Force', 'Twister'], setMonsters: ['Mystic Tomato'] },
    ],
    seat: 1,
    activate: 'The Warrior Returning Alive',
    legal: true,
    picks: [['Exiled Force']],
    check: (b) => all(expectAt(b, 'Exiled Force', '1:hand'), expectAt(b, 'Speed Warrior', '0:gy')),
  },
  {
    // A live duel's board (turn 8), where the judge ruled illegal while its own summary said Exiled Force is a target.
    name: 'the warrior returning alive on a full board',
    board: [
      {
        hand: ['Twister'],
        set: ['Miniaturize', 'Backup Soldier', 'Divine Wrath'],
        gy: ['Double Summon', 'Copycat', 'Charcoal Inpachi', 'Water Spirit'],
        deck: ['Sonic Chick', 'Birthright', 'Tune Warrior', 'Scrap-Iron Scarecrow', 'The Warrior Returning Alive', 'Sakuretsu Armor', 'Renge, Gatekeeper of Dark World', 'Marauding Captain', 'Symbols of Duty', 'Woodborg Inpachi', 'Synchro Boost', 'Rush Recklessly', 'Junk Synchron', 'Frequency Magician', 'Seven Tools of the Bandit', 'Magna Drago', 'Mystic Tomato', 'Trap Hole', 'UFO Turtle', 'Axe Raider', 'Speed Warrior', 'Atlantean Pikeman', 'Threatening Roar', 'Dark Blade', 'Spiral Serpent', 'Synchro Blast Wave', 'Exiled Force', 'Lightning Vortex', 'Synchronized Realm', 'Smashing Ground', 'Spellbinding Circle', 'Monster Reincarnation'],
        extra: ['Junk Warrior', 'Gaia Knight, the Force of Earth', 'Colossal Fighter'],
      },
      {
        hand: ['The Warrior Returning Alive', 'Copycat', 'Speed Warrior'],
        monsters: ['Magna Drago'],
        setMonsters: ['Water Spirit'],
        set: ['Sakuretsu Armor', 'Backup Soldier', 'Birthright'],
        gy: ['Exiled Force'],
        deck: ['Symbols of Duty', 'Mystic Tomato', 'Marauding Captain', 'UFO Turtle', 'Woodborg Inpachi', 'Trap Hole', 'Divine Wrath', 'Axe Raider', 'Dark Blade', 'Miniaturize', 'Seven Tools of the Bandit', 'Rush Recklessly', 'Atlantean Pikeman', 'Charcoal Inpachi', 'Sonic Chick', 'Spiral Serpent', 'Synchronized Realm', 'Lightning Vortex', 'Twister', 'Monster Reincarnation', 'Tune Warrior', 'Scrap-Iron Scarecrow', 'Double Summon', 'Synchro Blast Wave', 'Frequency Magician', 'Junk Synchron', 'Spellbinding Circle', 'Renge, Gatekeeper of Dark World', 'Threatening Roar', 'Synchro Boost', 'Smashing Ground'],
        extra: ['Junk Warrior', 'Gaia Knight, the Force of Earth', 'Colossal Fighter'],
      },
    ],
    seat: 1,
    activate: 'The Warrior Returning Alive',
    legal: true,
    picks: [['Exiled Force']],
    check: (b) => expectAt(b, 'Exiled Force', '1:hand'),
  },
  {
    name: 'synchro blast wave needs a synchro monster',
    board: [{ hand: ['Synchro Blast Wave'], monsters: ['Speed Warrior'] }, { monsters: ['Sonic Chick'] }],
    activate: 'Synchro Blast Wave',
    legal: false,
  },
  {
    name: 'synchro blast wave destroys a target once a synchro monster is out',
    board: [{ hand: ['Synchro Blast Wave'], monsters: ['Junk Warrior'] }, { monsters: ['Sonic Chick'] }],
    activate: 'Synchro Blast Wave',
    picks: [['Sonic Chick']],
    legal: true,
    check: (b) => expectAt(b, 'Sonic Chick', '1:gy'),
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
    picks: [['Speed Warrior'], ['Defense']],
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '0:monsters'), b.monster('Speed Warrior')?.position === 'defense' ? null : 'not in Defense Position', expectAt(b, 'Reinforce Truth', '0:gy'), b.state.forbidden.some((f) => f.player === 0 && f.what === 'battle_phase') ? null : 'no Battle Phase ban'),
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
  {
    name: 'raigeki break needs a card to discard',
    board: [{ set: ['Raigeki Break'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Raigeki Break',
    legal: false,
  },
  {
    name: 'poison of the old man gains 1200 when chosen',
    board: [{ hand: ['Poison of the Old Man'] }, {}],
    activate: 'Poison of the Old Man',
    picks: [['1200']],
    legal: true,
    check: (b) => (b.lp(0) === 9200 && b.lp(1) === 8000 ? null : `LP ${b.lp(0)} / ${b.lp(1)}`),
  },
  {
    name: 'twister can destroy your own face-up spell',
    board: [{ hand: ['Twister'], faceUp: ['Banner of Courage'] }, {}],
    activate: 'Twister',
    legal: true,
    check: (b) => all(expectAt(b, 'Banner of Courage', '0:gy'), b.lp(0) === 7500 ? null : `LP ${b.lp(0)}, expected 7500`),
  },
  {
    name: 'rush recklessly can target an opponent monster',
    board: [{ hand: ['Rush Recklessly'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Rush Recklessly',
    legal: true,
    check: (b) => (b.monster('Speed Warrior')?.atk === 1600 ? null : `ATK ${b.monster('Speed Warrior')?.atk}`),
  },
  {
    name: 'lightning vortex needs a face-up opponent monster',
    board: [{ hand: ['Lightning Vortex', 'Twister'] }, { setMonsters: ['Mystic Tomato'] }],
    activate: 'Lightning Vortex',
    legal: false,
  },
  {
    name: 'smashing ground needs a face-up opponent monster',
    board: [{ hand: ['Smashing Ground'] }, { setMonsters: ['Ganbara Knight'] }],
    activate: 'Smashing Ground',
    legal: false,
  },
  {
    name: 'smashing ground lets you choose between tied DEF',
    board: [{ hand: ['Smashing Ground'] }, { defense: ['Renge, Gatekeeper of Dark World', 'Charcoal Inpachi'], monsters: ['Axe Raider'] }],
    activate: 'Smashing Ground',
    picks: [['Charcoal Inpachi']],
    legal: true,
    check: (b) => all(expectAt(b, 'Charcoal Inpachi', '1:gy'), expectAt(b, 'Renge, Gatekeeper of Dark World', '1:monsters')),
  },
  {
    name: 'fissure lets you choose between tied ATK',
    board: [{ hand: ['Fissure'] }, { monsters: ['Charcoal Inpachi', 'Renge, Gatekeeper of Dark World', 'Axe Raider'] }],
    activate: 'Fissure',
    picks: [['Renge, Gatekeeper of Dark World']],
    legal: true,
    check: (b) => all(expectAt(b, 'Renge, Gatekeeper of Dark World', '1:gy'), expectAt(b, 'Charcoal Inpachi', '1:monsters')),
  },
  {
    name: 'exiled force needs another monster to target',
    board: [{ monsters: ['Exiled Force'] }, {}],
    activate: 'Exiled Force',
    legal: false,
  },
  {
    name: 'harmonic waves makes an opponent monster level 4',
    board: [{ hand: ['Harmonic Waves'] }, { monsters: ['Sonic Chick'] }],
    activate: 'Harmonic Waves',
    legal: true,
    check: (b) => (b.monster('Sonic Chick')?.level === 4 ? null : `Level ${b.monster('Sonic Chick')?.level}`),
  },
  {
    // Its text has no "different Level" requirement (Konami prints that limit on cards like Xyz Align, not here).
    name: 'harmonic waves can target a monster that is already level 4',
    board: [{ hand: ['Harmonic Waves'] }, { monsters: ['Gene-Warped Warwolf'] }],
    activate: 'Harmonic Waves',
    legal: true,
    check: (b) => (b.monster('Gene-Warped Warwolf')?.level === 4 ? null : `Level ${b.monster('Gene-Warped Warwolf')?.level}`),
  },
  {
    name: 'reinforced space needs a face-up xyz monster',
    board: [{ set: ['Reinforced Space'], monsters: ['Axe Raider'] }, {}],
    activate: 'Reinforced Space',
    legal: false,
  },
  {
    name: 'harmonic waves needs a face-up monster',
    board: [{ hand: ['Harmonic Waves'], setMonsters: ['Junk Synchron'] }, {}],
    activate: 'Harmonic Waves',
    legal: false,
  },
  {
    name: 'xyz energy needs an xyz material to detach',
    board: [{ hand: ['Xyz Energy'], monsters: ['Axe Raider'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Xyz Energy',
    legal: false,
  },
  {
    name: 'dust tornado destroys an opponent spell or trap',
    board: [{ set: ['Dust Tornado'] }, { set: ['Mirror Force'] }],
    activate: 'Dust Tornado',
    legal: true,
    check: (b) => all(expectAt(b, 'Mirror Force', '1:gy'), expectAt(b, 'Dust Tornado', '0:gy')),
  },
  {
    name: 'dust tornado cannot target your own cards',
    board: [{ set: ['Dust Tornado', 'Trap Hole'] }, {}],
    activate: 'Dust Tornado',
    legal: false,
  },
  {
    name: 'shield spear gives 400 ATK and DEF',
    board: [{ set: ['Shield Spear'], monsters: ['Speed Warrior'] }, {}],
    activate: 'Shield Spear',
    legal: true,
    check: (b) => {
      const m = b.monster('Speed Warrior');
      return m?.atk === 1300 && m.def === 800 ? null : `ATK/DEF ${m?.atk}/${m?.def}`;
    },
  },
  {
    name: 'threatening roar can be activated on your own turn',
    board: [{ set: ['Threatening Roar'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Threatening Roar',
    legal: true,
    check: (b) => all(expectAt(b, 'Threatening Roar', '0:gy'), b.state.forbidden.some((f) => f.player === 1 && f.what === 'declare_attack') ? null : 'no attack ban on player 1'),
  },
  {
    name: 'backup soldier returns up to 3 non-effect monsters',
    board: [{ set: ['Backup Soldier'], gy: ['Renge, Gatekeeper of Dark World', 'Atlantean Pikeman', 'Axe Raider', 'Sonic Chick', 'Speed Warrior'] }, {}],
    activate: 'Backup Soldier',
    picks: [['Renge, Gatekeeper of Dark World', 'Atlantean Pikeman']],
    legal: true,
    check: (b) => all(expectAt(b, 'Renge, Gatekeeper of Dark World', '0:hand'), expectAt(b, 'Atlantean Pikeman', '0:hand'), expectAt(b, 'Axe Raider', '0:gy'), expectAt(b, 'Sonic Chick', '0:gy')),
  },
  {
    name: 'reinforce truth needs a level 2 or lower warrior in the deck',
    board: [{ set: ['Reinforce Truth'], deck: ['Axe Raider', 'Dark Blade'] }, {}],
    activate: 'Reinforce Truth',
    legal: false,
  },
  {
    name: 'mirror force needs an attack',
    board: [{ set: ['Mirror Force'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Mirror Force',
    legal: false,
  },
  {
    name: 'scrap-iron scarecrow needs an attack',
    board: [{ set: ['Scrap-Iron Scarecrow'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Scrap-Iron Scarecrow',
    legal: false,
  },
  {
    name: 'trap hole needs a summon',
    board: [{ set: ['Trap Hole'] }, { monsters: ['Axe Raider'] }],
    activate: 'Trap Hole',
    legal: false,
  },
  {
    name: 'xyz energy detaches a material to destroy a face-up monster',
    board: [{ hand: ['Xyz Energy'], xyz: [['Number 39: Utopia', 'Axe Raider', 'Dark Blade']] }, { monsters: ['Speed Warrior'] }],
    activate: 'Xyz Energy',
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '1:gy'), expectAt(b, 'Axe Raider', '0:gy'), expectAt(b, 'Dark Blade', '0:materials')),
  },
  {
    name: 'reinforced space gives 300 ATK per xyz material',
    board: [{ set: ['Reinforced Space'], xyz: [['Number 39: Utopia', 'Axe Raider', 'Dark Blade']] }, {}],
    activate: 'Reinforced Space',
    legal: true,
    check: (b) => (b.monster('Number 39: Utopia')?.atk === 3100 ? null : `Utopia has ATK ${b.monster('Number 39: Utopia')?.atk}`),
  },
  {
    name: 'banner of courage stays on the field and gives 200 ATK only in your battle phase',
    board: [{ hand: ['Banner of Courage'], monsters: ['Axe Raider'] }, {}],
    activate: 'Banner of Courage',
    legal: true,
    check: (b) => all(expectAt(b, 'Banner of Courage', '0:spellTraps'), b.monster('Axe Raider')?.atk === 1700 ? null : `Axe Raider has ATK ${b.monster('Axe Raider')?.atk} in Main Phase 1`),
  },
  {
    name: 'swords of revealing light stays on the field and flips face-down monsters',
    board: [{ hand: ['Swords of Revealing Light'] }, { setMonsters: ['Mystic Tomato'] }],
    activate: 'Swords of Revealing Light',
    effect: 1,
    legal: true,
    check: (b) => all(expectAt(b, 'Swords of Revealing Light', '0:spellTraps'), b.state.players[1].monsters[0]?.faceUp ? null : 'Mystic Tomato is still face-down'),
  },
  {
    name: 'lucky iron axe equips a monster for 500 ATK',
    board: [{ hand: ['Lucky Iron Axe'], monsters: ['Axe Raider'] }, {}],
    activate: 'Lucky Iron Axe',
    legal: true,
    check: (b) => all(expectAt(b, 'Lucky Iron Axe', '0:spellTraps'), b.monster('Axe Raider')?.atk === 2200 ? null : `Axe Raider has ATK ${b.monster('Axe Raider')?.atk}`),
  },
  {
    name: 'synchro boost gives 500 ATK and a level',
    board: [{ hand: ['Synchro Boost'], monsters: ['Speed Warrior'] }, {}],
    activate: 'Synchro Boost',
    legal: true,
    check: (b) => (b.monster('Speed Warrior')?.atk === 1400 && b.monster('Speed Warrior')?.level === 3 ? null : `Speed Warrior is ${JSON.stringify(b.monster('Speed Warrior'))}`),
  },
  {
    name: 'symbols of duty sends a normal monster to revive and equip a monster',
    board: [{ hand: ['Symbols of Duty'], monsters: ['Axe Raider'], gy: ['Junk Synchron'] }, {}],
    activate: 'Symbols of Duty',
    legal: true,
    check: (b) => all(expectAt(b, 'Axe Raider', '0:gy'), expectAt(b, 'Junk Synchron', '0:monsters'), expectAt(b, 'Symbols of Duty', '0:spellTraps')),
  },
  {
    name: 'spellbinding circle ties itself to an opponent monster',
    board: [{ set: ['Spellbinding Circle'] }, { monsters: ['Dark Blade'] }],
    activate: 'Spellbinding Circle',
    legal: true,
    check: (b) => (b.state.players[0].spellTraps[0]?.linked === b.state.players[1].monsters[0]?.id ? null : 'Spellbinding Circle is not tied to Dark Blade'),
  },
  {
    name: 'birthright summons a normal monster and ties itself to it',
    board: [{ set: ['Birthright'], gy: ['Axe Raider'] }, {}],
    activate: 'Birthright',
    legal: true,
    check: (b) => all(expectAt(b, 'Axe Raider', '0:monsters'), b.state.players[0].spellTraps[0]?.linked === b.state.players[0].monsters[0]?.id ? null : 'Birthright is not tied to Axe Raider'),
  },
  {
    name: 'limit reverse summons a weak monster in attack position',
    board: [{ set: ['Limit Reverse'], gy: ['Speed Warrior'] }, {}],
    activate: 'Limit Reverse',
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '0:monsters'), b.monster('Speed Warrior')?.position === 'attack' ? null : 'not in Attack Position', expectAt(b, 'Limit Reverse', '0:spellTraps')),
  },
  {
    name: 'miniaturize takes a level and 1000 ATK while it stays',
    board: [{ set: ['Miniaturize'] }, { monsters: ['Dark Blade'] }],
    activate: 'Miniaturize',
    legal: true,
    check: (b) => (b.monster('Dark Blade')?.atk === 800 && b.monster('Dark Blade')?.level === 3 ? null : `Dark Blade is ${JSON.stringify(b.monster('Dark Blade'))}`),
  },
  {
    name: 'seven tools negates a trap for 1000 lp',
    board: [{ set: ['Limit Reverse'], gy: ['Speed Warrior'] }, { set: ['Seven Tools of the Bandit'] }],
    before: (id) => [[0, { type: 'activate', card: id('Limit Reverse'), effect: 0, zone: null }]],
    seat: 1,
    activate: 'Seven Tools of the Bandit',
    legal: true,
    check: (b) => all(b.lp(1) === 7000 ? null : `LP is ${b.lp(1)}`, b.state.chain[0]?.negated ? null : 'Limit Reverse was not negated'),
  },
  {
    name: 'seven tools cannot answer a monster effect',
    board: [{ monsters: ['Exiled Force'] }, { set: ['Seven Tools of the Bandit'], monsters: ['Axe Raider'] }],
    before: (id) => [[0, { type: 'activate', card: id('Exiled Force'), effect: 0, zone: null }]],
    seat: 1,
    activate: 'Seven Tools of the Bandit',
    legal: false,
  },
  {
    name: 'divine wrath discards to negate a monster effect',
    board: [{ monsters: ['Exiled Force'] }, { set: ['Divine Wrath'], hand: ['Sonic Chick'], monsters: ['Axe Raider'] }],
    before: (id) => [[0, { type: 'activate', card: id('Exiled Force'), effect: 0, zone: null }]],
    seat: 1,
    activate: 'Divine Wrath',
    picks: [['Axe Raider'], ['Sonic Chick']],
    legal: true,
    check: (b) => all(expectAt(b, 'Sonic Chick', '1:gy'), expectAt(b, 'Exiled Force', '0:gy'), expectAt(b, 'Axe Raider', '1:monsters'), b.state.chain[0]?.negated ? null : 'Exiled Force was not negated'),
  },
  {
    name: 'scrap-iron scarecrow negates an attack and sets itself again',
    board: [{ monsters: ['Axe Raider'] }, { set: ['Scrap-Iron Scarecrow'] }],
    before: (id) => [
      [0, { type: 'enterBattle' }],
      [0, { type: 'attack', attacker: id('Axe Raider'), target: 'direct' }],
    ],
    seat: 1,
    activate: 'Scrap-Iron Scarecrow',
    legal: true,
    check: (b) => all(expectAt(b, 'Scrap-Iron Scarecrow', '1:spellTraps'), b.state.players[1].spellTraps.some((s) => s && !s.faceUp) ? null : 'it is not Set again', b.state.attack ? 'the attack goes on' : null),
  },
  {
    name: 'junk synchron revives a level 2 or lower with its effects negated',
    board: [{ hand: ['Junk Synchron'], gy: ['Speed Warrior', 'Axe Raider'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Junk Synchron'), tributes: [], zone: 0 }]],
    activate: 'Junk Synchron',
    picks: [['Speed Warrior']],
    legal: true,
    check: (b) =>
      all(expectAt(b, 'Speed Warrior', '0:monsters'), b.monster('Speed Warrior')?.position === 'defense' ? null : 'not in Defense Position', b.monster('Speed Warrior')?.effectsNegated ? null : 'its effects are not negated'),
  },
  {
    name: 'speed bird revives two level 2 monsters with their effects negated',
    board: [{ monsters: ['Dark Blade'] }, { monsters: ['Speed Bird'], gy: ['Speed Warrior', 'Tenshin'] }],
    before: (id) => [
      [0, { type: 'enterBattle' }],
      [0, { type: 'attack', attacker: id('Dark Blade'), target: 0 }],
    ],
    seat: 1,
    activate: 'Speed Bird',
    legal: true,
    check: (b) => all(expectAt(b, 'Speed Warrior', '1:monsters'), expectAt(b, 'Tenshin', '1:monsters'), b.monster('Tenshin')?.effectsNegated ? null : 'Tenshin is not negated'),
  },
  {
    name: 'zubaba knight destroys a face-up defense position monster it attacks',
    board: [{ monsters: ['Zubaba Knight'] }, { defense: ['Spirit of the Harp'] }],
    before: (id) => [
      [0, { type: 'enterBattle' }],
      [0, { type: 'attack', attacker: id('Zubaba Knight'), target: 0 }],
    ],
    legal: true,
    check: (b) => all(expectAt(b, 'Spirit of the Harp', '1:gy'), b.lp(1) === 8000 ? null : `LP is ${b.lp(1)}`),
  },
  {
    name: 'majestic mech senku goes to the gy in the end phase of its summon turn',
    board: [{ hand: ['Majestic Mech - Senku'] }, {}],
    before: (id) => [
      [0, { type: 'normalSummon', card: id('Majestic Mech - Senku'), tributes: [], zone: 0 }],
      [0, { type: 'endTurn', discard: [] }],
    ],
    legal: true,
    check: (b) => expectAt(b, 'Majestic Mech - Senku', '0:gy'),
  },
  {
    name: 'frequency magician spends its spell counter for 500 atk',
    board: [{ hand: ['Frequency Magician'], monsters: ['Axe Raider'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Frequency Magician'), tributes: [], zone: 1 }]],
    activate: 'Frequency Magician',
    effect: 1,
    picks: [['Axe Raider']],
    legal: true,
    check: (b) => all(b.monster('Axe Raider')?.atk === 2200 ? null : `Axe Raider has ${b.monster('Axe Raider')?.atk} ATK`, b.monster('Frequency Magician')?.counters.spell === 0 ? null : 'the counter is still there'),
  },
  {
    name: 'frequency magician needs a spell counter',
    board: [{ monsters: ['Frequency Magician', 'Axe Raider'] }, {}],
    activate: 'Frequency Magician',
    effect: 1,
    legal: false,
  },
  {
    name: "lucky iron axe draws when the opponent's effect destroys it",
    board: [{ monsters: ['Axe Raider'], hand: ['Lucky Iron Axe'], deck: ['Dark Blade'] }, { set: ['Raigeki Break'], hand: ['Twister'] }],
    before: (id) => [
      [0, { type: 'activate', card: id('Lucky Iron Axe'), effect: 0, zone: 0 }],
      [1, { type: 'pass' }],
      [0, { type: 'enterBattle' }],
    ],
    seat: 1,
    activate: 'Raigeki Break',
    picks: [['Axe Raider'], ['Twister'], ['Lucky Iron Axe']],
    legal: true,
    check: (b) => all(expectAt(b, 'Lucky Iron Axe', '0:gy'), expectAt(b, 'Dark Blade', '0:hand')),
  },
  {
    name: 'gachi gachi gantetsu can detach a material instead of being destroyed',
    board: [{ set: ['Raigeki Break'], hand: ['Twister'] }, { xyz: [['Gachi Gachi Gantetsu', 'Speed Warrior', 'Tenshin']] }],
    activate: 'Raigeki Break',
    picks: [['Twister'], ['Gachi Gachi Gantetsu'], ['Detach instead'], ['Tenshin']],
    legal: true,
    check: (b) => all(expectAt(b, 'Gachi Gachi Gantetsu', '1:monsters'), expectAt(b, 'Tenshin', '1:gy'), expectAt(b, 'Speed Warrior', '1:materials')),
  },
  {
    name: 'gachi gachi gantetsu can still be destroyed',
    board: [{ set: ['Raigeki Break'], hand: ['Twister'] }, { xyz: [['Gachi Gachi Gantetsu', 'Speed Warrior', 'Tenshin']] }],
    activate: 'Raigeki Break',
    picks: [['Twister'], ['Gachi Gachi Gantetsu'], ['Let it be destroyed']],
    legal: true,
    check: (b) => all(expectAt(b, 'Gachi Gachi Gantetsu', '1:gy'), expectAt(b, 'Tenshin', '1:gy')),
  },
  {
    name: 'xyz effect needs an xyz summon',
    board: [{ set: ['Xyz Effect'] }, { monsters: ['Axe Raider'] }],
    activate: 'Xyz Effect',
    legal: false,
  },


  {
    name: 'harmonic waves cannot target a monster with no level',
    board: [{ hand: ['Harmonic Waves'] }, { monsters: ['Number 39: Utopia'] }],
    activate: 'Harmonic Waves',
    legal: false,
  },
  {
    name: 'raigeki break can destroy a set card',
    board: [{ set: ['Raigeki Break'], hand: ['Twister'] }, { set: ['Trap Hole'] }],
    activate: 'Raigeki Break',
    legal: true,
    check: (b) => all(expectAt(b, 'Trap Hole', '1:gy'), expectAt(b, 'Twister', '0:gy')),
  },
  {
    name: 'speed warrior doubles ATK only in the battle phase',
    board: [{ monsters: ['Speed Warrior'] }, {}],
    activate: 'Speed Warrior',
    legal: false,
  },
  {
    name: 'frequency magician needs a spell counter',
    board: [{ monsters: ['Frequency Magician', 'Axe Raider'] }, {}],
    activate: 'Frequency Magician',
    effect: 1,
    legal: false,
  },
  // Summoning procedures from the hand: no chain, the cost and the Summon at once.
  {
    name: 'turret warrior tributes a warrior and gains its original ATK',
    board: [{ hand: ['Turret Warrior'], monsters: ['Axe Raider', 'Sonic Chick'] }, {}],
    activate: 'Turret Warrior',
    picks: [['Axe Raider'], ['Attack']],
    legal: true,
    check: (b) => all(expectAt(b, 'Axe Raider', '0:gy'), expectAt(b, 'Sonic Chick', '0:monsters'), b.monster('Turret Warrior')?.atk === 1200 + 1700 ? null : `ATK ${b.monster('Turret Warrior')?.atk}`),
  },
  {
    name: 'turret warrior needs a warrior to tribute',
    board: [{ hand: ['Turret Warrior'], monsters: ['Sonic Chick'] }, {}],
    activate: 'Turret Warrior',
    legal: false,
  },
  {
    name: 'quickdraw synchron sends a monster from the hand',
    board: [{ hand: ['Quickdraw Synchron', 'Sonic Chick', 'Twister'] }, {}],
    activate: 'Quickdraw Synchron',
    legal: true,
    check: (b) => all(expectAt(b, 'Quickdraw Synchron', '0:monsters'), expectAt(b, 'Sonic Chick', '0:gy'), expectAt(b, 'Twister', '0:hand')),
  },
  {
    name: 'aqua spirit banishes a water monster from the gy',
    board: [{ hand: ['Aqua Spirit'], gy: ['Silent Angler', 'Axe Raider'] }, {}],
    activate: 'Aqua Spirit',
    legal: true,
    check: (b) => all(expectAt(b, 'Aqua Spirit', '0:monsters'), expectAt(b, 'Silent Angler', '0:banished'), expectAt(b, 'Axe Raider', '0:gy')),
  },
  {
    name: 'silent angler needs a water monster and stops special summons from the hand',
    board: [{ hand: ['Silent Angler', 'Quickdraw Synchron', 'Sonic Chick'], monsters: ['Medium of the Ice Barrier'] }, {}],
    activate: 'Silent Angler',
    legal: true,
    check: (b) =>
      all(
        expectAt(b, 'Silent Angler', '0:monsters'),
        b.state.forbidden.some((f) => f.player === 0 && f.what === 'special_summon' && f.filter?.place === 'hand') ? null : 'no ban on Special Summons from the hand',
      ),
  },
  {
    name: 'silent angler without a water monster',
    board: [{ hand: ['Silent Angler'], monsters: ['Axe Raider'] }, {}],
    activate: 'Silent Angler',
    legal: false,
  },
  {
    name: 'prior of the ice barrier needs an ice barrier monster and bans level 5 or higher',
    board: [{ hand: ['Prior of the Ice Barrier'], monsters: ['Medium of the Ice Barrier'] }, {}],
    activate: 'Prior of the Ice Barrier',
    legal: true,
    check: (b) =>
      all(
        expectAt(b, 'Prior of the Ice Barrier', '0:monsters'),
        b.state.forbidden.some((f) => f.player === 0 && f.what === 'special_summon' && f.filter?.level?.min === 5) ? null : 'no ban on Level 5 or higher',
      ),
  },
  {
    // A live duel (uLlJseNWA9MktARS, turn 11): the judge returned a card from the opponent's GY instead of the target.
    name: 'brionac returns exactly the targeted cards, as many as it discarded',
    board: [{ monsters: ['Brionac, Dragon of the Ice Barrier'], hand: ['Dark Blade', 'Twister'] }, { set: ['Sakuretsu Armor', 'Scrap-Iron Scarecrow'], gy: ['Axe Raider'] }],
    activate: 'Brionac, Dragon of the Ice Barrier',
    picks: [['Dark Blade'], ['Scrap-Iron Scarecrow']],
    legal: true,
    check: (b) =>
      all(
        expectAt(b, 'Scrap-Iron Scarecrow', '1:hand'),
        expectAt(b, 'Sakuretsu Armor', '1:spellTraps'),
        expectAt(b, 'Axe Raider', '1:gy'),
        expectAt(b, 'Dark Blade', '0:gy'),
        expectAt(b, 'Twister', '0:hand'),
      ),
  },
  {
    name: 'brionac with no card to discard',
    board: [{ monsters: ['Brionac, Dragon of the Ice Barrier'] }, { set: ['Sakuretsu Armor'] }],
    activate: 'Brionac, Dragon of the Ice Barrier',
    legal: false,
  },
  {
    // A live duel (uLlJseNWA9MktARS, turn 3): the judge said Speaker for the Ice Barriers isn't an "Ice Barrier" monster.
    name: 'prior of the ice barrier tributes itself to revive an ice barrier monster',
    board: [{ monsters: ['Prior of the Ice Barrier'], gy: ['Speaker for the Ice Barriers'] }, {}],
    activate: 'Prior of the Ice Barrier',
    effect: 1,
    legal: true,
    check: (b) => all(expectAt(b, 'Speaker for the Ice Barriers', '0:monsters'), expectAt(b, 'Prior of the Ice Barrier', '0:gy')),
  },
  {
    name: 'prior of the ice barrier cannot revive another prior',
    board: [{ monsters: ['Prior of the Ice Barrier'], gy: ['Prior of the Ice Barrier'] }, {}],
    activate: 'Prior of the Ice Barrier',
    effect: 1,
    legal: false,
  },
  {
    name: 'medallion of the ice barrier adds an ice barrier monster',
    board: [{ hand: ['Medallion of the Ice Barrier'], deck: ['Axe Raider', 'Speaker for the Ice Barriers'] }, {}],
    activate: 'Medallion of the Ice Barrier',
    legal: true,
    check: (b) => all(expectAt(b, 'Speaker for the Ice Barriers', '0:hand'), expectAt(b, 'Axe Raider', '0:deck')),
  },
  {
    name: 'medium of the ice barrier when the opponent controls 4 more cards',
    board: [{ hand: ['Medium of the Ice Barrier'] }, { monsters: ['Axe Raider', 'Dark Blade'], set: ['Trap Hole', 'Twister'] }],
    activate: 'Medium of the Ice Barrier',
    legal: true,
    check: (b) => expectAt(b, 'Medium of the Ice Barrier', '0:monsters'),
  },
  {
    name: 'medium of the ice barrier when the opponent controls only 3 more cards',
    board: [{ hand: ['Medium of the Ice Barrier'] }, { monsters: ['Axe Raider', 'Dark Blade'], set: ['Trap Hole'] }],
    activate: 'Medium of the Ice Barrier',
    legal: false,
  },
  {
    name: 'moulinglacia needs exactly 5 water monsters in the gy',
    board: [{ hand: ['Moulinglacia the Elemental Lord'], gy: ['Silent Angler', 'Aqua Spirit', 'Prior of the Ice Barrier', 'Medium of the Ice Barrier', 'Dupe Frog', 'Cryomancer of the Ice Barrier'] }, {}],
    activate: 'Moulinglacia the Elemental Lord',
    legal: false,
  },
  {
    name: 'moulinglacia discards 2 random cards from the opponent\'s hand once Summoned',
    board: [
      { hand: ['Moulinglacia the Elemental Lord'], gy: ['Silent Angler', 'Aqua Spirit', 'Prior of the Ice Barrier', 'Medium of the Ice Barrier', 'Dupe Frog'] },
      { hand: ['Axe Raider', 'Dark Blade', 'Twister'] },
    ],
    activate: 'Moulinglacia the Elemental Lord',
    legal: true,
    check: (b) => all(expectAt(b, 'Moulinglacia the Elemental Lord', '0:monsters'), b.state.players[1].hand.length === 1 && b.state.players[1].graveyard.length === 2 ? null : 'not 2 cards discarded'),
  },
  // The Freezing Chains cards the judge used to rule on, now scripted.
  {
    name: 'strategist of the ice barrier sends an ice barrier monster from the hand to draw',
    board: [{ monsters: ['Strategist of the Ice Barrier'], hand: ['Axe Raider', 'Prior of the Ice Barrier'] }, {}],
    activate: 'Strategist of the Ice Barrier',
    legal: true,
    check: (b) => all(expectAt(b, 'Prior of the Ice Barrier', '0:gy'), b.state.players[0].hand.length === 2 ? null : 'no card drawn'),
  },
  {
    name: 'strategist of the ice barrier needs an ice barrier monster in the hand',
    board: [{ monsters: ['Strategist of the Ice Barrier'], hand: ['Axe Raider'] }, {}],
    activate: 'Strategist of the Ice Barrier',
    legal: false,
  },
  {
    name: 'genex undine sends a water monster from the deck to add genex controller',
    board: [{ hand: ['Genex Undine'], deck: ['Prior of the Ice Barrier', 'Genex Controller'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Genex Undine'), tributes: [], zone: 0 }]],
    activate: 'Genex Undine',
    legal: true,
    check: (b) => all(expectAt(b, 'Prior of the Ice Barrier', '0:gy'), expectAt(b, 'Genex Controller', '0:hand')),
  },
  {
    name: 'fishborg launcher revives itself when every monster in the gy is water',
    board: [{ gy: ['Fishborg Launcher', 'Prior of the Ice Barrier'] }, { gy: ['Axe Raider'] }],
    activate: 'Fishborg Launcher',
    legal: true,
    check: (b) => all(expectAt(b, 'Fishborg Launcher', '0:monsters'), b.monster('Fishborg Launcher')?.banishWhenLeaves ? null : 'it is not banished when it leaves'),
  },
  {
    name: 'fishborg launcher stays in the gy with a non-water monster there',
    board: [{ gy: ['Fishborg Launcher', 'Prior of the Ice Barrier', 'Axe Raider'] }, {}],
    activate: 'Fishborg Launcher',
    legal: false,
  },
  {
    name: 'fishborg launcher needs another monster in the gy',
    board: [{ gy: ['Fishborg Launcher'] }, {}],
    activate: 'Fishborg Launcher',
    legal: false,
  },
  {
    name: 'freezing chains of the ice barrier revives an ice barrier monster as it is activated',
    board: [{ hand: ['Freezing Chains of the Ice Barrier'], gy: ['Prior of the Ice Barrier', 'Medium of the Ice Barrier'] }, {}],
    activate: 'Freezing Chains of the Ice Barrier',
    picks: [['Prior of the Ice Barrier'], ['Defense Position']],
    legal: true,
    check: (b) => all(expectAt(b, 'Prior of the Ice Barrier', '0:monsters'), b.monster('Prior of the Ice Barrier')?.position === 'defense' ? null : 'not in Defense Position', expectAt(b, 'Medium of the Ice Barrier', '0:gy'), expectAt(b, 'Freezing Chains of the Ice Barrier', '0:spellTraps')),
  },
  {
    name: 'freezing chains of the ice barrier is activated with no free monster zone',
    board: [{ hand: ['Freezing Chains of the Ice Barrier'], monsters: ['Axe Raider', 'Axe Raider', 'Axe Raider', 'Axe Raider', 'Axe Raider'], gy: ['Prior of the Ice Barrier'] }, {}],
    activate: 'Freezing Chains of the Ice Barrier',
    legal: true,
    check: (b) => all(expectAt(b, 'Prior of the Ice Barrier', '0:gy'), expectAt(b, 'Freezing Chains of the Ice Barrier', '0:spellTraps')),
  },
  {
    name: 'eisbahn changes a summoned non-water monster to defense position',
    board: [{ faceUp: ['Eisbahn'], monsters: ['Prior of the Ice Barrier'], hand: ['Axe Raider'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Axe Raider'), tributes: [], zone: 1 }]],
    legal: true,
    check: (b) => (b.monster('Axe Raider')?.position === 'defense' ? null : 'Axe Raider is still in Attack Position'),
  },
  {
    name: 'eisbahn needs its controller to control a water monster',
    board: [{ faceUp: ['Eisbahn'], hand: ['Axe Raider'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Axe Raider'), tributes: [], zone: 1 }]],
    legal: true,
    check: (b) => (b.monster('Axe Raider')?.position === 'attack' ? null : 'Axe Raider was changed to Defense Position'),
  },
  {
    name: 'hexa spirit of the ice barrier takes the level of the monster it sends from the deck',
    board: [{ monsters: ['Hexa Spirit of the Ice Barrier'], deck: ['Warlock of the Ice Barrier', 'Speaker for the Ice Barriers'] }, {}],
    activate: 'Hexa Spirit of the Ice Barrier',
    effect: 1,
    legal: true,
    check: (b) => all(expectAt(b, 'Warlock of the Ice Barrier', '0:gy'), expectAt(b, 'Speaker for the Ice Barriers', '0:deck'), b.monster('Hexa Spirit of the Ice Barrier')?.level === 3 ? null : `Level is ${b.monster('Hexa Spirit of the Ice Barrier')?.level}`),
  },
  {
    name: 'zuijin of the ice barrier lowers a water monster by 2 levels to revive itself',
    board: [{ monsters: ['Dance Princess of the Ice Barrier'], gy: ['Zuijin of the Ice Barrier'] }, {}],
    activate: 'Zuijin of the Ice Barrier',
    effect: 1,
    legal: true,
    check: (b) =>
      all(
        expectAt(b, 'Zuijin of the Ice Barrier', '0:monsters'),
        b.monster('Dance Princess of the Ice Barrier')?.level === 2 ? null : `Dance Princess is Level ${b.monster('Dance Princess of the Ice Barrier')?.level}`,
        b.monster('Zuijin of the Ice Barrier')?.banishWhenLeaves ? null : 'it is not banished when it leaves',
      ),
  },
  {
    name: 'zuijin of the ice barrier cannot revive itself the turn it was sent to the gy',
    board: [{ monsters: ['Zuijin of the Ice Barrier', 'Dance Princess of the Ice Barrier'], hand: ['General Grunard of the Ice Barrier'] }, {}],
    before: (id) => [[0, { type: 'activate', card: id('Zuijin of the Ice Barrier'), effect: 0, zone: null }]],
    activate: 'Zuijin of the Ice Barrier',
    effect: 1,
    legal: false,
  },
  // Starter deck cards the judge used to rule on, now scripted.
  {
    name: 'ganbara knight changes to defense position when attacked',
    board: [{ monsters: ['Axe Raider'] }, { monsters: ['Ganbara Knight'] }],
    before: (id) => [
      [0, { type: 'enterBattle' }],
      [0, { type: 'attack', attacker: id('Axe Raider'), target: 0 }],
    ],
    seat: 1,
    activate: 'Ganbara Knight',
    legal: true,
    check: (b) => (b.monster('Ganbara Knight')?.position === 'defense' ? null : 'Ganbara Knight is still in Attack Position'),
  },
  {
    name: 'x-saber galahad tributes another saber to negate the attack',
    board: [{ monsters: ['Axe Raider'] }, { monsters: ['X-Saber Galahad', 'X-Saber Galahad'] }],
    before: (id) => [
      [0, { type: 'enterBattle' }],
      [0, { type: 'attack', attacker: id('Axe Raider'), target: 0 }],
    ],
    seat: 1,
    activate: 'X-Saber Galahad',
    effect: 2,
    legal: true,
    check: (b) => all(b.where('X-Saber Galahad').includes('1:gy') ? null : 'no Galahad was Tributed', b.where('X-Saber Galahad').includes('1:monsters') ? null : 'both Galahads left', b.lp(1) === 8000 ? null : `LP is ${b.lp(1)}`),
  },
  {
    name: 'x-saber galahad needs another saber to tribute',
    board: [{ monsters: ['Axe Raider'] }, { monsters: ['X-Saber Galahad', 'Ganbara Knight'] }],
    before: (id) => [
      [0, { type: 'enterBattle' }],
      [0, { type: 'attack', attacker: id('Axe Raider'), target: 0 }],
    ],
    seat: 1,
    activate: 'X-Saber Galahad',
    effect: 2,
    legal: false,
  },
  {
    name: 'synchron explorer revives a synchron with its effects negated',
    board: [{ hand: ['Synchron Explorer'], gy: ['Junk Synchron', 'Axe Raider'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Synchron Explorer'), tributes: [], zone: 0 }]],
    activate: 'Synchron Explorer',
    picks: [['Junk Synchron'], ['Defense Position']],
    legal: true,
    check: (b) => all(expectAt(b, 'Junk Synchron', '0:monsters'), b.monster('Junk Synchron')?.effectsNegated ? null : 'its effects are not negated'),
  },
  {
    name: 'giant trunade returns every spell and trap on the field to the hand',
    board: [{ hand: ['Giant Trunade'], set: ['Trap Hole'] }, { set: ['Sakuretsu Armor', 'Twister'] }],
    activate: 'Giant Trunade',
    legal: true,
    check: (b) => all(expectAt(b, 'Trap Hole', '0:hand'), expectAt(b, 'Sakuretsu Armor', '1:hand'), expectAt(b, 'Twister', '1:hand'), expectAt(b, 'Giant Trunade', '0:gy')),
  },
  {
    name: 'feedback warrior makes a monster level 3',
    board: [{ hand: ['Feedback Warrior'], monsters: ['Axe Raider'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Feedback Warrior'), tributes: [], zone: 1 }]],
    activate: 'Feedback Warrior',
    picks: [['Axe Raider']],
    legal: true,
    check: (b) => (b.monster('Axe Raider')?.level === 3 ? null : `Axe Raider is Level ${b.monster('Axe Raider')?.level}`),
  },
  {
    name: 'field-commander rahz puts a level 4 or lower warrior on top of the deck',
    board: [{ hand: ['Field-Commander Rahz'], deck: ['Field-Commander Rahz', 'Ganbara Knight'] }, {}],
    before: (id) => [[0, { type: 'normalSummon', card: id('Field-Commander Rahz'), tributes: [], zone: 0 }]],
    picks: [['Ganbara Knight']],
    legal: true,
    check: (b) => (cardOf(b.state, b.state.players[0].deck[0]!).name === 'Ganbara Knight' ? null : 'Ganbara Knight is not on top of the Deck'),
  },
  {
    name: 'quillbolt hedgehog revives itself while you control a tuner',
    board: [{ monsters: ['Junk Synchron'], gy: ['Quillbolt Hedgehog'] }, {}],
    activate: 'Quillbolt Hedgehog',
    legal: true,
    check: (b) => all(expectAt(b, 'Quillbolt Hedgehog', '0:monsters'), b.monster('Quillbolt Hedgehog')?.banishWhenLeaves ? null : 'it is not banished when it leaves'),
  },
  {
    name: 'quillbolt hedgehog needs a tuner',
    board: [{ monsters: ['Axe Raider'], gy: ['Quillbolt Hedgehog'] }, {}],
    activate: 'Quillbolt Hedgehog',
    legal: false,
  },
  // Control, Tokens, and effects used from the hand or GY.
  {
    name: 'crackdown takes control of a face-up monster for good',
    board: [{ set: ['Crackdown'] }, { monsters: ['Axe Raider'] }],
    activate: 'Crackdown',
    legal: true,
    check: (b) => all(expectAt(b, 'Axe Raider', '0:monsters'), expectAt(b, 'Crackdown', '0:spellTraps'), b.monster('Axe Raider')?.returnsAtEndPhase === false ? null : 'it would go back'),
  },
  {
    name: 'enemy controller tributes a monster to take control until the end phase',
    board: [{ hand: ['Enemy Controller'], monsters: ['Sonic Chick'] }, { monsters: ['Dark Blade'] }],
    activate: 'Enemy Controller',
    picks: [['take control'], ['Sonic Chick'], ['Dark Blade']],
    legal: true,
    check: (b) => all(expectAt(b, 'Dark Blade', '0:monsters'), expectAt(b, 'Sonic Chick', '0:gy'), b.monster('Dark Blade')?.returnsAtEndPhase ? null : 'it would not go back'),
  },
  {
    name: 'enemy controller changes a battle position without a tribute',
    board: [{ hand: ['Enemy Controller'] }, { monsters: ['Dark Blade'] }],
    activate: 'Enemy Controller',
    legal: true,
    check: (b) => all(expectAt(b, 'Dark Blade', '1:monsters'), b.monster('Dark Blade')?.position === 'defense' ? null : 'still in Attack Position'),
  },
  {
    name: 'speaker for the ice barriers makes an ice barrier token from the gy',
    board: [{ gy: ['Speaker for the Ice Barriers'], monsters: ['Medium of the Ice Barrier'] }, {}],
    activate: 'Speaker for the Ice Barriers',
    effect: 2,
    legal: true,
    check: (b) => all(expectAt(b, 'Ice Barrier Token', '0:monsters'), expectAt(b, 'Speaker for the Ice Barriers', '0:banished')),
  },
  {
    name: 'speaker for the ice barriers special summons itself from the hand',
    board: [{ hand: ['Speaker for the Ice Barriers'], monsters: ['Medium of the Ice Barrier'] }, {}],
    activate: 'Speaker for the Ice Barriers',
    effect: 1,
    legal: true,
    check: (b) => expectAt(b, 'Speaker for the Ice Barriers', '0:monsters'),
  },
  {
    name: 'speaker for the ice barriers needs an ice barrier monster',
    board: [{ hand: ['Speaker for the Ice Barriers'], monsters: ['Axe Raider'] }, {}],
    activate: 'Speaker for the Ice Barriers',
    effect: 1,
    legal: false,
  },
  {
    name: 'mind drain stops monster effects in the hand',
    board: [{ hand: ['Speaker for the Ice Barriers'], monsters: ['Medium of the Ice Barrier'] }, { faceUp: ['Mind Drain'] }],
    activate: 'Speaker for the Ice Barriers',
    effect: 1,
    legal: false,
  },
  {
    name: 'warlock of the ice barrier makes spells be set first',
    board: [{ hand: ['Monster Reincarnation', 'Twister'], gy: ['Sonic Chick'] }, { monsters: ['Warlock of the Ice Barrier', 'Medium of the Ice Barrier'] }],
    activate: 'Monster Reincarnation',
    legal: false,
  },
  {
    name: 'dai-sojo keeps ice barrier monsters from spell destruction',
    board: [{ hand: ['Fissure'] }, { monsters: ['Dai-sojo of the Ice Barrier'] }],
    activate: 'Fissure',
    legal: true,
    check: (b) => all(expectAt(b, 'Dai-sojo of the Ice Barrier', '1:monsters'), expectAt(b, 'Fissure', '0:gy')),
  },
  {
    name: 'fiendish chain ties itself to an effect monster',
    board: [{ set: ['Fiendish Chain'] }, { monsters: ['Speed Warrior'] }],
    activate: 'Fiendish Chain',
    legal: true,
    check: (b) => all(expectAt(b, 'Fiendish Chain', '0:spellTraps'), expectAt(b, 'Speed Warrior', '1:monsters')),
  },
  {
    name: 'ronintoadin revives itself by banishing a frog',
    board: [{ gy: ['Ronintoadin', 'Dupe Frog'] }, {}],
    activate: 'Ronintoadin',
    effect: 2,
    legal: true,
    check: (b) => all(expectAt(b, 'Ronintoadin', '0:monsters'), expectAt(b, 'Dupe Frog', '0:banished')),
  },
  {
    name: 'polymerization fusion summons with a material from the hand and one from the field',
    board: [{ set: ['Polymerization'], hand: ['Flame Manipulator'], monsters: ['Masaki the Legendary Swordsman'], extra: ['Flame Swordsman', 'Gaia the Dragon Champion'] }, {}],
    activate: 'Polymerization',
    picks: [['Flame Swordsman'], ['Masaki the Legendary Swordsman'], ['Flame Manipulator'], ['Defense Position']],
    legal: true,
    check: (b) =>
      all(
        expectAt(b, 'Flame Swordsman', '0:monsters'),
        b.monster('Flame Swordsman')?.position === 'defense' ? null : 'not in Defense Position',
        expectAt(b, 'Flame Manipulator', '0:gy'),
        expectAt(b, 'Masaki the Legendary Swordsman', '0:gy'),
        expectAt(b, 'Gaia the Dragon Champion', '0:extra'),
      ),
  },
  {
    name: 'polymerization needs the materials of a fusion monster in the extra deck',
    board: [{ set: ['Polymerization'], hand: ['Flame Manipulator'], extra: ['Flame Swordsman'] }, {}],
    activate: 'Polymerization',
    legal: false,
  },
  {
    name: 'sogen goes to the field zone and powers up warriors on both sides',
    board: [{ set: ['Sogen'], monsters: ['Masaki the Legendary Swordsman'] }, { monsters: ['Celtic Guardian', 'Blue-Eyes White Dragon'] }],
    activate: 'Sogen',
    legal: true,
    check: (b) =>
      all(
        b.state.players[0].spellTraps[FIELD_ZONE]?.faceUp ? null : 'Sogen is not face-up in the Field Zone',
        b.monster('Masaki the Legendary Swordsman')?.atk === 1300 ? null : `Masaki has ATK ${b.monster('Masaki the Legendary Swordsman')?.atk}`,
        b.monster('Celtic Guardian')?.atk === 1600 ? null : `Celtic Guardian has ATK ${b.monster('Celtic Guardian')?.atk}`,
        b.monster('Blue-Eyes White Dragon')?.atk === 3000 ? null : 'Blue-Eyes changed',
      ),
  },
  {
    name: 'dragon capture jar keeps dragons in defense position',
    board: [{ set: ['Dragon Capture Jar'] }, { monsters: ['Blue-Eyes White Dragon', 'Celtic Guardian'] }],
    activate: 'Dragon Capture Jar',
    legal: true,
    check: (b) =>
      all(
        expectAt(b, 'Dragon Capture Jar', '0:spellTraps'),
        b.monster('Blue-Eyes White Dragon')?.position === 'defense' ? null : 'Blue-Eyes is still in Attack Position',
        b.monster('Celtic Guardian')?.position === 'attack' ? null : 'Celtic Guardian changed position',
      ),
  },
];

/** Builds a case's board: every listed card is put in place from its owner's Deck. */
export function buildBoard(c: EvalCase, data: Record<number, CardData>, sheets: Awaited<ReturnType<typeof loadSheets>>): DuelState {
  const byName = new Map(Object.values(data).map((d) => [d.name, d.code]));
  const instances: Record<string, { code: number; owner: Seat }> = {};
  const places: { id: string; seat: Seat; how: Exclude<keyof Side, 'xyz'> }[] = [];
  const xyzs: { id: string; seat: Seat; materials: string[] }[] = [];
  const decks: [string[], string[]] = [[], []];
  const extras: [string[], string[]] = [[], []];
  c.board.forEach((side, s) => {
    const seat = s as Seat;
    let n = 0;
    const instance = (name: string) => {
      const code = byName.get(name);
      if (code === undefined) throw new Error(`${c.name}: unknown card ${name}`);
      const id = `${'ab'[seat]}${n++}`;
      instances[id] = { code, owner: seat };
      return id;
    };
    for (const [xyz, ...materials] of side.xyz ?? []) {
      const id = instance(xyz!);
      extras[seat].push(id);
      const attached = materials.map(instance);
      decks[seat].push(...attached);
      xyzs.push({ id, seat, materials: attached });
    }
    for (const [how, names] of Object.entries(side).filter(([how]) => how !== 'xyz') as [Exclude<keyof Side, 'xyz'>, string[]][]) {
      for (const name of names) {
        const id = instance(name);
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
    },
    { type: 'turnStarted', player: 0, turn: 2 },
  ];
  const zones: [number, number][] = [[0, 0], [0, 0]];
  /** A Field Spell goes in the Field Zone; any other Spell or Trap in the next Spell & Trap Zone. */
  const spellTrapZone = (id: string, seat: Seat) => (data[instances[id]!.code]!.race === 'Field' ? FIELD_ZONE : zones[seat]![1]++);
  for (const { id, seat, how } of places) {
    const to = how === 'gy' ? 'graveyard' : how === 'banished' ? 'banished' : 'hand';
    events.push({ type: 'moved', card: id, owner: seat, from: 'deck', to });
    if (how === 'monsters' || how === 'defense') {
      events.push({ type: 'specialSummoned', player: seat, card: id, zone: zones[seat]![0]++, position: how === 'monsters' ? 'attack' : 'defense' });
    } else if (how === 'setMonsters') {
      events.push({ type: 'monsterSet', player: seat, card: id, zone: zones[seat]![0]++ });
    } else if (how === 'set') {
      events.push({ type: 'spellTrapSet', player: seat, card: id, zone: spellTrapZone(id, seat) });
    } else if (how === 'faceUp') {
      events.push({ type: 'effectActivated', player: seat, card: id, effect: 0, zone: spellTrapZone(id, seat), cause: null }, { type: 'linkResolved' });
    }
  }
  for (const { id, seat, materials } of xyzs) {
    events.push({ type: 'extraSummoned', player: seat, card: id, how: 'xyz', materials, zone: zones[seat]![0]++, position: 'attack' });
  }
  events.push({ type: 'turnStarted', player: c.before ? 0 : (c.seat ?? 0), turn: 3 }, { type: 'phaseChanged', phase: 'main1' });
  return replay(events);
}

export interface EvalResult {
  name: string;
  passed: boolean;
  detail: string;
  /** The judge calls made: the activation check, then the resolution if it ran. */
  records: JudgeRecord[];
}

/**
 * Runs one case: the activation check, then (if legal) the resolution, answering questions from `picks`. A scripted
 * effect runs without the model, so `model` may be null for cases whose effects all have scripts.
 */
export async function runCase(c: EvalCase, board: DuelState, model: ModelCall | null): Promise<EvalResult> {
  const seat = c.seat ?? 0;
  const picks = [...(c.picks ?? [])];
  const unmatched: string[] = [];
  // A pick names a card, or a phrase found in one of the judge's choices (its wording varies between runs).
  const ask = async (q: Question) => {
    // Where a Special Summoned monster goes is the player's own choice, not part of the ruling: take the first zone.
    if (q.zones.length) return [zonePick(q.zones[0]!)];
    const want = picks.shift() ?? [];
    const named = q.cards.filter((o) => want.includes(cardOf(board, o.id).name)).map((o) => o.id);
    const chosen = [...named, ...q.choices.filter((x) => want.some((w) => x.toLowerCase().includes(w.toLowerCase())))];
    if (chosen.length >= Math.max(q.min, 1)) return chosen.slice(0, q.max);
    if (c.picks && !want.length) unmatched.push(`the judge asked more questions than the case has picks: "${q.text}"`);
    else if (want.length) unmatched.push(`no option matched ${JSON.stringify(want)} in "${q.text}" (choices: ${JSON.stringify(q.choices)})`);
    return [...q.cards.map((o) => o.id), ...q.choices].slice(0, Math.max(q.min, 1));
  };
  const deps = { model, ask, random: Math.random };
  const state = await playBefore(c, board, deps);
  if (!c.activate) {
    const problem = unmatched[0] ?? c.check?.(new Board(state)) ?? null;
    return { name: c.name, passed: problem === null, detail: problem ?? 'the board is as expected', records: [] };
  }
  const p = state.players[seat];
  const id = [...p.hand, ...p.graveyard, ...p.monsters.flatMap((m) => (m ? [m.id] : [])), ...p.spellTraps.flatMap((m) => (m ? [m.id] : []))].find(
    (x) => cardOf(state, x).name === c.activate,
  )!;
  const zone = p.hand.includes(id) && cardOf(state, id).kind !== 'monster' ? p.spellTraps.indexOf(null) : null;
  const intent = decide(state, seat, { type: 'activate', card: id, effect: c.effect ?? 0, zone });
  // Code refuses an activation that the effect's script or `when` rules out, with no judge call.
  if (!intent.ok) return { name: c.name, passed: !c.legal, detail: `code refused the activation: ${intent.error}`, records: [] };
  let scratch = intent.events.slice(1).reduce(evolve, state);
  const procedure = isProcedure(state, id, c.effect ?? 0);
  const link = procedure ? { player: seat, card: id, effect: c.effect ?? 0, targets: [], choice: null, cause: null, negated: false, setAgain: false, taxed: false } : scratch.chain.at(-1)!;
  const checked = await rule({ stage: 'activation', state: scratch, link }, deps);
  const records = [checked.record];
  const result = (passed: boolean, detail: string): EvalResult => ({ name: c.name, passed, detail, records });
  // A Summoning procedure is done in one go, with no chain; what its Summon sets off follows.
  if (procedure && checked.record.legal && !checked.record.error && !unmatched.length) {
    scratch = checked.events.reduce(evolve, scratch);
    const after = await settle(evolve(scratch, procedureDone(scratch, id)), deps);
    const problem = c.legal ? (c.check?.(new Board(after)) ?? null) : 'ruled legal';
    return result(problem === null, problem ?? checked.record.summary);
  }
  if (checked.record.error) return result(false, `judge failed: ${checked.record.error}`);
  if (unmatched.length) return result(false, unmatched[0]!);
  if (checked.record.legal !== c.legal) return result(false, `ruled ${checked.record.legal ? 'legal' : 'illegal'}: ${checked.record.summary}`);
  if (!c.legal) return result(true, checked.record.summary);
  scratch = checked.events.reduce(evolve, scratch);
  // Nobody responds: the chain resolves.
  while (scratch.step.at === 'respond') scratch = evolve(scratch, { type: 'passed', player: scratch.step.priority });
  const resolved = await rule({ stage: 'resolution', state: scratch, link: scratch.chain.at(-1)! }, deps);
  records.push(resolved.record);
  if (resolved.record.error) return result(false, `judge failed resolving: ${resolved.record.error}`);
  const resolvedState = [...resolved.events, { type: 'linkResolved' } as DuelEvent].reduce(evolve, scratch);
  // With the chain over, what it set off follows (Lucky Iron Axe's draw); a chain still building is checked as it is.
  const after = resolvedState.chain.length ? resolvedState : await settle(resolvedState, deps);
  if (picks.length) unmatched.push(`the judge never asked for ${JSON.stringify(picks[0])}`);
  const problem = unmatched[0] ?? c.check?.(new Board(after)) ?? null;
  return result(problem === null, problem ?? resolved.record.summary);
}

/** Plays the case's `before` intents, each followed by what code does on its own. */
async function playBefore(c: EvalCase, board: DuelState, deps: Parameters<typeof rule>[1]): Promise<DuelState> {
  const id = (name: string) => {
    const found = Object.keys(board.instances).find((x) => cardOf(board, x).name === name && locate(board, x)?.zone !== 'deck');
    if (!found) throw new Error(`${c.name}: no ${name} on the board`);
    return found;
  };
  let state = board;
  for (const [seat, intent] of c.before?.(id) ?? []) {
    const d = decide(state, seat, intent);
    if (!d.ok) throw new Error(`${c.name}: ${d.error}`);
    state = d.events.reduce(evolve, state);
    if (intent.type === 'activate') state = (await rule({ stage: 'activation', state, link: state.chain.at(-1)! }, deps)).events.reduce(evolve, state);
    state = await settle(state, deps);
  }
  return state;
}

/** Goes on with the duel as the server would, until a player must act. */
async function settle(from: DuelState, deps: Parameters<typeof rule>[1]): Promise<DuelState> {
  let state = from;
  for (;;) {
    const next = nextStep(state);
    if (next?.kind === 'events') state = next.events.reduce(evolve, state);
    else if (next?.kind === 'wait' && next.autoPass) state = evolve(state, { type: 'passed', player: next.player });
    else if (next?.kind === 'trigger') {
      state = triggerEvent(next.trigger).reduce(evolve, state);
      state = (await rule({ stage: 'activation', state, link: state.chain.at(-1)! }, deps)).events.reduce(evolve, state);
    } else if (next?.kind === 'resolve') {
      const resolved = await rule({ stage: 'resolution', state, link: state.chain.at(-1)! }, deps);
      state = [...resolved.events, { type: 'linkResolved' } as DuelEvent].reduce(evolve, state);
    } else return state;
  }
}

/** Runs the matching cases `repeat` times; each round runs its cases in parallel. Returns one list per round. */
export async function runEvals(db: Db, model: ModelCall, filter = '', repeat = 1): Promise<EvalResult[][]> {
  const cases = CASES.filter((c) => c.name.includes(filter));
  const names = [...new Set(cases.flatMap((c) => [...c.board.flatMap((s) => Object.values(s).flat(2) as string[]), 'Sonic Chick']))];
  const rows = await db.select().from(cards).where(inArray(cards.name, names));
  const data = Object.fromEntries(rows.map((r) => [r.id, toCardData(r)]));
  const sheets = await loadSheets(db, data);
  const rounds: EvalResult[][] = [];
  for (let i = 0; i < repeat; i++) rounds.push(await Promise.all(cases.map((c) => runCase(c, buildBoard(c, data, sheets), model))));
  return rounds;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { repeat: { type: 'string', default: '1' } } });
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat takes a whole number of at least 1.');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set; the evals call the real model.');
    process.exit(1);
  }
  const filter = positionals[0] ?? '';
  const { connect } = await import('../db/client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  const client = new Anthropic();
  const calls: ModelUsage[] = [];
  const model: ModelCall = async (p) => {
    const m = await client.messages.create(p);
    calls.push(usageOf(p.model, m));
    return m;
  };
  const rounds = await runEvals(db, model, filter, repeat);
  await db.$client.end();

  const dir = join('eval-runs', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: true });
  const byCase = new Map<string, EvalResult[]>();
  for (const round of rounds) for (const r of round) byCase.set(r.name, [...(byCase.get(r.name) ?? []), r]);
  const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, '-');
  for (const [name, runs] of byCase) {
    const passes = runs.filter((r) => r.passed).length;
    console.log(`${passes === runs.length ? 'PASS' : 'FAIL'}  ${repeat > 1 ? `${passes}/${runs.length}  ` : ''}${name}`);
    for (const [i, r] of runs.entries()) {
      if (r.passed && repeat > 1) continue;
      console.log(`      ${repeat > 1 ? `#${i + 1} ` : ''}${r.detail}`);
      if (!r.passed) await writeFile(join(dir, `${slug(name)}-${i + 1}.json`), `${JSON.stringify(r, null, 2)}\n`);
    }
  }
  const all = rounds.flat();
  const passed = all.filter((r) => r.passed).length;
  const cost = costOf(calls);
  const sum = (k: 'input' | 'cacheWrite' | 'cacheRead' | 'output') => calls.reduce((n, c) => n + c[k], 0);
  const usage = { input: sum('input'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'), output: sum('output') };
  const rates = Object.fromEntries([...byCase].map(([name, runs]) => [name, runs.filter((r) => r.passed).length / runs.length]));
  const summary = { promptVersion: PROMPT_VERSION, filter, repeat, passed, total: all.length, usage, cost: Number(cost.toFixed(4)), cases: rates };
  await writeFile(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed} of ${all.length} passed (prompt ${PROMPT_VERSION}, about $${cost.toFixed(3)}). Results and failed transcripts: server/${dir}/`);
  if (passed < all.length) process.exitCode = 1;
}
