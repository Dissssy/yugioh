import { describe, expect, it } from 'vitest';
import {
  decide,
  legalActions,
  replay,
  startDuel,
  logFor,
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
});
const sheet = (code: number, ...effects: SheetEffect[]): EffectSheet => ({ code, textHash: '', verified: true, model: 'test', effects, materials: null });
const sheets: Record<number, EffectSheet> = {
  8: sheet(8, effect('activation')),
  9: sheet(9, effect('activation')),
  10: sheet(10, effect('ignition', 'soft')),
  11: sheet(11, effect('activation')),
  12: sheet(12, effect('activation')),
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
        { name: 'Yusei', deck: ids('a', 0, deck0), extra: ids('ax', 0, [7]) },
        { name: 'Yuma', deck: ids('b', 1, deck1), extra: [] },
      ],
      first: 0,
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
    this.events.push(...d.events);
    this.state = replay(this.events);
    return this;
  }
  refuse(seat: Seat, intent: Intent) {
    const d = decide(this.state, seat, intent);
    expect(d.ok).toBe(false);
    return d.ok ? '' : d.error;
  }
}

const filler = (n: number, code = 1) => Array<number>(n).fill(code);

describe('starting a duel', () => {
  it('shuffles, deals five each and lets the first player start in Main Phase 1 without drawing', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const events = startDuel(
      { players: [{ name: 'A', main: filler(40), extra: [7] }, { name: 'B', main: filler(40, 2), extra: [] }], cards, sheets },
      random,
    );
    const state = replay(events);
    const first = state.turnPlayer;
    expect(state.turn).toBe(1);
    expect(state.phase).toBe('main1');
    expect(state.players[first].hand).toHaveLength(5);
    expect(state.players[first === 0 ? 1 : 0].hand).toHaveLength(5);
    expect(state.players[0].deck).toHaveLength(35);
    expect(state.players[0].extra).toHaveLength(1);
    expect(new Set(Object.keys(state.instances)).size).toBe(81);
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
    expect(t.refuse(0, { type: 'setMonster', card: 'a2', tributes: [], zone: 7 })).toMatch(/no Monster Zone/);
  });

  it('Sets Spells and Traps face-down and hides them from the opponent', () => {
    const t = new Table(stacked([6, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 });
    t.play(0, { type: 'setMonster', card: 'a1', tributes: [], zone: 0 });
    const theirs = viewFor(t.state, 1);
    const theirLog = logFor(t.events, 1);
    expect(theirs.players[0].spellTraps[0]).toEqual({ card: { hidden: true }, position: 'attack', faceUp: false, stats: null });
    expect(theirs.players[0].monsters[0]).toEqual({ card: { hidden: true }, position: 'defense', faceUp: false, stats: null });
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
  const resolve = (t: Table) => {
    t.events.push({ type: 'linkResolved' });
    t.state = replay(t.events);
  };

  it('offers Normal and Quick-Play Spells from the hand, but not Continuous ones yet', () => {
    const t = new Table(stacked([8, 9, 12, 1, 1, ...filler(35)], filler(40, 2)));
    const offered = legalActions(t.state, 0).filter((a) => a.type === 'activate').map((a) => a.card);
    expect(offered).toEqual(['a0', 'a1']);
    expect(legalActions(t.state, 1).some((a) => a.type === 'activate')).toBe(false);
  });

  it('puts a Spell face-up in the chosen zone, blocks other moves until it resolves, then sends it to the GY', () => {
    const t = new Table(stacked([9, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    expect(t.refuse(0, { type: 'activate', card: 'a0', effect: 0, zone: null })).toMatch(/Spell & Trap Zone/);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 2 });
    expect(t.state.players[0].spellTraps[2]).toMatchObject({ id: 'a0', faceUp: true });
    expect(t.state.chain).toEqual([{ player: 0, card: 'a0', effect: 0, targets: [], choice: null }]);
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
      record: { stage: 'activation', player: 0, card: 'a0', effect: 0, model: 'test', promptVersion: 'test', stateHash: '', transcript: [], legal: false, summary: 'There is no monster in your GY.', ops: [], error: null, ...fields },
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
    push(record({ card: 'a1' }), { type: 'appealed', appeal: { judged: 7, by: 0, note: '', model: 'test', verdict: 'upheld', explanation: '', ruling: '' } });
    expect(offered()).toEqual([]);
    expect(legalActions(t.state, 1).length).toBeGreaterThan(0);

    // An overturned ruling lifts it, and so does any change to the board.
    push({ type: 'appealed', appeal: { judged: 7, by: 0, note: '', model: 'test', verdict: 'overturned', explanation: '', ruling: '' } });
    expect(offered()).toEqual(['a0', 'a1']);
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
    expect(refused({ op: 'modify_stats', card: 'a1', atk: 500, def: 0, level_delta: 0, level_set: null, until: 'end_of_turn' })).toMatch(/not on the field/);
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
      { op: 'modify_stats', card: 'a0', atk: 700, def: 0, level_delta: 0, level_set: null, until: 'end_of_turn' },
      { op: 'modify_stats', card: 'a0', atk: 0, def: 0, level_delta: 0, level_set: 3, until: 'while_on_field' },
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
