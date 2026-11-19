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
};

function spell(code: number, name: string): CardData {
  return { ...monster(code, name, 0, 0, 0), type: 'Spell Card', kind: 'spell', level: null, atk: null, def: null, attribute: null, race: 'Normal' };
}

const effect = (kind: SheetEffect['kind'], opt: SheetEffect['opt'] = 'none'): SheetEffect => ({
  kind,
  speed: kind === 'quick' ? 2 : 1,
  mandatory: false,
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
const filter = (f: Partial<CardFilter>): CardFilter => ({ side: 'either', place: 'monsters', kinds: [], types: [], races: [], attributes: [], faceUp: true, position: null, level: null, atk: null, def: null, ...f });
const aura = (c: Partial<Extract<Continuous, { apply: 'stats' }>>): Continuous => ({ apply: 'stats', to: 'self', atk: 0, def: 0, per: null, levelDelta: 0, levelSet: null, while: [], ...c });
const restrict = (c: Partial<Extract<Continuous, { apply: 'restrict' }>>): Continuous => ({ apply: 'restrict', to: 'self', others: false, cannot: [], by: null, while: [], ...c });
const sheet = (code: number, ...effects: SheetEffect[]): EffectSheet => ({ code, textHash: '', model: 'test', effects, materials: null });
const detachSelf = { do: 'detach', cards: { from: 'self' }, count: 1 } as const;
const scripted = (script: Partial<Script>): Pick<SheetEffect, 'script'> => ({ script: { conditions: [], cost: [], targets: null, options: [], unapplied: null, ...script } });
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
    { ...effect('activation'), ...scripted({ options: [{ label: '', steps: [] }] }) },
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
    when: { event: 'activated', self: false, filter: filter({ place: 'any', kinds: ['trap'], faceUp: null }), how: [], from: 'field', canMiss: false },
  }),
  21: { ...sheet(21, { ...effect('continuous'), continuous: aura({ to: filter({ side: 'you' }), atk: 200, def: 200, per: 'materials' }) }), materials: { summon: 'xyz', level: 2, count: 2 } },
  7: { ...sheet(7), materials: { summon: 'synchro', tuner: 'Junk Synchron', nonTuners: { min: 1, max: null } } },
  15: { ...sheet(15), materials: { summon: 'synchro', tuner: null, nonTuners: { min: 1, max: null } } },
  17: {
    ...sheet(
      17,
      { ...effect('quick'), ...scripted({ cost: [detachSelf], options: [{ label: '', steps: [{ do: 'negate_attack' }] }] }) },
      {
        ...effect('trigger'),
        mandatory: true,
        when: { event: 'attacked', self: true, filter: null, how: [], from: 'field', canMiss: false },
        ...scripted({ conditions: [{ if: 'materials', min: null, max: 0 }], options: [{ label: '', steps: [{ do: 'destroy', cards: { from: 'self' } }] }] }),
      },
    ),
    materials: { summon: 'xyz', level: 4, count: 2 },
  },
  18: {
    ...sheet(18, {
      ...effect('trigger'),
      when: { event: 'battle_destroying', self: true, filter: null, how: [], from: 'field', canMiss: true },
      ...scripted({ cost: [detachSelf], options: [{ label: '', steps: [{ do: 'change_lp', player: 'opponent', amount: 1000, kind: 'damage' }] }] }),
    }),
    materials: { summon: 'xyz', level: 3, count: 2 },
  },
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
        { name: 'Yusei', deck: ids('a', 0, deck0), extra: ids('ax', 0, [7, 15, 17, 18, 21]) },
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
    expect(theirs.players[0].spellTraps[0]).toEqual({ card: { hidden: true }, position: 'attack', faceUp: false, stats: null, materials: [] });
    expect(theirs.players[0].monsters[0]).toEqual({ card: { hidden: true }, position: 'defense', faceUp: false, stats: null, materials: [] });
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
    const destroy = applyOp(t.state, { op: 'destroy', cards: ['ax0'] }, { player: 1, stage: 'resolution', random: () => 0 });
    expect(destroy.ok && replay([...t.events, ...destroy.events]).players[0].graveyard).toEqual(['ax0']);
    const anyMonster = { side: 'opponent', place: 'monsters', kinds: [], types: [], races: [], attributes: [], faceUp: true, position: null, level: null, atk: { min: 2000, max: null }, def: null } as const;
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
    expect(t.state.players[0].extra).toEqual(['ax1', 'ax2', 'ax3', 'ax4']);
    expect(t.state.normalSummons).toBe(0);
    expect(logFor(t.events, 1).at(-1)?.text).toBe('Yusei Synchro Summoned Junk Warrior in defense position, using Speed Warrior, Junk Synchron');
  });

  it('is a Special Summon for triggers: "Synchro Summoned" and "Special Summoned" fire, "Normal Summoned" does not', () => {
    const trigger = (how: SummonKind[]) => ({ ...effect('trigger'), when: { event: 'summoned', self: true, filter: null, how, from: 'field', canMiss: false } as const });
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
    const r = applyOp(t.state, o, { player: 0, stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };

  it('offers an Xyz Monster for each set of face-up monsters with its Rank as their Level, Tuners included', () => {
    const t = board([1, 14, 2, 5]);
    expect(xyz(t, 'ax2')).toMatchObject({ how: 'xyz', options: [{ materials: ['a0', 'a2'] }, { materials: ['a0', 'a3'] }, { materials: ['a2', 'a3'] }] });
    expect(xyz(t, 'ax3')).toBeUndefined();
    expect(xyz(board([13, 16]), 'ax3')).toMatchObject({ options: [{ materials: ['a0', 'a1'] }] });
  });

  it('attaches the materials, which both players see, and sends them to the GY when it leaves the field', () => {
    const t = board([1, 2]);
    t.play(0, { type: 'extraSummon', card: 'ax2', materials: ['a0', 'a1'], zone: 5, position: 'attack' });
    expect(t.state.players[0].monsters[5]).toMatchObject({ id: 'ax2', materials: ['a0', 'a1'], summoned: { how: 'xyz' } });
    expect(t.state.players[0].graveyard).toEqual([]);
    expect(viewFor(t.state, 1).players[0].monsters[5]!.materials).toMatchObject([{ id: 'a0' }, { id: 'a1' }]);
    // An Xyz Monster has no Level, so it is never an Xyz Material itself, and a material is not on the field.
    expect(cardsFitting(t.state, { side: 'you', place: 'field', kinds: [], types: [], races: [], attributes: [], faceUp: null, position: null, level: null, atk: null, def: null }, 0, '')).toEqual(['ax2']);
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
    const r = applyOp(t.state, { op: 'detach', card: 'a0' }, { player: 0, stage: 'resolution', random: () => 0 });
    t.push(...(r.ok ? r.events : []));
    expect(statsOf(t.state, 'a2').atk).toBe(1900);
    const d = applyOp(t.state, { op: 'destroy', cards: ['ax4'] }, { player: 0, stage: 'resolution', random: () => 0 });
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
    const r = applyOp(t.state, { op: 'forbid', player: 1, what: 'declare_attack' }, { player: 0, stage: 'resolution', random: () => 0 });
    t.push(...(r.ok ? r.events : []));
    expect(attacks(t)).toEqual([]);
    end(t, 1);
    const b = applyOp(t.state, { op: 'forbid', player: 0, what: 'battle_phase' }, { player: 0, stage: 'resolution', random: () => 0 });
    t.push(...(b.ok ? b.events : []));
    expect(t.refuse(0, { type: 'enterBattle' })).toMatch(/can't conduct/);
    end(t, 0).play(1, { type: 'enterBattle' });
    expect(attacks(t)).toHaveLength(1);
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
    const r = applyOp(t.state, o, { player: 0, stage: 'resolution', random: () => 0 });
    if (!r.ok) throw new Error(r.error);
    return t.push(...r.events);
  };
  /** Activates a card and resolves it with these ops. */
  const resolve = (t: Table, card: string, zone: number | null, ops: Op[]) => {
    t.play(0, { type: 'activate', card, effect: 0, zone });
    for (const o of ops) op(t, o);
    return t.push({ type: 'linkResolved' });
  };

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
    const r = applyOp(t.state, o, { player, stage: 'resolution', random: () => 0 });
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
  const ctx = { player: 0 as Seat, stage: 'resolution' as const, random: () => 0.5 };
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
    expect(t.state.chain).toEqual([{ player: 0, card: 'a0', effect: 0, targets: [], choice: null, cause: null, negated: false, setAgain: false }]);
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
    expect(refused({ op: 'special_summon', card: 'ax0', controller: 0, position: 'attack' })).toMatch(/Extra Deck/);
  });

  it('special summons from the Deck and shuffles it, and searches stay hidden from the opponent', () => {
    const t = new Table(stacked([1, 1, 1, 1, 1, 2, 5, 3, ...filler(32)], filler(40, 2)));
    ops(t, [{ op: 'special_summon', card: 'a6', controller: 0, position: 'defense' }]);
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'a6', faceUp: true, position: 'defense' });
    expect(t.state.players[0].deck).toHaveLength(34);
    ops(t, [{ op: 'move', card: 'a7', to: 'hand' }]);
    expect(t.state.players[0].hand).toContain('a7');
    const theirs = logFor(t.events, 1);
    expect(theirs.at(-1)!.event).toMatchObject({ type: 'moved', card: null, from: 'deck', to: 'hand' });
    expect(JSON.stringify(theirs)).not.toContain('a7');
    expect(logFor(t.events, 0).at(-1)!.event).toMatchObject({ type: 'moved', card: 'a7' });
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
