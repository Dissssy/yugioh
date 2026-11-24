import { describe, expect, it } from 'vitest';
import {
  decide,
  legalActions,
  replay,
  startDuel,
  logFor,
  nextStep,
  viewFor,
  type CardData,
  type DuelEvent,
  type EffectSheet,
  type SheetEffect,
  type Op,
  applyOp,
  type DuelState,
  type Intent,
  type JudgeRecord,
  type Seat,
  type SummonKind,
  type Script,
  type CardFilter,
  type Continuous,
  statsOf,
  scriptProblem,
  evolve,
  pendingTriggers,
  cardsFitting,
  monsterZoneFree,
  monsterZonesFor,
  procedureDone,
  feasibleOptions,
  fusionMaterialOptions,
} from '../src/index.ts';

const monster = (code: number, name: string, level: number, atk: number, def: number): CardData => ({
  code,
  name,
  type: 'Normal Monster',
  kind: 'monster',
  extraDeck: false,
  text: '',
  level,
  atk,
  def,
  attribute: 'EARTH',
  race: 'Warrior',
});

const cards: Record<number, CardData> = {
  1: monster(1, 'Axe Raider', 4, 1700, 1150),
  2: monster(2, 'Dark Blade', 4, 1800, 1500),
  3: monster(3, 'Luster Dragon #2', 6, 2400, 1400),
  4: monster(4, 'Spiral Serpent', 8, 2900, 2900),
  5: monster(5, 'Spirit of the Harp', 4, 800, 2000),
  6: { ...monster(6, 'Trap Hole', 0, 0, 0), type: 'Trap Card', kind: 'trap', level: null, atk: null, def: null, attribute: null },
  7: { ...monster(7, 'Junk Warrior', 5, 2300, 1300), type: 'Synchro Monster', extraDeck: true },
  8: { ...spell(8, 'Rush Recklessly'), race: 'Quick-Play' },
  9: spell(9, 'Monster Reincarnation'),
  10: { ...monster(10, 'Exiled Force', 4, 1000, 1000), type: 'Effect Monster' },
  11: { ...spell(11, 'Reinforce Truth'), type: 'Trap Card', kind: 'trap' },
  12: { ...spell(12, 'Banner of Courage'), race: 'Continuous' },
  13: { ...monster(13, 'Junk Synchron', 3, 1300, 500), type: 'Tuner Monster' },
  14: { ...monster(14, 'Speed Warrior', 2, 900, 400), type: 'Effect Monster' },
  15: { ...monster(15, 'Gaia Knight, the Force of Earth', 6, 2600, 800), type: 'Synchro Monster', extraDeck: true },
  16: { ...monster(16, 'Tune Warrior', 3, 1600, 200), type: 'Normal Tuner Monster' },
  17: { ...monster(17, 'Number 39: Utopia', 4, 2500, 2000), type: 'XYZ Monster', extraDeck: true },
  18: { ...monster(18, 'Grenosaurus', 3, 2000, 1900), type: 'XYZ Monster', extraDeck: true },
  19: { ...monster(19, 'Tenshin', 2, 800, 100), type: 'Effect Monster' },
  20: { ...monster(20, 'Shine Knight', 3, 400, 1900), type: 'Effect Monster' },
  21: { ...monster(21, 'Gachi Gachi Gantetsu', 2, 500, 1800), type: 'XYZ Monster', extraDeck: true },
  22: { ...monster(22, 'Sonic Chick', 1, 300, 300), type: 'Effect Monster', race: 'Winged Beast' },
  23: { ...monster(23, 'Marauding Captain', 3, 1200, 400), type: 'Effect Monster' },
  24: spell(24, 'Swords of Revealing Light'),
  25: { ...spell(25, 'Synchro Boost'), race: 'Equip' },
  26: { ...spell(26, 'Limit Reverse'), type: 'Trap Card', kind: 'trap', race: 'Continuous' },
  27: { ...spell(27, 'Seven Tools of the Bandit'), type: 'Trap Card', kind: 'trap', race: 'Counter' },
  28: { ...monster(28, 'Zubaba Knight', 3, 1600, 900), type: 'Effect Monster' },
  29: { ...monster(29, 'Majestic Mech - Senku', 4, 2400, 1500), type: 'Effect Monster' },
  30: { ...monster(30, 'Frequency Magician', 4, 1500, 800), type: 'Effect Monster' },
  31: { ...monster(31, 'Silent Angler', 4, 800, 1400), type: 'Effect Monster', attribute: 'WATER', race: 'Fish' },
  32: { ...monster(32, 'Moulinglacia the Elemental Lord', 8, 2800, 2000), type: 'Effect Monster', attribute: 'WATER', race: 'Sea Serpent' },
  33: { ...monster(33, 'Medium of the Ice Barrier', 7, 2400, 1800), type: 'Effect Monster', attribute: 'WATER', race: 'Spellcaster' },
  34: { ...monster(34, 'Fishborg Launcher', 1, 200, 100), type: 'Tuner Monster', attribute: 'WATER', race: 'Fish' },
  35: { ...monster(35, 'Hayabusa Knight', 3, 1000, 700), type: 'Effect Monster' },
  36: { ...monster(36, 'Twin-Sword Marauder', 4, 1600, 1200), type: 'Effect Monster' },
  37: { ...monster(37, 'Fortress Warrior', 2, 600, 1200), type: 'Effect Monster' },
  38: { ...monster(38, 'X-Saber Galahad', 4, 1800, 800), type: 'Effect Monster' },
  39: { ...monster(39, 'Cryomancer of the Ice Barrier', 4, 1300, 0), type: 'Effect Monster', attribute: 'WATER' },
  40: { ...monster(40, 'Defender of the Ice Barrier', 4, 200, 1600), type: 'Effect Monster', attribute: 'WATER' },
  41: { ...monster(41, 'Warlock of the Ice Barrier', 2, 400, 600), type: 'Effect Monster', attribute: 'WATER' },
  42: { ...monster(42, 'Revealer of the Ice Barrier', 2, 1100, 1500), type: 'Effect Monster', attribute: 'WATER' },
  43: { ...monster(43, 'Medium of the Ice Barrier', 4, 1500, 800), type: 'Effect Monster', attribute: 'WATER' },
  44: { ...monster(44, 'Dai-sojo of the Ice Barrier', 4, 1600, 1100), type: 'Effect Monster', attribute: 'WATER' },
  45: { ...spell(45, 'Fiendish Chain'), type: 'Trap Card', kind: 'trap', race: 'Continuous' },
  46: { ...monster(46, 'Freezing Chains', 4, 1000, 1000), type: 'Effect Monster', attribute: 'WATER' },
  47: { ...monster(47, 'Dupe Frog', 2, 100, 2000), type: 'Effect Monster', attribute: 'WATER', race: 'Aqua' },
  48: { ...monster(48, 'Quickdraw Synchron', 1, 700, 1400), type: 'Tuner Effect Monster' },
  49: { ...monster(49, 'Ronintoadin', 4, 1600, 1200), type: 'Effect Monster', attribute: 'WATER', race: 'Aqua' },
  50: { ...monster(50, 'Dark Tinker', 1, 300, 300), type: 'Effect Monster' },
  51: { ...spell(51, 'Mystical Space Typhoon'), race: 'Quick-Play' },
  52: { ...spell(52, 'Lantern'), race: 'Continuous' },
  53: { ...monster(53, 'Turret Warrior', 5, 1200, 2000), type: 'Effect Monster' },
  54: { ...monster(54, 'Prior of the Ice Barrier', 4, 1000, 400), type: 'Effect Monster', attribute: 'WATER' },
  55: { ...monster(55, 'Ice Lord', 8, 2800, 2000), type: 'Effect Monster', attribute: 'WATER' },
  56: { ...spell(56, 'Sogen'), race: 'Field' },
  57: { ...spell(57, 'Yami'), race: 'Field' },
  58: spell(58, 'Polymerization'),
  59: { ...monster(59, 'Flame Swordsman', 5, 1800, 1600), type: 'Fusion Monster', extraDeck: true },
  60: { ...monster(60, 'Exodia the Forbidden One', 3, 1000, 1000), type: 'Effect Monster' },
  61: monster(61, 'Right Leg of the Forbidden One', 1, 200, 300),
  62: monster(62, 'Left Leg of the Forbidden One', 1, 200, 300),
  63: monster(63, 'Right Arm of the Forbidden One', 1, 200, 300),
  64: monster(64, 'Left Arm of the Forbidden One', 1, 200, 300),
  65: { ...spell(65, 'Dragon Capture Jar'), type: 'Trap Card', kind: 'trap', race: 'Continuous' },
  66: { ...monster(66, 'Blue-Eyes White Dragon', 8, 3000, 2500), race: 'Dragon' },
};

function spell(code: number, name: string): CardData {
  return { ...monster(code, name, 0, 0, 0), type: 'Spell Card', kind: 'spell', level: null, atk: null, def: null, attribute: null, race: 'Normal' };
}

const effect = (kind: SheetEffect['kind'], opt: SheetEffect['opt'] = 'none'): SheetEffect => ({
  kind,
  speed: kind === 'quick' ? 2 : 1,
  mandatory: false,
  from: 'field',
  opt,
  window: '',
  cost: '',
  effect: `${kind} effect`,
  targets: null,
  when: null,
  script: null,
  continuous: null,
  status: 'unverified',
});
/** Face-up monsters on the field that fit, for continuous effects. */
const filter = (f: Partial<CardFilter>): CardFilter => ({ side: 'either', places: ['monsters'], kinds: [], types: [], races: [], attributes: [], named: null, except: null, extraDeck: null, faceUp: true, position: null, level: null, atk: null, def: null, ...f });
const aura = (c: Partial<Extract<Continuous, { apply: 'stats' }>>): Continuous => ({ apply: 'stats', to: 'self', atk: 0, def: 0, per: null, levelDelta: 0, levelSet: null, while: [], ...c });
const restrict = (c: Partial<Extract<Continuous, { apply: 'restrict' }>>): Continuous => ({ apply: 'restrict', to: 'self', others: false, cannot: [], by: null, compare: null, once: false, while: [], ...c });
const battleChange = (c: Partial<Extract<Continuous, { apply: 'battle' }>>): Continuous => ({ apply: 'battle', to: 'self', attacks: 1, piercing: false, noDamageToYou: false, while: [], ...c });
const lock = (c: Partial<Extract<Continuous, { apply: 'lock' }>>): Continuous => ({ apply: 'lock', player: 'both', cannot: 'activate', filter: null, perTurn: null, setFirst: false, while: [], ...c });
const continuous = (c: Continuous): SheetEffect => ({ ...effect('continuous'), continuous: c });
const sheet = (code: number, ...effects: SheetEffect[]): EffectSheet => ({ code, textHash: '', model: 'test', effects, materials: null, normalSummon: true });
const detachSelf = { do: 'detach', cards: { from: 'self' }, count: 1 } as const;
const scripted = (script: Partial<Script>): Pick<SheetEffect, 'script'> => ({ script: { conditions: [], cost: [], targets: null, options: [], unapplied: null, ...script } });
/** Silent Angler's "you cannot Special Summon monsters from your hand". */
const fromHand = filter({ side: 'you', places: ['hand'], kinds: ['monster'], faceUp: null });
const sheets: Record<number, EffectSheet> = {
  8: sheet(8, effect('activation')),
  9: sheet(9, effect('activation')),
  10: sheet(10, effect('ignition', 'soft')),
  11: sheet(11, effect('activation')),
  12: sheet(12, effect('activation'), { ...effect('continuous'), continuous: aura({ to: filter({ side: 'you' }), atk: 200, while: [{ if: 'turn', whose: 'you' }, { if: 'phase', phases: ['battle'] }] }) }),
  19: sheet(19, { ...effect('continuous'), continuous: aura({ to: 'self', atk: 400, per: filter({ side: 'you', level: { min: 2, max: 2 } }) }) }),
  20: sheet(20, { ...effect('continuous'), continuous: aura({ to: 'self', levelSet: 4, while: [{ if: 'position', position: 'defense' }] }) }),
  22: sheet(22, { ...effect('continuous'), continuous: restrict({ cannot: ['be_destroyed_by_battle'], by: filter({ atk: { min: 1900, max: null } }) }) }),
  23: sheet(23, { ...effect('continuous'), continuous: restrict({ to: filter({ side: 'you', races: ['Warrior'] }), others: true, cannot: ['be_attacked'] }) }),
  24: sheet(
    24,
    { ...effect('continuous'), continuous: { apply: 'self_destruct', opponentTurns: 3 } },
    { ...effect('activation'), ...scripted({ options: [{ label: '', cost: [], steps: [] }] }) },
    { ...effect('continuous'), continuous: restrict({ to: filter({ side: 'opponent', faceUp: null }), cannot: ['attack'] }) },
  ),
  25: sheet(25, effect('activation'), { ...effect('continuous'), continuous: { apply: 'stats', to: 'linked', atk: 500, def: 0, per: null, levelDelta: 1, levelSet: null, while: [] } }),
  26: sheet(
    26,
    effect('activation'),
    { ...effect('continuous'), continuous: { apply: 'tie', destroyLinked: true, defenseBreaks: true } },
    { ...effect('continuous'), continuous: restrict({ to: 'linked', cannot: ['attack'] }) },
  ),
  27: sheet(27, {
    ...effect('activation'),
    speed: 3,
    when: { event: 'activated', self: false, filter: filter({ places: [], kinds: ['trap'], faceUp: null }), how: [], canMiss: false, by: null },
  }),
  28: sheet(28, {
    ...effect('trigger'),
    mandatory: true,
    when: { event: 'damage_step_start', self: true, filter: null, how: [], canMiss: false, by: null },
    ...scripted({ options: [{ label: '', cost: [], steps: [{ do: 'destroy', cards: { from: 'battling', filter: filter({ side: 'opponent', position: 'defense' }) } }] }] }),
  }),
  29: sheet(29, {
    ...effect('trigger'),
    mandatory: true,
    when: { event: 'end_phase', self: false, filter: null, how: [], canMiss: false, by: null },
    ...scripted({ conditions: [{ if: 'summoned_this_turn', how: [] }], options: [{ label: '', cost: [], steps: [{ do: 'move', cards: { from: 'self' }, to: 'graveyard' }] }] }),
  }),
  // Not Frequency Magician's real effect: a draw when the opponent's effect destroys it, to test that event.
  30: sheet(30, {
    ...effect('trigger'),
    mandatory: true,
    from: 'graveyard',
    when: { event: 'destroyed_by_effect', self: true, filter: filter({ side: 'you', faceUp: true }), how: [], canMiss: false, by: 'opponent' },
    ...scripted({ options: [{ label: '', cost: [], steps: [{ do: 'draw', player: 'you', count: 1, per: null }] }] }),
  }),
  31: sheet(31, {
    ...effect('condition'),
    ...scripted({
      conditions: [{ if: 'count', filter: filter({ side: 'you', attributes: ['WATER'] }), min: 1, max: null, distinct: false }],
      options: [
        { label: '', cost: [], steps: [{ do: 'special_summon', cards: { from: 'self' }, position: 'choice', banishWhenLeaves: false }, { do: 'forbid', player: 'you', what: 'special_summon', filter: fromHand, wholeTurn: false }] },
      ],
    }),
  }),
  32: { ...sheet(32, effect('condition')), normalSummon: false },
  53: sheet(53, {
    ...effect('condition'),
    ...scripted({
      cost: [{ do: 'move', cards: { from: 'choose', filter: filter({ side: 'you', kinds: ['monster'], races: ['Warrior'] }), min: 1, max: 1, rank: null, distinct: false, includeSelf: false }, to: 'graveyard' }],
      options: [{ label: '', cost: [], steps: [{ do: 'special_summon', cards: { from: 'self' }, position: 'choice', banishWhenLeaves: false }] }],
    }),
  }),
  54: sheet(54, {
    ...effect('condition'),
    ...scripted({
      options: [
        {
          label: '',
          cost: [],
          steps: [
            { do: 'special_summon', cards: { from: 'self' }, position: 'choice', banishWhenLeaves: false },
            { do: 'forbid', player: 'you', what: 'special_summon', filter: filter({ places: [], side: 'you', faceUp: null, level: { min: 5, max: null } }), wholeTurn: true },
          ],
        },
      ],
    }),
  }),
  55: { ...sheet(55, { ...effect('condition'), ...scripted({ options: [{ label: '', cost: [], steps: [{ do: 'special_summon', cards: { from: 'self' }, position: 'choice', banishWhenLeaves: false }] }] }) }), normalSummon: false },
  33: sheet(33, { ...effect('condition'), ...scripted({ conditions: [{ if: 'outnumbered', by: 4 }], options: [{ label: '', cost: [], steps: [{ do: 'special_summon', cards: { from: 'self' }, position: 'choice', banishWhenLeaves: false }] }] }) }),
  35: sheet(35, continuous(battleChange({ attacks: 2 }))),
  36: sheet(36, continuous(battleChange({ attacks: 2, while: [{ if: 'last_attack', on: 'defense' }] })), continuous(battleChange({ piercing: true }))),
  37: sheet(37, continuous(battleChange({ noDamageToYou: true })), continuous(restrict({ cannot: ['be_destroyed_by_battle'], once: true }))),
  38: sheet(
    38,
    continuous(aura({ atk: 300, while: [{ if: 'battling', as: 'attacker', damageStep: true }] })),
    continuous(aura({ atk: -500, while: [{ if: 'battling', as: 'target', damageStep: true }] })),
  ),
  39: sheet(39, continuous(restrict({ to: filter({ level: { min: 4, max: null } }), cannot: ['attack'] }))),
  40: sheet(40, continuous(restrict({ to: filter({ side: 'opponent' }), cannot: ['attack'], compare: { stat: 'atk', self: 'def' } }))),
  41: sheet(41, continuous(lock({ filter: filter({ places: [], faceUp: null, kinds: ['spell'] }), setFirst: true }))),
  42: sheet(42, continuous(lock({ player: 'opponent', cannot: 'tribute_summon' }))),
  43: sheet(43, continuous(lock({ player: 'opponent', filter: filter({ places: [], faceUp: null, kinds: ['spell', 'trap'] }), perTurn: 1 }))),
  44: sheet(44, continuous(restrict({ to: filter({ side: 'you', named: 'Ice Barrier' }), cannot: ['be_destroyed_by_effect'], by: filter({ places: [], faceUp: null, kinds: ['spell', 'trap'] }) }))),
  45: sheet(45, effect('activation'), continuous({ apply: 'negate_linked' })),
  46: sheet(46, continuous(restrict({ to: filter({ side: 'you' }), cannot: ['be_affected'], by: filter({ side: 'opponent', places: [], faceUp: null, kinds: ['monster'], extraDeck: true }) }))),
  47: sheet(47, continuous({ apply: 'name', name: 'Des Frog' })),
  48: sheet(48, continuous({ apply: 'synchro_material', substitutes: 'Synchron', never: false, onlyFor: null, onlyForTuner: 'Synchron' })),
  51: sheet(51, { ...effect('activation'), speed: 2 }),
  52: sheet(52, effect('activation'), effect('ignition')),
  49: sheet(49, continuous({ apply: 'synchro_material', substitutes: null, never: true, onlyFor: null, onlyForTuner: null })),
  50: sheet(50, {
    ...effect('trigger'),
    from: 'graveyard',
    when: { event: 'sent_to_graveyard', self: true, filter: null, how: [], canMiss: false, by: null },
    ...scripted({ options: [{ label: '', cost: [], steps: [{ do: 'arrange_top', count: 1, bottom: true }] }] }),
  }),
  34: sheet(34, { ...effect('ignition', 'hard'), from: 'graveyard', ...scripted({ options: [{ label: '', cost: [], steps: [{ do: 'special_summon', cards: { from: 'self' }, position: 'choice', banishWhenLeaves: false }] }] }) }),
  21: {
    ...sheet(
      21,
      { ...effect('continuous'), continuous: { apply: 'replace_destruction', detach: 1 } },
      { ...effect('continuous'), continuous: aura({ to: filter({ side: 'you' }), atk: 200, def: 200, per: 'materials' }) },
    ),
    materials: { summon: 'xyz', level: 2, count: 2 },
  },
  7: { ...sheet(7), materials: { summon: 'synchro', tuner: 'Junk Synchron', nonTuners: { min: 1, max: null } } },
  15: { ...sheet(15), materials: { summon: 'synchro', tuner: null, nonTuners: { min: 1, max: null } } },
  17: {
    ...sheet(
      17,
      { ...effect('quick'), ...scripted({ cost: [detachSelf], options: [{ label: '', cost: [], steps: [{ do: 'negate_attack' }] }] }) },
      {
        ...effect('trigger'),
        mandatory: true,
        when: { event: 'attacked', self: true, filter: null, how: [], canMiss: false, by: null },
        ...scripted({ conditions: [{ if: 'materials', min: null, max: 0 }], options: [{ label: '', cost: [], steps: [{ do: 'destroy', cards: { from: 'self' } }] }] }),
      },
    ),
    materials: { summon: 'xyz', level: 4, count: 2 },
  },
  18: {
    ...sheet(18, {
      ...effect('trigger'),
      when: { event: 'battle_destroying', self: true, filter: null, how: [], canMiss: true, by: null },
      ...scripted({ cost: [detachSelf], options: [{ label: '', cost: [], steps: [{ do: 'change_lp', player: 'opponent', amount: 1000, per: null, kind: 'damage' }] }] }),
    }),
    materials: { summon: 'xyz', level: 3, count: 2 },
  },
  56: sheet(56, effect('activation'), continuous(aura({ to: filter({ races: ['Warrior'] }), atk: 200, def: 200 }))),
  57: sheet(57, effect('activation')),
  58: sheet(58, { ...effect('activation'), ...scripted({ options: [{ label: '', cost: [], steps: [{ do: 'fusion_summon', from: ['hand', 'field'] }] }] }) }),
  59: { ...sheet(59), materials: { summon: 'fusion', materials: ['Axe Raider', 'Dark Blade'] } },
  65: sheet(65, effect('activation'), continuous({ apply: 'force_position', to: filter({ races: ['Dragon'] }), position: 'defense', while: [] })),
  60: sheet(60, continuous({ apply: 'win_with_hand', names: [60, 61, 62, 63, 64].map((c) => cards[c]!.name) })),
};

/**
 * A duel with stacked decks: each player's deck is used in the order given (top first), seat 0 goes first.
 * Card instance IDs are `a0, a1, ...` for seat 0 and `b0, b1, ...` for seat 1, in deck order.
 */
function stacked(deck0: number[], deck1: number[]): DuelEvent[] {
  const instances: Record<string, { code: number; owner: Seat }> = {};
  const ids = (prefix: string, owner: Seat, codes: number[]) =>
    codes.map((code, i) => {
      instances[`${prefix}${i}`] = { code, owner };
      return `${prefix}${i}`;
    });
  return [
    {
      type: 'duelStarted',
      cards,
      sheets,
      instances,
      players: [
        { name: 'Yusei', deck: ids('a', 0, deck0), extra: ids('ax', 0, [7, 15, 17, 18, 21, 59]) },
        { name: 'Yuma', deck: ids('b', 1, deck1), extra: [] },
      ],
    },
    { type: 'drew', player: 0, count: 5 },
    { type: 'drew', player: 1, count: 5 },
    { type: 'turnStarted', player: 0, turn: 1 },
    { type: 'phaseChanged', phase: 'draw' },
    { type: 'phaseChanged', phase: 'standby' },
    { type: 'phaseChanged', phase: 'main1' },
  ];
}

/** Plays intents in order and fails the test on any refusal. */
class Table {
  events: DuelEvent[];
  state: DuelState;
  constructor(events: DuelEvent[]) {
    this.events = events;
    this.state = replay(events);
  }
  play(seat: Seat, intent: Intent) {
    const d = decide(this.state, seat, intent);
    if (!d.ok) throw new Error(d.error);
    return this.push(...d.events);
  }
  /** Adds events, then does what the server would on its own: code-only steps, and passes for players with nothing to activate. */
  push(...events: DuelEvent[]) {
    this.events.push(...events);
    this.state = replay(this.events);
    for (;;) {
      const next = nextStep(this.state);
      if (next?.kind === 'events') this.events.push(...next.events);
      else if (next?.kind === 'wait' && next.autoPass) this.events.push({ type: 'passed', player: next.player });
      else return this;
      this.state = replay(this.events);
    }
  }
  refuse(seat: Seat, intent: Intent) {
    const d = decide(this.state, seat, intent);
    expect(d.ok).toBe(false);
    return d.ok ? '' : d.error;
  }
}

const filler = (n: number, code = 1) => Array<number>(n).fill(code);

describe('starting a duel', () => {
  const dealt = () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    return startDuel(
      { players: [{ name: 'A', main: filler(40), extra: [7] }, { name: 'B', main: filler(40, 2), extra: [] }], cards, sheets },
      random,
    );
  };

  it('shuffles and deals nothing until rock-paper-scissors decides who goes first', () => {
    const t = new Table(dealt());
    expect(t.state.turn).toBe(0);
    expect(t.state.players[0].deck).toHaveLength(40);
    expect(t.state.players[0].extra).toHaveLength(1);
    expect(new Set(Object.keys(t.state.instances)).size).toBe(81);
    expect(legalActions(t.state, 0).map((a) => a.type)).toEqual(['rps', 'surrender']);
    expect(t.refuse(0, { type: 'endTurn', discard: [] })).toMatch(/rock-paper-scissors/);
  });

  it('hides a pick from the opponent until both are in', () => {
    const t = new Table(dealt());
    t.play(1, { type: 'rps', hand: 'rock' });
    expect(viewFor(t.state, 0).start).toEqual({ at: 'rps', yours: null, theirsIn: true, last: null });
    expect(viewFor(t.state, 1).start).toEqual({ at: 'rps', yours: 'rock', theirsIn: false, last: null });
    expect(JSON.stringify(logFor(t.events, 0))).not.toMatch(/rock/);
    expect(t.refuse(1, { type: 'rps', hand: 'paper' })).toMatch(/already/);
  });

  it('replays a tie, and the winner chooses to go second', () => {
    const t = new Table(dealt());
    t.play(0, { type: 'rps', hand: 'paper' });
    t.play(1, { type: 'rps', hand: 'paper' });
    expect(viewFor(t.state, 1).start).toEqual({ at: 'rps', yours: null, theirsIn: false, last: ['paper', 'paper'] });
    t.play(0, { type: 'rps', hand: 'scissors' });
    t.play(1, { type: 'rps', hand: 'rock' });
    expect(viewFor(t.state, 0).start).toEqual({ at: 'order', chooser: 1, hands: ['scissors', 'rock'] });
    expect(t.refuse(0, { type: 'chooseOrder', goFirst: true })).toMatch(/winner/);
    t.play(1, { type: 'chooseOrder', goFirst: false });
    expect(t.state.turn).toBe(1);
    expect(t.state.turnPlayer).toBe(0);
    expect(t.state.phase).toBe('main1');
    expect(t.state.players[0].hand).toHaveLength(5);
    expect(t.state.players[1].hand).toHaveLength(5);
    expect(viewFor(t.state, 0).start).toBeNull();
    expect(logFor(t.events, 0).flatMap((e) => (e.text ? [e.text] : []))).toEqual([
      'Rock-paper-scissors: A threw Paper, B threw Paper. A tie, so they pick again.',
      'Rock-paper-scissors: A threw Scissors, B threw Rock. B wins.',
      'B chose to go second',
      'A drew 5 cards',
      'B drew 5 cards',
      'Turn 1: A',
    ]);
  });
});

describe('summoning', () => {
  it('allows one Normal Summon or Set per turn', () => {
    const t = new Table(stacked([1, 2, 5, 1, 1, ...filler(35)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'a0', faceUp: true, position: 'attack' });
    expect(t.refuse(0, { type: 'setMonster', card: 'a1', tributes: [], zone: 0 })).toMatch(/already/);
  });

  it('requires tributes for Level 5 and up, and sends them to the Graveyard', () => {
    const t = new Table(stacked([3, 4, 1, 1, 1, ...filler(35)], filler(40, 2)));
    expect(t.refuse(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 })).toMatch(/needs 1 tribute/);
    t.play(0, { type: 'normalSummon', card: 'a2', tributes: [], zone: 0 });
    t.play(0, { type: 'endTurn', discard: [] });
    t.play(1, { type: 'endTurn', discard: [] });
    // Turn 3: Yusei drew, tributes Axe Raider for Luster Dragon #2.
    expect(t.refuse(0, { type: 'normalSummon', card: 'a1', tributes: ['a2'], zone: 0 })).toMatch(/needs 2 tributes/);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: ['a2'], zone: 0 });
    expect(t.state.players[0].graveyard).toEqual(['a2']);
    expect(t.state.players[0].monsters[0]?.id).toBe('a0');
  });

  it("refuses Extra Deck monsters and the opponent's turn", () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    expect(t.refuse(0, { type: 'normalSummon', card: 'ax0', tributes: [], zone: 0 })).toMatch(/not in your hand/);
    expect(t.refuse(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 })).toMatch(/not your turn/);
  });

  it('puts a card in the zone the player picks, and refuses a taken zone', () => {
    const t = new Table(stacked([6, 1, 1, ...filler(37)], filler(40, 2)));
    expect(legalActions(t.state, 0).find((a) => a.type === 'setSpellTrap')).toMatchObject({ zones: [0, 1, 2, 3, 4] });
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 3 });
    expect(t.state.players[0].spellTraps[3]?.id).toBe('a0');
    t.play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 2 });
    expect(t.state.players[0].monsters[2]?.id).toBe('a1');
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    expect(t.refuse(0, { type: 'setMonster', card: 'a2', tributes: [], zone: 2 })).toMatch(/not empty/);
    expect(t.refuse(0, { type: 'setMonster', card: 'a2', tributes: [], zone: 7 })).toMatch(/Main Monster Zones/);
    expect(t.refuse(0, { type: 'setMonster', card: 'a2', tributes: [], zone: 5 })).toMatch(/Main Monster Zones/);
  });

  it('Sets Spells and Traps face-down and hides them from the opponent', () => {
    const t = new Table(stacked([6, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 });
    t.play(0, { type: 'setMonster', card: 'a1', tributes: [], zone: 0 });
    const theirs = viewFor(t.state, 1);
    const theirLog = logFor(t.events, 1);
    expect(theirs.players[0].spellTraps[0]).toEqual({ card: { hidden: true }, position: 'attack', faceUp: false, stats: null, materials: [], spellCounters: 0 });
    expect(theirs.players[0].monsters[0]).toEqual({ card: { hidden: true }, position: 'defense', faceUp: false, stats: null, materials: [], spellCounters: 0 });
    expect(theirs.players[0].hand.every((c) => 'hidden' in c)).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain('a0');
    expect(JSON.stringify(theirLog)).not.toContain('a0');
    expect(JSON.stringify(theirLog)).not.toContain('a1');
    expect(theirLog.map((e) => e.text)).toContain('Yusei Set a Spell or Trap');
    expect(theirLog.find((e) => e.event.type === 'monsterSet')?.event).toEqual({ type: 'monsterSet', player: 0, card: null, zone: 0 });
    expect(logFor(t.events, 0).find((e) => e.event.type === 'monsterSet')?.event).toMatchObject({ card: 'a1' });
    const mine = viewFor(t.state, 0);
    expect(mine.players[0].monsters[0]?.card).toMatchObject({ id: 'a1' });
  });
});

describe('Extra Monster Zones', () => {
  /** Yusei's Junk Warrior (ax0) in his left Extra Monster Zone, on turn 2 (Yuma's) or 3 (Yusei's). */
  function withJunkWarrior(deck0: number[], deck1: number[], turn: 2 | 3) {
    const t = new Table(stacked(deck0, deck1));
    t.push({ type: 'specialSummoned', player: 0, card: 'ax0', zone: 5, position: 'attack' });
    t.play(0, { type: 'endTurn', discard: [] });
    if (turn === 3) t.play(1, { type: 'endTurn', discard: [] });
    return t;
  }

  it('are shared: one player\'s left is the other\'s right, and each player may use only one', () => {
    const t = withJunkWarrior(filler(40), filler(40, 2), 2);
    expect(t.state.players[0].monsters).toHaveLength(7);
    expect(monsterZoneFree(t.state, 0, 6)).toBe(true);
    expect(monsterZoneFree(t.state, 1, 6)).toBe(false);
    expect(monsterZoneFree(t.state, 1, 5)).toBe(true);
    expect(monsterZonesFor(t.state, 0, true)).toEqual([0, 1, 2, 3, 4]);
    expect(monsterZonesFor(t.state, 1, true)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(monsterZonesFor(t.state, 1, false)).toEqual([0, 1, 2, 3, 4]);
    // Main Deck monsters only go to the Main Monster Zones.
    expect(legalActions(t.state, 1).find((a) => a.type === 'normalSummon')).toMatchObject({ zones: [0, 1, 2, 3, 4] });
    const view = viewFor(t.state, 1);
    expect(view.players[0].monsters[5]).toMatchObject({ card: { id: 'ax0' }, stats: { atk: 2300 } });
  });

  it('hold monsters that attack and are attacked like any other', () => {
    const t = withJunkWarrior(filler(40), filler(40, 2), 2);
    t.play(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 });
    t.play(1, { type: 'enterBattle' });
    expect(legalActions(t.state, 1).find((a) => a.type === 'attack')).toMatchObject({ targets: [5], direct: false });
    t.play(1, { type: 'attack', attacker: 'b0', target: 5 });
    expect(t.state.players[1].graveyard).toEqual(['b0']);
    expect(t.state.players[1].lp).toBe(8000 - 500);
    t.play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'enterBattle' });
    t.play(0, { type: 'attack', attacker: 'ax0', target: 'direct' });
    expect(t.state.players[1].lp).toBe(7500 - 2300);
  });

  it('hold monsters that are targeted, destroyed and Tributed like any other', () => {
    const t = withJunkWarrior([4, 1, 1, 1, 1, 1, ...filler(34)], filler(40, 2), 3);
    const destroy = applyOp(t.state, { op: 'destroy', cards: ['ax0'] }, { player: 1, source: '', stage: 'resolution', random: () => 0 });
    expect(destroy.ok && replay([...t.events, ...destroy.events]).players[0].graveyard).toEqual(['ax0']);
    const anyMonster: CardFilter = { side: 'opponent', places: ['monsters'], kinds: [], types: [], races: [], attributes: [], named: null, except: null, extraDeck: null, faceUp: true, position: null, level: null, atk: { min: 2000, max: null }, def: null };
    expect(cardsFitting(t.state, { ...anyMonster, kinds: [], types: [], races: [], attributes: [] }, 1, '')).toEqual(['ax0']);
    t.play(0, { type: 'setMonster', card: 'a1', tributes: [], zone: 4 });
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [t.state.players[1].hand[0]!] });
    // Spiral Serpent (Level 8) tributes the Extra Monster Zone's monster and goes to a Main Monster Zone.
    const summon = legalActions(t.state, 0).find((a) => a.type === 'normalSummon' && a.card === 'a0');
    expect(summon).toMatchObject({ tributes: 2, tributeFrom: ['a1', 'ax0'], zones: [0, 1, 2, 3, 4] });
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: ['ax0', 'a1'], zone: 0 });
    expect(t.state.players[0].graveyard).toEqual(['ax0', 'a1']);
    expect(monsterZonesFor(t.state, 0, true)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('Synchro Summons', () => {
  /** Yusei's monsters put on the field directly, on his turn 3 (so they could attack). */
  function board(codes: number[]) {
    const t = new Table(stacked([...codes, ...filler(40 - codes.length)], filler(40, 2)));
    codes.forEach((_, i) => t.push({ type: 'specialSummoned', player: 0, card: `a${i}`, zone: i, position: 'attack' }));
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    return t;
  }
  const synchro = (t: Table, card: string) => legalActions(t.state, 0).find((a) => a.type === 'extraSummon' && a.card === card);

  it('offers a Synchro Monster whose Level the Tuner and non-Tuners add up to, with the zones it may go to', () => {
    const t = board([13, 14, 1]);
    // Junk Synchron (3) + Speed Warrior (2) = Junk Warrior (5). Nothing adds up to Gaia Knight's 6 with one Tuner.
    expect(synchro(t, 'ax0')).toEqual({ type: 'extraSummon', card: 'ax0', how: 'synchro', options: [{ materials: ['a0', 'a1'], zones: [0, 1, 3, 4, 5, 6] }] });
    expect(synchro(t, 'ax1')).toBeUndefined();
    // 3 + 4 = 7 and 3 + 2 + 4 = 9 make nothing either; Levels count as they are now.
    t.push({ type: 'statsModified', modifier: { card: 'a2', player: 0, atk: 0, def: 0, atkSet: null, defSet: null, levelDelta: -1, levelSet: null, until: 'end_of_turn', turn: 3 } });
    expect(synchro(t, 'ax1')).toMatchObject({ options: [{ materials: ['a0', 'a2'] }] });
  });

  it('needs the named Tuner, and never uses a Tuner as a non-Tuner', () => {
    const t = board([16, 14, 13]);
    // Tune Warrior isn't Junk Synchron; Junk Synchron with Tune Warrior is two Tuners.
    expect(synchro(t, 'ax0')).toMatchObject({ options: [{ materials: ['a2', 'a1'] }] });
    expect(synchro(t, 'ax1')).toBeUndefined();
  });

  it('sends the materials to the GY and puts the monster where the player chose, without using the Normal Summon', () => {
    const t = board([13, 14]);
    expect(t.refuse(0, { type: 'extraSummon', card: 'ax0', materials: ['a0'], zone: 5, position: 'attack' })).toMatch(/aren't materials/);
    expect(t.refuse(0, { type: 'extraSummon', card: 'ax0', materials: ['a0', 'a1'], zone: 7, position: 'attack' })).toBe('Choose an empty Monster Zone it can go to.');
    t.play(0, { type: 'extraSummon', card: 'ax0', materials: ['a1', 'a0'], zone: 6, position: 'defense' });
    expect(t.state.players[0].graveyard).toEqual(['a1', 'a0']);
    expect(t.state.players[0].monsters[6]).toMatchObject({ id: 'ax0', faceUp: true, position: 'defense', summoned: { how: 'synchro', turn: 3 } });
    expect(t.state.players[0].extra).toEqual(['ax1', 'ax2', 'ax3', 'ax4', 'ax5']);
    expect(t.state.normalSummons).toBe(0);
    expect(logFor(t.events, 1).at(-1)?.text).toBe('Yusei Synchro Summoned Junk Warrior in defense position, using Speed Warrior, Junk Synchron');
  });

  it('is a Special Summon for triggers: "Synchro Summoned" and "Special Summoned" fire, "Normal Summoned" does not', () => {
    const trigger = (how: SummonKind[]) => ({ ...effect('trigger'), when: { event: 'summoned', self: true, filter: null, how, canMiss: false, by: null } as const });
    const t = board([13, 14]);
    const before = { ...t.state, sheets: { ...t.state.sheets, 7: { ...t.state.sheets[7]!, effects: [trigger(['synchro']), trigger(['special']), trigger(['normal'])] } } };
    const events = decide(before, 0, { type: 'extraSummon', card: 'ax0', materials: ['a0', 'a1'], zone: 0, position: 'attack' });
    const state = events.ok ? events.events.slice(1).reduce(evolve, before) : before;
    expect(pendingTriggers(state).map((p) => p.effect)).toEqual([0, 1]);
  });
});

describe('Xyz Summons', () => {
  /** Yusei's monsters on the field on his turn 3, and Yuma's, put there directly. */
  function board(codes: number[], theirs: number[] = []) {
    const t = new Table(stacked([...codes, ...filler(40 - codes.length)], [...theirs, ...filler(40 - theirs.length, 2)]));
    codes.forEach((_, i) => t.push({ type: 'specialSummoned', player: 0, card: `a${i}`, zone: i, position: 'attack' }));
    theirs.forEach((_, i) => t.push({ type: 'specialSummoned', player: 1, card: `b${i}`, zone: i, position: 'attack' }));
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    return t;
  }
  const xyz = (t: Table, card: string) => legalActions(t.state, 0).find((a) => a.type === 'extraSummon' && a.card === card);
  const op = (t: Table, o: Op) => {
    const r = applyOp(t.state, o, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('offers an Xyz Monster for each set of face-up monsters with its Rank as their Level, Tuners included', () => {
    const t = board([1, 14, 2, 5]);
    expect(xyz(t, 'ax2')).toMatchObject({ how: 'xyz', options: [{ materials: ['a0', 'a2'] }, { materials: ['a0', 'a3'] }, { materials: ['a2', 'a3'] }] });
    expect(xyz(t, 'ax3')).toBeUndefined();
    expect(xyz(board([13, 16]), 'ax3')).toMatchObject({ options: [{ materials: ['a0', 'a1'] }] });
  });

  it('asks whether to detach a material instead of a destruction by battle', () => {
    for (const detach of [true, false]) {
      const t = board([14, 19], [2]);
      t.play(0, { type: 'extraSummon', card: 'ax4', materials: ['a0', 'a1'], zone: 0, position: 'attack' }).play(0, { type: 'endTurn', discard: [] });
      t.play(1, { type: 'enterBattle' }).play(1, { type: 'attack', attacker: 'b0', target: 0 });
      expect(t.state.step).toMatchObject({ at: 'replace', card: 'ax4', player: 0 });
      expect(viewFor(t.state, 1).waiting).toEqual({ player: 0, for: 'replace', cause: 'Gachi Gachi Gantetsu' });
      expect(t.refuse(0, { type: 'replace', materials: ['a0', 'a1'] })).toMatch(/exactly 1/);
      t.play(0, { type: 'replace', materials: detach ? ['a1'] : [] });
      // Damage is worked out before the detach: Gantetsu still had 900 ATK.
      expect(t.state.players[0].lp).toBe(8000 - 900);
      if (detach) {
        expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'ax4', materials: ['a0'] });
        expect(t.state.players[0].graveyard).toEqual(['a1']);
      } else expect(t.state.players[0].graveyard).toEqual(['a0', 'a1', 'ax4']);
    }
  });

  it('attaches the materials, which both players see, and sends them to the GY when it leaves the field', () => {
    const t = board([1, 2]);
    t.play(0, { type: 'extraSummon', card: 'ax2', materials: ['a0', 'a1'], zone: 5, position: 'attack' });
    expect(t.state.players[0].monsters[5]).toMatchObject({ id: 'ax2', materials: ['a0', 'a1'], summoned: { how: 'xyz' } });
    expect(t.state.players[0].graveyard).toEqual([]);
    expect(viewFor(t.state, 1).players[0].monsters[5]!.materials).toMatchObject([{ id: 'a0' }, { id: 'a1' }]);
    // An Xyz Monster has no Level, so it is never an Xyz Material itself, and a material is not on the field.
    expect(cardsFitting(t.state, { side: 'you', places: ['field'], kinds: [], types: [], races: [], attributes: [], named: null, except: null, extraDeck: null, faceUp: null, position: null, level: null, atk: null, def: null }, 0, '')).toEqual(['ax2']);
    op(t, { op: 'destroy', cards: ['ax2'] });
    expect(t.state.players[0].graveyard).toEqual(['a0', 'a1', 'ax2']);
  });

  it('detaches materials to pay costs, and checks conditions on how many it has', () => {
    const t = board([1, 2]);
    t.play(0, { type: 'extraSummon', card: 'ax2', materials: ['a0', 'a1'], zone: 0, position: 'attack' });
    expect(() => op(t, { op: 'detach', card: 'ax2' })).toThrow(/not an Xyz Material/);
    // "While it has no material" doesn't hold yet.
    expect(scriptProblem(t.state, 0, 'ax2', 1, null)).toMatch(/no Xyz Material/);
    op(t, { op: 'detach', card: 'a0' });
    op(t, { op: 'detach', card: 'a1' });
    expect(t.state.players[0].monsters[0]!.materials).toEqual([]);
    expect(t.state.players[0].graveyard).toEqual(['a0', 'a1']);
    expect(scriptProblem(t.state, 0, 'ax2', 0, null)).toMatch(/cost can't be paid/);
    expect(scriptProblem(t.state, 0, 'ax2', 1, null)).toBeNull();
  });

  it('fires "when this card destroys a monster by battle" for the monster that destroyed it', () => {
    const t = board([13, 16], [2]);
    t.play(0, { type: 'extraSummon', card: 'ax3', materials: ['a0', 'a1'], zone: 0, position: 'attack' });
    t.play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'ax3', target: 0 });
    expect(t.state.players[1].graveyard).toEqual(['b0']);
    expect(t.state.happened).toContainEqual(expect.objectContaining({ event: 'battle_destroying', card: 'ax3', target: 'b0' }));
    expect(pendingTriggers(t.state)).toMatchObject([{ card: 'ax3', effect: 0 }]);
  });
});

describe('continuous effects', () => {
  /** Yusei's monsters on the field on his turn 3, put there directly in the positions given. */
  function board(codes: number[], defense: number[] = []) {
    const t = new Table(stacked([...codes, ...filler(40 - codes.length)], filler(40, 2)));
    codes.forEach((_, i) => t.push({ type: 'specialSummoned', player: 0, card: `a${i}`, zone: i, position: defense.includes(i) ? 'defense' : 'attack' }));
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    return t;
  }

  it('keep a Continuous Spell on the field, applying while its condition holds', () => {
    const t = new Table(stacked([12, 1, ...filler(38)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 0 }).play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 1 }).push({ type: 'linkResolved' });
    expect(t.state.players[0].spellTraps[1]).toMatchObject({ id: 'a0', faceUp: true });
    expect(statsOf(t.state, 'a1').atk).toBe(1700);
    t.play(0, { type: 'enterBattle' });
    expect(statsOf(t.state, 'a1').atk).toBe(1900);
    expect(viewFor(t.state, 1).players[0].monsters[0]!.stats).toEqual({ atk: 1900, def: 1150, level: 4 });
    t.play(0, { type: 'enterMain2' });
    expect(statsOf(t.state, 'a1').atk).toBe(1700);
  });

  it('count cards by their current Level, and change a Level while a position holds', () => {
    const t = board([19, 19, 20], [2]);
    // Each Tenshin counts both face-up Level 2 monsters, itself included; Shine Knight is Level 4 in Defense Position.
    expect(statsOf(t.state, 'a0')).toEqual({ atk: 1600, def: 100, level: 2 });
    expect(statsOf(t.state, 'a2').level).toBe(4);
    t.play(0, { type: 'changePosition', card: 'a2' });
    expect(statsOf(t.state, 'a2').level).toBe(3);
    t.push({ type: 'statsModified', modifier: { card: 'a2', player: 0, atk: 0, def: 0, atkSet: null, defSet: null, levelDelta: -1, levelSet: null, until: 'end_of_turn', turn: 3 } });
    expect(statsOf(t.state, 'a0').atk).toBe(2000);
  });

  it('scale with Xyz Materials, and stop when the card leaves the field', () => {
    const t = board([19, 19, 1]);
    t.play(0, { type: 'extraSummon', card: 'ax4', materials: ['a0', 'a1'], zone: 0, position: 'defense' });
    expect(statsOf(t.state, 'a2')).toMatchObject({ atk: 2100, def: 1550 });
    expect(statsOf(t.state, 'ax4')).toMatchObject({ atk: 900, def: 2200 });
    const r = applyOp(t.state, { op: 'detach', card: 'a0' }, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    t.push(...(r.ok ? r.events : []));
    expect(statsOf(t.state, 'a2').atk).toBe(1900);
    const d = applyOp(t.state, { op: 'destroy', cards: ['ax4'] }, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    t.push(...(d.ok ? d.events : []));
    expect(statsOf(t.state, 'a2').atk).toBe(1700);
  });
});

describe('restrictions', () => {
  /** Monsters put on the field directly, Yusei's then Yuma's, on Yuma's turn 4 (so his can attack). */
  function board(mine: number[], theirs: number[]) {
    const t = new Table(stacked([...mine, ...filler(40 - mine.length)], [...theirs, ...filler(40 - theirs.length, 2)]));
    mine.forEach((_, i) => t.push({ type: 'specialSummoned', player: 0, card: `a${i}`, zone: i, position: 'attack' }));
    theirs.forEach((_, i) => t.push({ type: 'specialSummoned', player: 1, card: `b${i}`, zone: i, position: 'attack' }));
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] }).play(0, { type: 'endTurn', discard: [] });
    return t.play(1, { type: 'enterBattle' });
  }
  const attacks = (t: Table, seat: Seat = 1) => legalActions(t.state, seat).filter((a) => a.type === 'attack');
  /** Ends the turn, discarding down to the hand limit. */
  const end = (t: Table, seat: Seat) => t.play(seat, { type: 'endTurn', discard: t.state.players[seat].hand.slice(6) });

  it('keep a monster from being destroyed by battle with a strong enough attacker, while damage is still dealt', () => {
    const t = board([22, 22], [3, 2]);
    t.play(1, { type: 'attack', attacker: 'b0', target: 0 });
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'a0' });
    expect(t.state.players[0].lp).toBe(8000 - 2100);
    t.play(1, { type: 'attack', attacker: 'b1', target: 1 });
    expect(t.state.players[0].graveyard).toEqual(['a1']);
  });

  it('keep other Warriors from being attacked, but not the card itself', () => {
    const t = board([23, 1, 22], [3]);
    expect(attacks(t)).toEqual([{ type: 'attack', attacker: 'b0', targets: [0, 2], direct: false }]);
    expect(t.refuse(1, { type: 'attack', attacker: 'b0', target: 1 })).toMatch(/can't be targeted/);
  });

  it('remain on the field and stop attacks until the End Phase of the opponent\'s third turn', () => {
    const t = new Table(stacked([24, ...filler(39)], [3, ...filler(39, 2)]));
    t.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'attack' });
    t.play(0, { type: 'activate', card: 'a0', effect: 1, zone: 0 }).push({ type: 'linkResolved' });
    expect(t.state.players[0].spellTraps[0]).toMatchObject({ id: 'a0', faceUp: true, activatedTurn: 1 });
    for (const turn of [2, 4, 6]) {
      end(t, 0);
      expect(t.state.turn).toBe(turn);
      t.play(1, { type: 'enterBattle' });
      expect(attacks(t)).toEqual([]);
      end(t, 1);
    }
    expect(t.state.players[0].graveyard).toEqual(['a0']);
  });

  it('stop a player declaring attacks or entering the Battle Phase for the rest of the turn only', () => {
    const t = board([], [3]);
    const r = applyOp(t.state, { op: 'forbid', player: 1, what: 'declare_attack', filter: null }, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    t.push(...(r.ok ? r.events : []));
    expect(attacks(t)).toEqual([]);
    end(t, 1);
    const b = applyOp(t.state, { op: 'forbid', player: 0, what: 'battle_phase', filter: null }, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    t.push(...(b.ok ? b.events : []));
    expect(t.refuse(0, { type: 'enterBattle' })).toMatch(/can't conduct/);
    end(t, 0).play(1, { type: 'enterBattle' });
    expect(attacks(t)).toHaveLength(1);
  });
});

describe('battle changes, locks and protection', () => {
  /** Monsters put on the field directly, Yusei's then Yuma's (in Defense Position where listed), on Yuma's turn 4 in his Battle Phase. */
  function board(mine: number[], theirs: number[], defense: string[] = []) {
    const t = new Table(stacked([...mine, ...filler(40 - mine.length)], [...theirs, ...filler(40 - theirs.length, 2)]));
    const put = (player: Seat, prefix: string, codes: number[]) =>
      codes.forEach((_, i) => t.push({ type: 'specialSummoned', player, card: `${prefix}${i}`, zone: i, position: defense.includes(`${prefix}${i}`) ? 'defense' : 'attack' }));
    put(0, 'a', mine);
    put(1, 'b', theirs);
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] }).play(0, { type: 'endTurn', discard: [] });
    return t.play(1, { type: 'enterBattle' });
  }
  const attackers = (t: Table) => legalActions(t.state, 1).flatMap((a) => (a.type === 'attack' ? [a.attacker] : []));
  const op = (t: Table, o: Op, source: string, player: Seat = 1) => {
    const r = applyOp(t.state, o, { player, source, stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('let a monster attack twice, or again after attacking a Defense Position monster, with piercing damage', () => {
    const t = board([], [35]);
    t.play(1, { type: 'attack', attacker: 'b0', target: 'direct' }).play(1, { type: 'attack', attacker: 'b0', target: 'direct' });
    expect(t.state.players[0].lp).toBe(6000);
    expect(attackers(t)).toEqual([]);

    const m = board([14, 14, 14], [36], ['a0', 'a1']);
    m.play(1, { type: 'attack', attacker: 'b0', target: 0 });
    expect(m.state.players[0].lp).toBe(8000 - 1200);
    m.play(1, { type: 'attack', attacker: 'b0', target: 2 });
    expect(m.state.players[0].lp).toBe(8000 - 1200 - 700);
    // Its last attack was on an Attack Position monster, so no third.
    expect(attackers(m)).toEqual([]);
  });

  it('keep a monster once per turn from being destroyed by battle, and its controller from battle damage', () => {
    const t = board([37], [3, 2]);
    t.play(1, { type: 'attack', attacker: 'b0', target: 0 });
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'a0' });
    expect(t.state.players[0].lp).toBe(8000);
    expect(logFor(t.events, 0).map((e) => e.text)).toContain('Fortress Warrior used its once-per-turn protection');
    t.play(1, { type: 'attack', attacker: 'b1', target: 0 });
    expect(t.state.players[0].graveyard).toEqual(['a0']);
    expect(t.state.players[0].lp).toBe(8000);
  });

  it('change ATK in the Damage Step only, by whether the monster attacks or is attacked', () => {
    const t = board([2], [38]);
    expect(statsOf(t.state, 'b0').atk).toBe(1800);
    t.play(1, { type: 'attack', attacker: 'b0', target: 0 });
    expect(t.state.players[0].graveyard).toEqual(['a0']);
    expect(t.state.players[0].lp).toBe(7700);
    expect(statsOf(t.state, 'b0').atk).toBe(1800);
  });

  it('stop attacks by Level, or by ATK at least this card\'s DEF', () => {
    expect(attackers(board([39], [3, 35]))).toEqual(['b1']);
    expect(attackers(board([40], [3, 35]))).toEqual(['b1']);
  });

  it('stop Tribute Summons but not Tribute Sets', () => {
    const t = new Table(stacked([42, ...filler(39)], [1, 3, ...filler(38, 2)]));
    t.push({ type: 'specialSummoned', player: 0, card: 'a0', zone: 0, position: 'attack' }, { type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'attack' });
    t.play(0, { type: 'endTurn', discard: [] });
    const summons = legalActions(t.state, 1).flatMap((a) => (a.type === 'normalSummon' || a.type === 'setMonster') && a.card === 'b1' ? [a.type] : []);
    expect(summons).toEqual(['setMonster']);
    expect(t.refuse(1, { type: 'normalSummon', card: 'b1', tributes: ['b0'], zone: 0 })).toMatch(/Tribute Summoning/);
  });

  it('make Spells be Set first and activated on a later turn, and allow one Spell/Trap a turn', () => {
    const spells = (t: Table, seat: Seat) => legalActions(t.state, seat).flatMap((a) => (a.type === 'activate' ? [a.card] : []));
    const w = new Table(stacked([9, 41, ...filler(38)], filler(40, 2)));
    w.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 0, position: 'attack' });
    expect(spells(w, 0)).toEqual([]);
    expect(viewFor(w.state, 0).blocked.find((b) => b.card === 'a0')?.reason).toMatch(/Set first/);
    w.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 });
    expect(spells(w, 0)).toEqual([]);
    w.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    expect(spells(w, 0)).toEqual(['a0']);

    // A Quick-Play Set on your turn waits for your next turn, not your opponent's.
    const q = new Table(stacked([51, 41, ...filler(38)], filler(40, 2)));
    q.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 0, position: 'attack' });
    q.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).play(0, { type: 'endTurn', discard: [] });
    q.play(1, { type: 'enterBattle' });
    expect(q.state).toMatchObject({ turnPlayer: 1, phase: 'battle', step: { at: 'open' } });
    q.play(1, { type: 'endTurn', discard: [] });
    expect(spells(q, 0)).toEqual(['a0']);

    const m = new Table(stacked([9, 9, ...filler(38)], [43, ...filler(39, 2)]));
    m.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'attack' });
    expect(spells(m, 0)).toEqual(['a0', 'a1']);
    m.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 0 }).push({ type: 'linkResolved' });
    expect(spells(m, 0)).toEqual([]);
    expect(viewFor(m.state, 0).blocked.find((b) => b.card === 'a1')?.reason).toMatch(/only 1/);

    // The limit is on Spell/Trap Cards: a face-up Continuous Spell's own effect is still free to use, and isn't counted.
    const c = new Table(stacked([52, 9, ...filler(38)], [43, ...filler(39, 2)]));
    c.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'attack' });
    c.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 0 }).push({ type: 'linkResolved' });
    expect(legalActions(c.state, 0).flatMap((a) => (a.type === 'activate' ? [`${a.card}:${a.effect}`] : []))).toEqual(['a0:1']);
  });

  it('keep cards from being destroyed by Spell and Trap effects, or affected by Extra Deck monsters', () => {
    // Yuma's Spell (in his hand) can't destroy Dai-sojo; his monster's effect can.
    const t = new Table(stacked([44, 1, ...filler(38)], [9, ...filler(39, 2)]));
    t.push({ type: 'specialSummoned', player: 0, card: 'a0', zone: 0, position: 'attack' }, { type: 'specialSummoned', player: 0, card: 'a1', zone: 1, position: 'attack' });
    op(t, { op: 'destroy', cards: ['a0', 'a1'] }, 'b0');
    expect(t.state.players[0].graveyard).toEqual(['a1']);
    op(t, { op: 'destroy', cards: ['a0'] }, 'b1');
    expect(t.state.players[0].graveyard).toEqual(['a1', 'a0']);

    const f = board([1], [46]);
    op(f, { op: 'destroy', cards: ['b0'] }, 'ax0', 0);
    expect(f.state.players[1].monsters[0]).toMatchObject({ id: 'b0' });
    op(f, { op: 'destroy', cards: ['b0'] }, 'a0', 0);
    expect(f.state.players[1].graveyard).toEqual(['b0']);
  });

  it('negate the effects of the monster a card is tied to while it stays', () => {
    const t = new Table(stacked([45, 10, ...filler(38)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 0 });
    const ignition = () => legalActions(t.state, 0).some((a) => a.type === 'activate' && a.card === 'a1');
    expect(ignition()).toBe(true);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    op(t, { op: 'link', card: 'a1' }, 'a0', 0).push({ type: 'linkResolved' });
    expect(ignition()).toBe(false);
    expect(viewFor(t.state, 0).blocked.find((b) => b.card === 'a1')?.reason).toMatch(/negated/);
    op(t, { op: 'destroy', cards: ['a0'] }, 'a1', 0);
    expect(ignition()).toBe(true);
  });
});

describe('leaving the field, names and Synchro Material', () => {
  const op = (t: Table, o: Op) => {
    const r = applyOp(t.state, o, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('banish a monster Special Summoned "but banish it when it leaves the field", wherever it would go', () => {
    const t = new Table(stacked([1, 1, ...filler(38)], filler(40, 2)));
    op(t, { op: 'special_summon', card: 'a0', controller: 0, position: 'attack', zone: 0, banish_when_leaves: true });
    op(t, { op: 'special_summon', card: 'a1', controller: 0, position: 'attack', zone: 1, banish_when_leaves: true });
    op(t, { op: 'destroy', cards: ['a0'] });
    op(t, { op: 'move', card: 'a1', to: 'hand' });
    expect(t.state.players[0].banished).toEqual(['a0', 'a1']);
    expect(t.state.players[0].graveyard).toEqual([]);
  });

  it('fire a trigger in the GY when its card is sent there from the field, and put the top card on the bottom without a shuffle', () => {
    const t = new Table(stacked([50, ...filler(39)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    op(t, { op: 'move', card: 'a0', to: 'graveyard' }).push({ type: 'checkpoint', cause: null, then: { do: 'open' } });
    expect(pendingTriggers(t.state)).toMatchObject([{ card: 'a0', effect: 0, cause: { event: 'sent_to_graveyard' } }]);
    const top = t.state.players[0].deck[0]!;
    const rest = t.state.players[0].deck.slice(1);
    op(t, { op: 'move', card: top, to: 'deck_bottom' });
    expect(t.state.players[0].deck).toEqual([...rest, top]);
  });

  it("use a name an effect gives while on the field", () => {
    const t = new Table(stacked([47, ...filler(39)], filler(40, 2)));
    const desFrog = (place: CardFilter['places'][number]) => cardsFitting(t.state, { ...filter({ side: 'you', places: [place], faceUp: null }), named: 'Des Frog' }, 0, '');
    expect(desFrog('hand')).toEqual([]);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(desFrog('monsters')).toEqual(['a0']);
  });

  it('let a Tuner stand in for a named one, and keep monsters that say so from being Synchro Material', () => {
    const t = new Table(stacked([48, 1, 49, 13, ...filler(36)], filler(40, 2)));
    ['a0', 'a1', 'a2', 'a3'].forEach((card, zone) => t.push({ type: 'specialSummoned', player: 0, card, zone, position: 'attack' }));
    const synchro = (id: string) => legalActions(t.state, 0).find((a) => a.type === 'extraSummon' && a.card === id);
    // Junk Warrior needs Junk Synchron: Quickdraw Synchron (Level 1) stands in with Axe Raider, but not with
    // Ronintoadin (also Level 4), which is never Synchro Material.
    expect(synchro('ax0')).toEqual(expect.objectContaining({ options: [expect.objectContaining({ materials: ['a0', 'a1'] })] }));
  });
});

describe('summoning procedures', () => {
  const procedures = (t: Table) => legalActions(t.state, 0).filter((a) => a.type === 'activate');
  const op = (t: Table, o: Op) => {
    const r = applyOp(t.state, o, { player: 0, source: '', stage: 'activation', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('Special Summon from the hand without a chain once their condition holds, and their bans last the turn', () => {
    const t = new Table(stacked([31, 31, 32, 13, 14, ...filler(35)], filler(40, 2)));
    expect(procedures(t)).toEqual([]);
    expect(viewFor(t.state, 0).blocked.find((b) => b.card === 'a0')?.reason).toMatch(/WATER/);
    t.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 0, position: 'attack' });
    expect(procedures(t)).toMatchObject([{ card: 'a0', effect: 0, zones: null }]);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    expect(t.state.chain).toEqual([]);
    expect(t.state.step.at).toBe('open');
    // The server pays the cost and makes the Summon from the script, then the checkpoint follows.
    op(t, { op: 'special_summon', card: 'a0', controller: 0, position: 'defense', zone: 1, banish_when_leaves: false });
    op(t, { op: 'forbid', player: 0, what: 'special_summon', filter: fromHand });
    t.push(procedureDone(t.state, 'a0'));
    expect(t.state.players[0].monsters[1]).toMatchObject({ id: 'a0', position: 'defense', summoned: { how: 'special', turn: 1 } });
    expect(applyOp(t.state, { op: 'special_summon', card: 'a3', controller: 0, position: 'attack', zone: 2, banish_when_leaves: false }, { player: 0, source: '', stage: 'resolution', random: () => 0 })).toMatchObject({ ok: false, error: /stops/ });
    expect(logFor(t.events, 1).map((e) => e.text)).toContain("Yusei can't Special Summon a monster in their hand this turn");
    // The Normal Summon is still there, but not for a monster that can't be Normal Summoned.
    expect(legalActions(t.state, 0).filter((a) => a.type === 'normalSummon').map((a) => 'card' in a && a.card)).toEqual(['a3', 'a4']);
    expect(t.refuse(0, { type: 'normalSummon', card: 'a2', tributes: ['a0', 'a1'], zone: 0 })).toMatch(/cannot be Normal Summoned/);
  });

  it('can ban Special Summons of high-Level monsters, Synchro Summons included', () => {
    const t = new Table(stacked([13, 14, ...filler(38)], filler(40, 2)));
    t.push({ type: 'specialSummoned', player: 0, card: 'a0', zone: 0, position: 'attack' }, { type: 'specialSummoned', player: 0, card: 'a1', zone: 1, position: 'attack' });
    expect(legalActions(t.state, 0).some((a) => a.type === 'extraSummon' && a.card === 'ax0')).toBe(true);
    op(t, { op: 'forbid', player: 0, what: 'special_summon', filter: filter({ places: [], side: 'you', faceUp: null, level: { min: 5, max: null } }) });
    expect(legalActions(t.state, 0).some((a) => a.type === 'extraSummon')).toBe(false);
  });

  it('are offered when the Tribute they cost frees the only Monster Zone', () => {
    const t = new Table(stacked([53, ...filler(39)], filler(40, 2)));
    ['a1', 'a2', 'a3', 'a4', 'a5'].forEach((card, zone) => t.push({ type: 'specialSummoned', player: 0, card, zone, position: 'attack' }));
    expect(procedures(t)).toMatchObject([{ card: 'a0', effect: 0 }]);
  });

  it("can't be used after the thing their whole-turn ban forbids was already done this turn", () => {
    const t = new Table(stacked([54, 3, ...filler(38)], filler(40, 2)));
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toBeNull();
    t.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 0, position: 'attack' });
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toMatch(/already Special Summoned a card with Level 5 or more/);
    // It still counts once the monster has left the field.
    t.push({ type: 'moved', card: 'a1', owner: 0, from: 'monsters', to: 'graveyard' });
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toMatch(/already/);
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toBeNull();
  });

  it('must be used before another effect can Special Summon the monster, and again once it is back in the hand', () => {
    const t = new Table(stacked([55, ...filler(39)], filler(40, 2)));
    const revive = (card: string) => applyOp(t.state, { op: 'special_summon', card, controller: 0, position: 'attack', zone: 0, banish_when_leaves: false }, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    t.push({ type: 'discarded', player: 0, cards: ['a0'] });
    expect(revive('a0')).toMatchObject({ ok: false, error: /own procedure/ });
    t.push({ type: 'moved', card: 'a0', owner: 0, from: 'graveyard', to: 'hand' });
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    op(t, { op: 'special_summon', card: 'a0', controller: 0, position: 'attack', zone: 0, banish_when_leaves: false });
    t.push(procedureDone(t.state, 'a0'));
    t.push({ type: 'moved', card: 'a0', owner: 0, from: 'monsters', to: 'graveyard' });
    expect(revive('a0')).toMatchObject({ ok: true });
    t.push({ type: 'moved', card: 'a0', owner: 0, from: 'graveyard', to: 'hand' }, { type: 'discarded', player: 0, cards: ['a0'] });
    expect(revive('a0')).toMatchObject({ ok: false });
    // An Extra Deck monster sent to the GY without its Synchro Summon can't be revived either.
    t.push({ type: 'moved', card: 'ax0', owner: 0, from: 'extra', to: 'graveyard' });
    expect(revive('ax0')).toMatchObject({ ok: false, error: /Synchro Summoned/ });
  });

  it('count the cards each player controls for "4 or more cards than you"', () => {
    const t = new Table(stacked([33, ...filler(39)], filler(40, 2)));
    const foe = (i: number) => t.push({ type: 'specialSummoned', player: 1, card: `b${i}`, zone: i, position: 'attack' });
    [0, 1, 2].forEach(foe);
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toMatch(/4 more cards/);
    foe(3);
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toBeNull();
  });
});

describe('effects used from the GY', () => {
  it('are offered only while the card is there, in the Main Phase', () => {
    const t = new Table(stacked([34, ...filler(39)], filler(40, 2)));
    const offered = () => legalActions(t.state, 0).some((a) => a.type === 'activate' && a.card === 'a0');
    expect(offered()).toBe(false);
    expect(viewFor(t.state, 0).blocked.find((b) => b.card === 'a0')?.reason).toMatch(/in your GY/);
    t.push({ type: 'discarded', player: 0, cards: ['a0'] });
    expect(offered()).toBe(true);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    expect(t.state.chain).toMatchObject([{ card: 'a0' }]);
  });
});

describe('control and Tokens', () => {
  const op = (t: Table, o: Op, player: Seat = 0) => {
    const r = applyOp(t.state, o, { player, source: '', stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };
  const iceToken = { name: 'Ice Barrier Token', attribute: 'WATER', race: 'Aqua', level: 1, atk: 0, def: 0 };

  it('takes control until the End Phase: the monster attacks for its new controller, then goes back', () => {
    const t = new Table(stacked(filler(40), [3, ...filler(39, 2)]));
    t.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 2, position: 'attack' });
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    expect(applyOp(t.state, { op: 'take_control', card: 'b0', controller: 1, zone: 0, until: null }, { player: 0, source: '', stage: 'resolution', random: () => 0 })).toMatchObject({ ok: false });
    op(t, { op: 'take_control', card: 'b0', controller: 0, zone: 4, until: 'end_phase' });
    expect(t.state.players[0].monsters[4]).toMatchObject({ id: 'b0', returnsAtEndPhase: true, summoned: { how: 'special' } });
    expect(t.state.players[1].monsters[2]).toBeNull();
    t.play(0, { type: 'enterBattle' });
    expect(legalActions(t.state, 0).some((a) => a.type === 'attack' && a.attacker === 'b0' && a.direct)).toBe(true);
    t.play(0, { type: 'endTurn', discard: [] });
    expect(t.state.players[1].monsters[0]).toMatchObject({ id: 'b0', returnsAtEndPhase: false });
    expect(logFor(t.events, 1).map((e) => e.text)).toContain('Yusei took control of Luster Dragon #2 until the End Phase');
  });

  it('sends a monster taken for good to its owner\'s GY when it is destroyed', () => {
    const t = new Table(stacked(filler(40), [3, ...filler(39, 2)]));
    t.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'attack' });
    op(t, { op: 'take_control', card: 'b0', controller: 0, zone: 0, until: null });
    op(t, { op: 'destroy', cards: ['b0'] });
    expect(t.state.players[1].graveyard).toEqual(['b0']);
  });

  it('makes Tokens that vanish when they leave the field', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    op(t, { op: 'summon_token', controller: 0, token: iceToken, position: 'defense', zone: 0 });
    op(t, { op: 'summon_token', controller: 0, token: { ...iceToken, level: 4 }, position: 'attack', zone: 1 });
    const [first, second] = [t.state.players[0].monsters[0]!.id, t.state.players[0].monsters[1]!.id];
    expect(first).not.toBe(second);
    expect(viewFor(t.state, 1).players[0].monsters[0]).toMatchObject({ card: { card: { name: 'Ice Barrier Token', type: 'Token', level: 1 } }, position: 'defense' });
    expect(t.state.happened.at(-1)).toMatchObject({ event: 'summoned', card: second, how: 'special' });
    op(t, { op: 'destroy', cards: [first] });
    op(t, { op: 'move', card: second, to: 'hand' });
    expect(t.state.players[0].graveyard).toEqual([]);
    expect(t.state.players[0].hand).toHaveLength(5);
    expect(t.state.players[0].monsters.every((m) => m === null)).toBe(true);
  });

  it('pays a cost only the picked effect has', () => {
    const t = new Table(stacked(filler(40), [3, ...filler(39, 2)]));
    t.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'attack' });
    const tribute = { do: 'move', cards: { from: 'choose', filter: filter({ side: 'you', faceUp: null }), min: 1, max: 1, rank: null, distinct: false, includeSelf: false }, to: 'graveyard' } as const;
    const script: Script = {
      conditions: [],
      cost: [],
      targets: { filter: filter({ side: 'opponent' }), min: 1, max: 1, others: true, event: false },
      options: [
        { label: 'Change its position', cost: [], steps: [] },
        { label: 'Take control of it', cost: [tribute], steps: [{ do: 'take_control', cards: { from: 'targets' }, until: 'end_phase' }] },
      ],
      unapplied: null,
    };
    const withScript = (state: DuelState): DuelState => ({ ...state, sheets: { ...state.sheets, 8: sheet(8, { ...effect('activation'), script }) } });
    expect(feasibleOptions(withScript(t.state), script, 0, 'a0')).toEqual([0]);
    t.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 0, position: 'attack' });
    expect(feasibleOptions(withScript(t.state), script, 0, 'a0')).toEqual([0, 1]);
  });
});

describe('winning hands', () => {
  it('end the duel when the last piece of Exodia is drawn', () => {
    const t = new Table(stacked([60, 61, 62, 63, 1, 64, ...filler(34)], filler(40, 2)));
    t.play(0, { type: 'endTurn', discard: [] });
    expect(t.state.result).toBeNull();
    t.play(1, { type: 'endTurn', discard: [] });
    expect(t.state.result).toEqual({ winner: 0, reason: 'handWin' });
    expect(logFor(t.events, 1).find((e) => e.event.type === 'duelEnded')!.text).toBe('Yusei won: Yusei held every piece of a winning hand');
  });
});

describe('equipped and tied cards', () => {
  /** Yusei's monsters on the field and Spells/Traps in his hand (or Set on turn 1), on his turn 3. */
  function board(monsters: number[], cards: number[], set = false) {
    const t = new Table(stacked([...cards, ...monsters, ...filler(40 - cards.length - monsters.length)], filler(40, 2)));
    monsters.forEach((_, i) => t.push({ type: 'specialSummoned', player: 0, card: `a${cards.length + i}`, zone: i, position: 'attack' }));
    if (set) cards.forEach((_, i) => t.play(0, { type: 'setSpellTrap', card: `a${i}`, zone: i }));
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    return t;
  }
  const op = (t: Table, o: Op) => {
    const r = applyOp(t.state, o, { player: 0, source: '', stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };
  /** Activates a card and resolves it with these ops. */
  const resolve = (t: Table, card: string, zone: number | null, ops: Op[]) => {
    t.play(0, { type: 'activate', card, effect: 0, zone });
    for (const o of ops) op(t, o);
    return t.push({ type: 'linkResolved' });
  };

  it('put a Field Spell in the Field Zone, where it stays and applies, and a new one sends the old one to the GY', () => {
    const t = board([1], [56, 57, 25]);
    expect(legalActions(t.state, 0)).toContainEqual({ type: 'setSpellTrap', card: 'a0', zones: [5] });
    expect(legalActions(t.state, 0)).toContainEqual({ type: 'setSpellTrap', card: 'a2', zones: [0, 1, 2, 3, 4] });
    expect(() => t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 0 })).toThrow();
    resolve(t, 'a0', 5, []);
    expect(t.state.players[0].spellTraps[5]).toMatchObject({ id: 'a0', faceUp: true });
    expect(statsOf(t.state, 'a3')).toMatchObject({ atk: 1900, def: 1350 });
    resolve(t, 'a1', 5, []);
    expect(t.state.players[0].spellTraps[5]).toMatchObject({ id: 'a1' });
    expect(t.state.players[0].graveyard).toEqual(['a0']);
    expect(statsOf(t.state, 'a3').atk).toBe(1700);
  });

  it('Fusion Summon a Fusion Monster with materials from the hand and field, which go to the GY', () => {
    expect(scriptProblem(board([], [58]).state, 0, 'a0', 0, null)).toMatch(/No Fusion Monster/);
    const t = board([1], [58, 2]);
    expect(scriptProblem(t.state, 0, 'a0', 0, null)).toBeNull();
    expect(fusionMaterialOptions(t.state, 0, 'ax5', ['hand', 'field'], [])).toEqual(expect.arrayContaining(['a1', 'a2']));
    // With an Axe Raider picked, only Dark Blade is left to finish the set.
    expect(fusionMaterialOptions(t.state, 0, 'ax5', ['hand', 'field'], ['a2'])).toEqual(['a1']);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 0 });
    expect(() => op(t, { op: 'fusion_summon', card: 'ax5', materials: ['a2', 'a3'], from: ['hand', 'field'], zone: 0, position: 'attack' })).toThrow(/aren't Fusion Materials/);
    op(t, { op: 'fusion_summon', card: 'ax5', materials: ['a2', 'a1'], from: ['hand', 'field'], zone: 0, position: 'attack' });
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'ax5', summoned: { how: 'fusion' } });
    expect(t.state.players[0].graveyard).toEqual(['a2', 'a1']);
    expect(t.state.properlySummoned).toContain('ax5');
    expect(logFor(t.events, 1).some((e) => e.text?.startsWith('Yusei Fusion Summoned Flame Swordsman'))).toBe(true);
  });

  it('keep monsters in a battle position, changing those that arrive in another', () => {
    const t = board([66, 1], [65], true);
    resolve(t, 'a0', null, []);
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'a1', position: 'defense' });
    expect(t.state.players[0].monsters[1]).toMatchObject({ id: 'a2', position: 'attack' });
    // A Dragon that arrives in Attack Position is changed at once, until the card is gone.
    t.push({ type: 'moved', card: 'a1', owner: 0, from: 'monsters', to: 'hand' });
    t.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 2, position: 'attack' });
    expect(t.state.players[0].monsters[2]).toMatchObject({ id: 'a1', position: 'defense' });
    t.push({ type: 'moved', card: 'a0', owner: 0, from: 'spellTraps', to: 'graveyard' });
    t.push({ type: 'moved', card: 'a1', owner: 0, from: 'monsters', to: 'hand' });
    t.push({ type: 'specialSummoned', player: 0, card: 'a1', zone: 3, position: 'attack' });
    expect(t.state.players[0].monsters[3]).toMatchObject({ id: 'a1', position: 'attack' });
  });

  it('apply an Equip Spell to its monster and send it to the GY with the monster', () => {
    const t = board([14], [25, 25]);
    resolve(t, 'a0', 0, [{ op: 'link', card: 'a2' }]);
    expect(t.state.players[0].spellTraps[0]).toMatchObject({ id: 'a0', linked: 'a2' });
    expect(statsOf(t.state, 'a2')).toEqual({ atk: 1400, def: 400, level: 3 });
    expect(logFor(t.events, 1).some((e) => e.text === 'Synchro Boost equipped to Speed Warrior')).toBe(true);
    // An Equip Spell that resolves without a monster has nothing to do on the field.
    resolve(t, 'a1', 1, []);
    expect(t.state.players[0].graveyard).toEqual(['a1']);
    op(t, { op: 'destroy', cards: ['a2'] });
    expect(t.state.players[0].graveyard).toEqual(['a1', 'a0', 'a2']);
    expect(statsOf(t.state, 'a2').atk).toBe(900);
  });

  it('tie a Continuous Trap to its monster: each takes the other with it, and Defense Position breaks both', () => {
    const t = board([14, 1], [26, 26], true);
    resolve(t, 'a0', null, [{ op: 'link', card: 'a2' }]);
    resolve(t, 'a1', null, [{ op: 'link', card: 'a3' }]);
    t.play(0, { type: 'enterBattle' });
    expect(legalActions(t.state, 0).filter((a) => a.type === 'attack')).toEqual([]);
    t.play(0, { type: 'enterMain2' });
    op(t, { op: 'destroy', cards: ['a0'] });
    expect(t.state.players[0].graveyard).toEqual(['a2', 'a0']);
    t.play(0, { type: 'changePosition', card: 'a3' });
    expect(t.state.players[0].graveyard).toEqual(['a2', 'a0', 'a3', 'a1']);
  });
});

describe('negation', () => {
  const op = (t: Table, o: Op, player: Seat = 0) => {
    const r = applyOp(t.state, o, { player, source: '', stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('a Counter Trap negates a Trap: the negated link resolves doing nothing and goes to the GY', () => {
    const t = new Table(stacked([11, ...filler(39)], [27, ...filler(39, 2)]));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).play(0, { type: 'endTurn', discard: [] });
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 1 });
    expect(viewFor(t.state, 1).waiting?.cause).toBe('the activation of Reinforce Truth');
    t.play(1, { type: 'activate', card: 'b0', effect: 0, zone: null });
    expect(t.state.step.at).toBe('resolve');
    op(t, { op: 'negate_activation', card: 'a0' }, 1).push({ type: 'linkResolved' });
    expect(t.state.chain).toEqual([]);
    expect(t.state.players[0].graveyard).toEqual(['a0']);
    expect(t.state.players[1].graveyard).toEqual(['b0']);
  });

  it('a monster with its effects negated has no ignition effect to activate', () => {
    const t = new Table(stacked([10, ...filler(39)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(legalActions(t.state, 0).some((a) => a.type === 'activate' && a.card === 'a0')).toBe(true);
    op(t, { op: 'negate_effects', card: 'a0' });
    expect(legalActions(t.state, 0).some((a) => a.type === 'activate' && a.card === 'a0')).toBe(false);
  });

  it('a Trap Set again stays on the field face-down', () => {
    const t = new Table(stacked([11, ...filler(39)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    op(t, { op: 'set_again' }).push({ type: 'linkResolved' });
    expect(t.state.players[0].spellTraps[0]).toMatchObject({ id: 'a0', faceUp: false, placedTurn: 3 });
    expect(t.state.players[0].graveyard).toEqual([]);
  });
});

describe('timing', () => {
  const op = (t: Table, o: Op, player: Seat = 0) => {
    const r = applyOp(t.state, o, { player, source: '', stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('fires a trigger at the start of the Damage Step only when its battle fits', () => {
    for (const set of [false, true]) {
      const t = new Table(stacked([28, ...filler(39)], [1, ...filler(39, 2)]));
      t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'endTurn', discard: [] });
      if (set) t.play(1, { type: 'setMonster', card: 'b0', tributes: [], zone: 0 });
      else t.push({ type: 'specialSummoned', player: 1, card: 'b0', zone: 0, position: 'defense' });
      t.play(1, { type: 'endTurn', discard: [] }).play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'a0', target: 0 });
      if (set) {
        // A face-down monster isn't a face-up Defense Position one, so nothing fires and the battle goes on.
        expect(t.state.step.at).toBe('open');
        expect(t.events.some((e) => e.type === 'destroyedByBattle' && e.cards.includes('b0'))).toBe(true);
      } else {
        expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'a0', cause: { event: 'damage_step_start', target: 'b0' } } });
      }
    }
  });

  it('fires an End Phase trigger on the turn its monster was Summoned', () => {
    const t = new Table(stacked([29, ...filler(39)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'endTurn', discard: [] });
    expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'a0', cause: { event: 'phase', phase: 'end' } } });
  });

  it("fires a trigger when the opponent's effect destroys this card, not the player's own", () => {
    for (const by of [1, 0] as Seat[]) {
      const t = new Table(stacked([30, ...filler(39)], filler(40, 2)));
      t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
      op(t, { op: 'destroy', cards: ['a0'] }, by).push({ type: 'checkpoint', cause: null, then: { do: 'open' } });
      expect(pendingTriggers(t.state).map((p) => p.card)).toEqual(by === 1 ? ['a0'] : []);
    }
  });

  it('places counters up to their limit and removes them', () => {
    const t = new Table(stacked([30, ...filler(39)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    op(t, { op: 'add_counters', card: 'a0', counter: 'spell', count: 1, max: 1 });
    expect(applyOp(t.state, { op: 'add_counters', card: 'a0', counter: 'spell', count: 1, max: 1 }, { player: 0, source: '', stage: 'resolution', random: () => 0 }).ok).toBe(false);
    expect(viewFor(t.state, 1).players[0].monsters[0]?.spellCounters).toBe(1);
    op(t, { op: 'remove_counters', card: 'a0', counter: 'spell', count: 1 });
    expect(t.state.players[0].monsters[0]?.counters).toEqual({ spell: 0 });
  });
});

describe('rollback', () => {
  it('rewinds to before an overturned activation once both players accept, and refuses it from then on', () => {
    const t = new Table(stacked([11, ...filler(39)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    const to = t.events.length;
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    const decision = { stage: 'activation', player: 0, card: 'a0', effect: 0, legal: true } as const;
    t.push({ type: 'rollbackOffered', offer: { judged: to + 1, to, decision, ruling: 'It needs a Level 1 Warrior in the Deck.', explanation: 'There was nothing to Summon.' } });
    expect(viewFor(t.state, 1).rollback).toEqual({ explanation: 'There was nothing to Summon.', accepted: [] });
    t.play(1, { type: 'rollback', accept: true });
    expect(t.refuse(1, { type: 'rollback', accept: true })).toMatch(/no rewind/);
    expect(legalActions(t.state, 0)).toContainEqual({ type: 'rollback' });
    t.play(0, { type: 'rollback', accept: true });
    const { instances: _i, cards: _c, sheets: _s, ...board } = replay(t.events.slice(0, t.state.rollback!.to));
    t.push({ type: 'rolledBack', to, board });
    expect(t.state.chain).toEqual([]);
    expect(t.state.players[0].spellTraps[0]).toMatchObject({ id: 'a0', faceUp: false });
    expect(t.refuse(0, { type: 'activate', card: 'a0', effect: 0, zone: null })).toMatch(/Level 1 Warrior/);
  });

  it('drops the offer when either player declines', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    const decision = { stage: 'resolution', player: 0, card: 'a0', effect: 0, legal: true } as const;
    t.push({ type: 'rollbackOffered', offer: { judged: 3, to: 3, decision, ruling: '', explanation: '' } });
    t.play(1, { type: 'rollback', accept: false });
    expect(t.state.rollback).toBeNull();
  });
});

describe('positions', () => {
  it("can't change position on the turn a monster arrives, then once per turn after", () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(t.refuse(0, { type: 'changePosition', card: 'a0' })).toMatch(/can't be changed/);
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'changePosition', card: 'a0' });
    expect(t.state.players[0].monsters[0]?.position).toBe('defense');
    expect(t.refuse(0, { type: 'changePosition', card: 'a0' })).toMatch(/can't be changed/);
  });

  it('Flip Summons a Set monster on a later turn', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(0, { type: 'setMonster', card: 'a0', tributes: [], zone: 0 });
    expect(t.refuse(0, { type: 'flipSummon', card: 'a0' })).toMatch(/can't be Flip Summoned/);
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'flipSummon', card: 'a0' });
    expect(t.state.players[0].monsters[0]).toMatchObject({ faceUp: true, position: 'attack' });
  });
});

describe('battle', () => {
  /** Yusei summons `mine` on turn 1; Yuma summons or sets `theirs` on turn 2, then it is Yusei's battle on turn 3. */
  function battle(mine: number, theirs: number, set = false) {
    const t = new Table(stacked([mine, ...filler(39)], [theirs, ...filler(39, 2)]));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'endTurn', discard: [] });
    t.play(1, { type: set ? 'setMonster' : 'normalSummon', card: 'b0', tributes: [], zone: 0 }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'enterBattle' });
    return t;
  }

  it('has no Battle Phase on the first turn', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    expect(t.refuse(0, { type: 'enterBattle' })).toMatch(/first turn/);
  });

  it('destroys the weaker attack-position monster and deals the difference', () => {
    const t = battle(2, 1); // Dark Blade 1800 attacks Axe Raider 1700
    expect(t.refuse(0, { type: 'attack', attacker: 'a0', target: 'direct' })).toMatch(/directly/);
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[1].graveyard).toEqual(['b0']);
    expect(t.state.players[1].lp).toBe(7900);
    expect(t.refuse(0, { type: 'attack', attacker: 'a0', target: 'direct' })).toMatch(/can't attack/);
  });

  it('destroys the attacker when it is weaker', () => {
    const t = battle(1, 2);
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[0].graveyard).toEqual(['a0']);
    expect(t.state.players[0].lp).toBe(7900);
  });

  it('destroys both on equal ATK', () => {
    const t = battle(1, 1);
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[0].graveyard).toEqual(['a0']);
    expect(t.state.players[1].graveyard).toEqual(['b0']);
  });

  it('flips a Set monster and uses its DEF; no damage to the defender', () => {
    const t = battle(1, 5, true); // Axe Raider 1700 into Spirit of the Harp 2000 DEF
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[1].monsters[0]).toMatchObject({ faceUp: true, position: 'defense' });
    expect(t.state.players[0].lp).toBe(7700);
    expect(t.state.players[1].lp).toBe(8000);
    const log = logFor(t.events, 0);
    expect(log.map((e) => e.text)).toContain('Axe Raider attacked Spirit of the Harp');
    expect(log.find((e) => e.event.type === 'attackDeclared')?.event).toMatchObject({ targetZone: 0 });
  });

  it("can't change position after attacking", () => {
    const t = battle(2, 1);
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 }).play(0, { type: 'enterMain2' });
    expect(t.refuse(0, { type: 'changePosition', card: 'a0' })).toMatch(/can't be changed/);
  });
});

describe('winning', () => {
  it('wins when LP reaches 0', () => {
    // Yuma's deck is all Traps; Setting one each turn keeps their hand at six.
    const t = new Table(stacked(filler(40), filler(40, 6)));
    const yumaTurn = () => {
      t.play(1, { type: 'setSpellTrap', card: t.state.players[1].hand[0]!, zone: t.state.players[1].spellTraps.indexOf(null) }).play(1, { type: 'endTurn', discard: [] });
    };
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'endTurn', discard: [] });
    yumaTurn();
    // Axe Raider attacks directly for 1700 a turn: the 5th attack takes 8000 LP to 0.
    for (let i = 0; i < 5; i++) {
      t.play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'a0', target: 'direct' });
      if (i < 4) {
        const hand = t.state.players[0].hand;
        t.play(0, { type: 'endTurn', discard: hand.slice(6) });
        yumaTurn();
      }
    }
    expect(t.state.players[1].lp).toBe(0);
    expect(t.state.result).toEqual({ winner: 0, reason: 'lp' });
    expect(t.refuse(1, { type: 'surrender' })).toMatch(/over/);
  });

  it('loses when the deck is empty at the draw', () => {
    const t = new Table(stacked(filler(40), filler(6, 2)));
    t.play(0, { type: 'endTurn', discard: [] }); // Yuma draws the 6th and last card
    t.play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'endTurn', discard: [] }); // Yuma can't draw
    expect(t.state.result).toEqual({ winner: 0, reason: 'deckOut' });
    expect(logFor(t.events, 1).at(-1)?.text).toBe("Yusei won: Yuma couldn't draw");
  });

  it('discards down to six at the end of the turn', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'endTurn', discard: [] });
    // Yuma now holds 7.
    expect(t.refuse(1, { type: 'endTurn', discard: [] })).toMatch(/Discard exactly 1 card/);
    t.play(1, { type: 'endTurn', discard: ['b3'] });
    expect(t.state.players[1].graveyard).toEqual(['b3']);
    expect(t.state.players[1].hand).toHaveLength(6);
  });

  it('surrender ends the duel', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(1, { type: 'surrender' });
    expect(t.state.result).toEqual({ winner: 0, reason: 'surrender' });
  });
});

describe('activating effects', () => {
  const ctx = { player: 0 as Seat, source: '', stage: 'resolution' as const, random: () => 0.5 };
  /** Applies ops as the judge would and fails the test on any refusal. */
  function ops(t: Table, list: Op[], stage: 'activation' | 'resolution' = 'resolution') {
    for (const op of list) {
      const r = applyOp(t.state, op, { ...ctx, stage });
      if (!r.ok) throw new Error(r.error);
      t.events.push(...r.events);
      t.state = replay(t.events);
    }
  }
  const resolve = (t: Table) => t.push({ type: 'linkResolved' });

  it('offers Normal, Quick-Play and Continuous Spells from the hand', () => {
    const t = new Table(stacked([8, 9, 12, 1, 1, ...filler(35)], filler(40, 2)));
    const offered = legalActions(t.state, 0).filter((a) => a.type === 'activate').map((a) => a.card);
    expect(offered).toEqual(['a0', 'a1', 'a2']);
    expect(legalActions(t.state, 1).some((a) => a.type === 'activate')).toBe(false);
  });

  it('puts a Spell face-up in the chosen zone, blocks other moves until it resolves, then sends it to the GY', () => {
    const t = new Table(stacked([9, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    expect(t.refuse(0, { type: 'activate', card: 'a0', effect: 0, zone: null })).toMatch(/Spell & Trap Zone/);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 2 });
    expect(t.state.players[0].spellTraps[2]).toMatchObject({ id: 'a0', faceUp: true });
    expect(t.state.chain).toEqual([{ player: 0, card: 'a0', effect: 0, targets: [], choice: null, cause: null, negated: false, setAgain: false, taxed: false }]);
    expect(legalActions(t.state, 0)).toEqual([{ type: 'surrender' }]);
    expect(t.refuse(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 0 })).toMatch(/resolve/);
    resolve(t);
    expect(t.state.chain).toEqual([]);
    expect(t.state.players[0].graveyard).toEqual(['a0']);
  });

  it('lets a Set Trap be activated only from the next turn, and keeps once-per-turn effects to once', () => {
    const t = new Table(stacked([11, 10, 1, 1, 1, 1, ...filler(34)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 0 });
    expect(legalActions(t.state, 0).filter((a) => a.type === 'activate').map((a) => a.card)).toEqual(['a1']);
    t.play(0, { type: 'activate', card: 'a1', effect: 0, zone: null });
    resolve(t);
    expect(t.refuse(0, { type: 'activate', card: 'a1', effect: 0, zone: null })).toMatch(/can't be activated/);
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    expect(legalActions(t.state, 0).filter((a) => a.type === 'activate').map((a) => a.card)).toEqual(['a1', 'a0']);
  });

  it('stops offering an activation ruled illegal until the board changes', () => {
    const t = new Table(stacked([9, 8, 1, 1, 1, ...filler(35)], filler(40, 2)));
    const record = (fields: Partial<JudgeRecord>): DuelEvent => ({
      type: 'judged',
      record: { stage: 'activation', player: 0, card: 'a0', effect: 0, model: 'test', promptVersion: 'test', stateHash: '', transcript: [], legal: false, summary: 'There is no monster in your GY.', ops: [], error: null, usage: [], ...fields },
    });
    const offered = () => legalActions(t.state, 0).filter((a) => a.type === 'activate').map((a) => a.card);
    const push = (...events: DuelEvent[]) => {
      t.events.push(...events);
      t.state = replay(t.events);
    };

    // A failed judge call isn't a ruling.
    push(record({ error: 'timeout', summary: 'The judge could not rule on this activation, so it was not activated.' }));
    expect(offered()).toEqual(['a0', 'a1']);

    push(record({}));
    expect(offered()).toEqual(['a1']);
    expect(t.refuse(0, { type: 'activate', card: 'a0', effect: 0, zone: 2 })).toMatch(/already ruled .* There is no monster in your GY\./);
    // Another refused activation and an upheld appeal leave the board as it was.
    const appealed = (card: string, verdict: 'upheld' | 'overturned'): DuelEvent => ({
      type: 'appealed',
      appeal: { judged: 7, decision: { stage: 'activation', player: 0, card, effect: 0, legal: false }, by: 0, note: '', model: 'test', verdict, explanation: '', ruling: `${card} is legal.`, usage: [] },
    });
    push(record({ card: 'a1' }), appealed('a1', 'upheld'));
    expect(offered()).toEqual([]);
    expect(legalActions(t.state, 1).length).toBeGreaterThan(0);

    // An overturned refusal lifts it for that card only, and binds the next try to the appeal's ruling.
    push(appealed('a0', 'overturned'));
    expect(offered()).toEqual(['a0']);
    expect(t.state.rulings.find((r) => r.card === 'a0')).toMatchObject({ legal: true, summary: 'a0 is legal.' });
    push(record({}));
    t.play(0, { type: 'normalSummon', card: 'a2', tributes: [], zone: 0 });
    expect(offered()).toEqual(['a0', 'a1']);
  });

  it('records the effect chosen on activation for the resolution', () => {
    const t = new Table(stacked([9, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 2 });
    expect(applyOp(t.state, { op: 'choose_effect', choice: 'Inflict 800 damage' }, ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/activated/) });
    ops(t, [{ op: 'choose_effect', choice: 'Inflict 800 damage' }], 'activation');
    expect(t.state.chain[0]!.choice).toBe('Inflict 800 damage');
    expect(applyOp(t.state, { op: 'choose_effect', choice: 'Gain 1200 LP' }, { ...ctx, stage: 'activation' })).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
  });

  it('checks ops against the board', () => {
    const t = new Table(stacked([10, 9, 1, 1, 1, ...filler(35)], filler(40, 2)));
    const refused = (op: Op) => {
      const r = applyOp(t.state, op, ctx);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(refused({ op: 'destroy', cards: ['a1'] })).toMatch(/not on the field/);
    expect(refused({ op: 'destroy', cards: ['zz'] })).toMatch(/no card/);
    expect(refused({ op: 'change_lp', player: 0, amount: 9000, kind: 'cost' })).toMatch(/more than/);
    expect(refused({ op: 'modify_stats', card: 'a1', atk: 500, def: 0, atk_set: null, def_set: null, level_delta: 0, level_set: null, until: 'end_of_turn' })).toMatch(/not on the field/);
    expect(refused({ op: 'declare_targets', cards: ['a1'] })).toMatch(/activated/);
    expect(refused({ op: 'special_summon', card: 'ax0', controller: 0, position: 'attack', zone: 0, banish_when_leaves: false })).toMatch(/Extra Deck/);
    expect(refused({ op: 'special_summon', card: 'a6', controller: 0, position: 'attack', zone: 5, banish_when_leaves: false })).toMatch(/isn't an empty Main Monster Zone/);
  });

  it('special summons from the Deck and shuffles it, and searches stay hidden from the opponent', () => {
    const t = new Table(stacked([1, 1, 1, 1, 1, 2, 5, 3, ...filler(32)], filler(40, 2)));
    ops(t, [{ op: 'special_summon', card: 'a6', controller: 0, position: 'defense', zone: 3, banish_when_leaves: false }]);
    expect(t.state.players[0].monsters[3]).toMatchObject({ id: 'a6', faceUp: true, position: 'defense' });
    expect(t.state.players[0].deck).toHaveLength(34);
    ops(t, [{ op: 'move', card: 'a7', to: 'hand' }]);
    expect(t.state.players[0].hand).toContain('a7');
    const theirs = logFor(t.events, 1);
    expect(theirs.at(-1)!.event).toMatchObject({ type: 'moved', card: null, from: 'deck', to: 'hand' });
    expect(JSON.stringify(theirs)).not.toContain('a7');
    expect(logFor(t.events, 0).at(-1)!.event).toMatchObject({ type: 'moved', card: 'a7' });
  });

  it('keeps a Set card hidden from its owner\'s opponent when it is targeted and returned to the hand', () => {
    const t = new Table(stacked([9, ...filler(39)], [6, ...filler(39, 2)]));
    t.play(0, { type: 'endTurn', discard: [] });
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 2 });
    ops(t, [{ op: 'declare_targets', cards: ['b0'] }], 'activation');
    ops(t, [{ op: 'move', card: 'b0', to: 'hand' }]);
    const mine = logFor(t.events, 0).slice(-2);
    expect(mine.map((e) => e.text)).toEqual(['Targeting a face-down card', "Yuma's card from the field to the hand"]);
    expect(JSON.stringify(mine)).not.toContain('b0');
    expect(JSON.stringify(logFor(t.events, 'none'))).not.toContain('Trap Hole');
    expect(logFor(t.events, 1).slice(-2).map((e) => e.text)).toEqual(['Targeting Trap Hole', 'Trap Hole from the field to the hand']);
  });

  it('modifies stats for battle and ends the modifier on time', () => {
    const t = new Table(stacked([5, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    ops(t, [
      { op: 'modify_stats', card: 'a0', atk: 700, def: 0, atk_set: null, def_set: null, level_delta: 0, level_set: null, until: 'end_of_turn' },
      { op: 'modify_stats', card: 'a0', atk: 0, def: 0, atk_set: null, def_set: null, level_delta: 0, level_set: 3, until: 'while_on_field' },
    ]);
    expect(viewFor(t.state, 1).players[0].monsters[0]!.stats).toEqual({ atk: 1500, def: 2000, level: 3 });
    t.play(0, { type: 'endTurn', discard: [] });
    expect(viewFor(t.state, 1).players[0].monsters[0]!.stats).toEqual({ atk: 800, def: 2000, level: 3 });
  });

  it('ends the duel when an effect takes the last LP', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    ops(t, [{ op: 'change_lp', player: 1, amount: 8000, kind: 'damage' }]);
    expect(t.state.result).toEqual({ winner: 0, reason: 'lp' });
  });

  it('allows a second Normal Summon after an extra one is granted', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    ops(t, [{ op: 'extra_normal_summon', player: 0 }]);
    t.play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 1 });
    expect(t.refuse(0, { type: 'normalSummon', card: 'a2', tributes: [], zone: 2 })).toMatch(/already/);
  });
});
