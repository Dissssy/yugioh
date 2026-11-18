import { describe, expect, it } from 'vitest';
import {
  decide,
  replay,
  startDuel,
  viewFor,
  type CardData,
  type DuelEvent,
  type DuelState,
  type Intent,
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
      { players: [{ name: 'A', main: filler(40), extra: [7] }, { name: 'B', main: filler(40, 2), extra: [] }], cards },
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
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [] });
    expect(t.state.players[0].monsters[0]).toMatchObject({ id: 'a0', faceUp: true, position: 'attack' });
    expect(t.refuse(0, { type: 'setMonster', card: 'a1', tributes: [] })).toMatch(/already/);
  });

  it('requires tributes for Level 5 and up, and sends them to the Graveyard', () => {
    const t = new Table(stacked([3, 4, 1, 1, 1, ...filler(35)], filler(40, 2)));
    expect(t.refuse(0, { type: 'normalSummon', card: 'a0', tributes: [] })).toMatch(/needs 1 tribute/);
    t.play(0, { type: 'normalSummon', card: 'a2', tributes: [] });
    t.play(0, { type: 'endTurn', discard: [] });
    t.play(1, { type: 'endTurn', discard: [] });
    // Turn 3: Yusei drew, tributes Axe Raider for Luster Dragon #2.
    expect(t.refuse(0, { type: 'normalSummon', card: 'a1', tributes: ['a2'] })).toMatch(/needs 2 tributes/);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: ['a2'] });
    expect(t.state.players[0].graveyard).toEqual(['a2']);
    expect(t.state.players[0].monsters[0]?.id).toBe('a0');
  });

  it("refuses Extra Deck monsters and the opponent's turn", () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    expect(t.refuse(0, { type: 'normalSummon', card: 'ax0', tributes: [] })).toMatch(/not in your hand/);
    expect(t.refuse(1, { type: 'normalSummon', card: 'b0', tributes: [] })).toMatch(/not your turn/);
  });

  it('Sets Spells and Traps face-down and hides them from the opponent', () => {
    const t = new Table(stacked([6, 1, 1, 1, 1, ...filler(35)], filler(40, 2)));
    t.play(0, { type: 'setSpellTrap', card: 'a0' });
    t.play(0, { type: 'setMonster', card: 'a1', tributes: [] });
    const theirs = viewFor(t.state, t.events, 1);
    expect(theirs.players[0].spellTraps[0]).toEqual({ card: { hidden: true }, position: 'attack', faceUp: false });
    expect(theirs.players[0].monsters[0]).toEqual({ card: { hidden: true }, position: 'defense', faceUp: false });
    expect(theirs.players[0].hand.every((c) => 'hidden' in c)).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain('a0');
    expect(theirs.log).toContain('Yusei Set a Spell or Trap');
    const mine = viewFor(t.state, t.events, 0);
    expect(mine.players[0].monsters[0]?.card).toMatchObject({ id: 'a1' });
  });
});

describe('positions', () => {
  it("can't change position on the turn a monster arrives, then once per turn after", () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [] });
    expect(t.refuse(0, { type: 'changePosition', card: 'a0' })).toMatch(/can't be changed/);
    t.play(0, { type: 'endTurn', discard: [] }).play(1, { type: 'endTurn', discard: [] });
    t.play(0, { type: 'changePosition', card: 'a0' });
    expect(t.state.players[0].monsters[0]?.position).toBe('defense');
    expect(t.refuse(0, { type: 'changePosition', card: 'a0' })).toMatch(/can't be changed/);
  });

  it('Flip Summons a Set monster on a later turn', () => {
    const t = new Table(stacked(filler(40), filler(40, 2)));
    t.play(0, { type: 'setMonster', card: 'a0', tributes: [] });
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
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [] }).play(0, { type: 'endTurn', discard: [] });
    t.play(1, { type: set ? 'setMonster' : 'normalSummon', card: 'b0', tributes: [] }).play(1, { type: 'endTurn', discard: [] });
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
    expect(viewFor(t.state, t.events, 0).log).toContain('Axe Raider attacked Spirit of the Harp');
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
      t.play(1, { type: 'setSpellTrap', card: t.state.players[1].hand[0]! }).play(1, { type: 'endTurn', discard: [] });
    };
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [] }).play(0, { type: 'endTurn', discard: [] });
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
    expect(viewFor(t.state, t.events, 1).log.at(-1)).toBe("Yusei won: Yuma couldn't draw");
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
