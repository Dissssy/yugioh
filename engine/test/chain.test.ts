import { describe, expect, it } from 'vitest';
import {
  blockedAttacks,
  blockedEffects,
  decide,
  legalActions,
  nextStep,
  replay,
  statsOf,
  targetMax,
  viewFor,
  type CardData,
  type CardFilter,
  type DuelEvent,
  type DuelState,
  type EffectSheet,
  type Intent,
  type Script,
  type Seat,
  type SheetEffect,
  type When,
} from '../src/index.ts';

const monster = (code: number, name: string, atk: number, def: number, level = 4): CardData => ({
  code,
  name,
  type: 'Effect Monster',
  kind: 'monster',
  extraDeck: false,
  text: '',
  level,
  atk,
  def,
  attribute: 'EARTH',
  race: 'Warrior',
});
const card = (code: number, name: string, kind: 'spell' | 'trap', race: string): CardData => ({
  ...monster(code, name, 0, 0),
  type: kind === 'spell' ? 'Spell Card' : 'Trap Card',
  kind,
  level: null,
  atk: null,
  def: null,
  attribute: null,
  race,
});

const cards: Record<number, CardData> = {
  1: monster(1, 'Axe Raider', 1700, 1150),
  2: monster(2, 'Weak Knight', 900, 500),
  3: card(3, 'Trap Hole', 'trap', 'Normal'),
  4: card(4, 'Mirror Force', 'trap', 'Normal'),
  5: monster(5, 'Magna Drago', 1400, 600),
  6: monster(6, 'Copycat', 0, 0),
  7: monster(7, 'Speed Warrior', 900, 400, 2),
  8: monster(8, 'Mystic Tomato', 1400, 1100),
  9: card(9, 'Twister', 'spell', 'Quick-Play'),
  10: card(10, 'Pot', 'spell', 'Normal'),
  11: monster(11, 'Big Wall', 0, 3000),
  12: monster(12, 'Trident Warrior', 1700, 1400),
  13: monster(13, 'Man-Eater Bug', 450, 600, 2),
  20: monster(20, 'General Wayne', 1800, 1000),
  21: monster(21, 'Chainsaw Insect', 2400, 0),
  22: monster(22, 'General Grunard', 2800, 1000),
  23: monster(23, 'Ice Soldier', 1000, 1000),
  24: monster(24, 'General Raiho', 2100, 1000),
  25: monster(25, 'Blade Knight', 1600, 1000),
  26: monster(26, 'Silencer', 1000, 1000),
  27: { ...monster(27, 'Junk Synchron', 1300, 500, 3), type: 'Tuner Effect Monster' },
  28: { ...monster(28, 'Junk Destroyer', 2600, 2500, 8), type: 'Synchro Effect Monster', extraDeck: true },
};

const filter = (f: Partial<CardFilter>): CardFilter => ({
  side: 'either',
  place: 'monsters',
  kinds: [],
  types: [],
  races: [],
  attributes: [],
  named: null,
  extraDeck: null,
  faceUp: null,
  position: null,
  level: null,
  atk: null,
  def: null,
  ...f,
});
const when = (w: Partial<When> & Pick<When, 'event'>): When => ({ self: false, filter: null, how: [], canMiss: false, by: null, ...w });
const script = (s: Partial<Script>): Script => ({ conditions: [], cost: [], targets: null, options: [{ label: '', cost: [], steps: [] }], unapplied: null, ...s });
const effect = (e: Partial<SheetEffect> & Pick<SheetEffect, 'kind'>): SheetEffect => ({
  speed: 1,
  mandatory: false,
  from: 'field',
  opt: 'none',
  window: '',
  cost: '',
  effect: `${e.kind} effect`,
  targets: null,
  when: null,
  script: null,
  continuous: null,
  status: 'unverified',
  ...e,
});
const sheet = (code: number, ...effects: SheetEffect[]): EffectSheet => ({ code, textHash: '', model: 'test', effects, materials: null, normalSummon: true });

const sheets: Record<number, EffectSheet> = {
  3: sheet(
    3,
    effect({
      kind: 'activation',
      speed: 2,
      when: when({ event: 'summoned', how: ['normal', 'flip'], filter: filter({ side: 'opponent', atk: { min: 1000, max: null } }) }),
      script: script({
        targets: { filter: filter({ side: 'opponent', atk: { min: 1000, max: null } }), min: 1, max: 1, others: true, event: true },
        options: [{ label: '', cost: [], steps: [{ do: 'destroy', cards: { from: 'targets' } }] }],
      }),
    }),
  ),
  4: sheet(
    4,
    effect({
      kind: 'activation',
      speed: 2,
      when: when({ event: 'attack_declared', filter: filter({ side: 'opponent' }) }),
      script: script({ options: [{ label: '', cost: [], steps: [{ do: 'destroy', cards: { from: 'all', filter: filter({ side: 'opponent', position: 'attack' }) } }] }] }),
    }),
  ),
  5: sheet(
    5,
    effect({
      kind: 'trigger',
      mandatory: true,
      when: when({ event: 'battle_damage', self: true }),
      script: script({ options: [{ label: '', cost: [], steps: [{ do: 'modify_stats', cards: { from: 'self' }, atk: 200, def: 0, levelDelta: 0, levelSet: null, until: 'while_on_field' }] }] }),
    }),
  ),
  6: sheet(
    6,
    effect({
      kind: 'trigger',
      mandatory: true,
      when: when({ event: 'summoned', self: true }),
      script: script({
        targets: { filter: filter({ side: 'opponent', faceUp: true }), min: 1, max: 1, others: true, event: false },
        options: [
          {
            label: '',
            cost: [],
            steps: [
              {
                do: 'set_stats',
                cards: { from: 'self' },
                atk: { of: 'targets', stat: 'atk', original: true, times: 1 },
                def: { of: 'targets', stat: 'def', original: true, times: 1 },
                until: 'while_on_field',
              },
            ],
          },
        ],
      }),
    }),
  ),
  7: sheet(
    7,
    effect({
      kind: 'ignition',
      opt: 'soft',
      script: script({
        conditions: [
          { if: 'phase', phases: ['battle'] },
          { if: 'summoned_this_turn', how: ['normal'] },
        ],
        options: [
          {
            label: '',
            cost: [],
            steps: [{ do: 'set_stats', cards: { from: 'self' }, atk: { of: 'self', stat: 'atk', original: true, times: 2 }, def: null, until: 'end_of_battle_phase' }],
          },
        ],
      }),
    }),
  ),
  8: sheet(8, effect({ kind: 'trigger', from: 'graveyard', when: when({ event: 'destroyed_by_battle', self: true, canMiss: true, by: null }) })),
  9: sheet(9, effect({ kind: 'activation', speed: 2 })),
  10: sheet(10, effect({ kind: 'activation', speed: 1 })),
  12: sheet(12, effect({ kind: 'trigger', when: when({ event: 'summoned', self: true, canMiss: true, by: null }) })),
  20: sheet(20, effect({ kind: 'continuous', continuous: { apply: 'banish_instead', filter: filter({ side: 'opponent', place: 'field', kinds: ['spell', 'trap'] }) } })),
  21: sheet(21, effect({ kind: 'trigger', mandatory: true, when: when({ event: 'damage_step_end', self: true }) })),
  22: sheet(22, effect({ kind: 'continuous', opt: 'soft', continuous: { apply: 'extra_normal_summon', filter: filter({ side: 'you', place: 'hand', named: 'Ice' }), while: [] } })),
  24: sheet(24, effect({ kind: 'continuous', continuous: { apply: 'discard_or_negate', while: [] } })),
  25: sheet(25, effect({ kind: 'continuous', continuous: { apply: 'negate_battled_flips', while: [] } })),
  26: sheet(
    26,
    effect({ kind: 'continuous', continuous: { apply: 'restrict', to: filter({ side: 'opponent' }), others: false, cannot: ['activate_effects'], by: null, compare: null, once: false, while: [] } }),
  ),
  13: sheet(
    13,
    effect({
      kind: 'flip',
      mandatory: true,
      script: script({ targets: { filter: filter({}), min: 1, max: 1, others: false, event: false }, options: [{ label: '', cost: [], steps: [{ do: 'destroy', cards: { from: 'targets' } }] }] }),
    }),
  ),
};

/** Seat 0 goes first with `deck0` (top first, IDs a0, a1, ...), seat 1 with `deck1` (b0, b1, ...). */
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
        { name: 'Yusei', deck: ids('a', 0, deck0), extra: [] },
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

const pad = (codes: number[]) => [...codes, ...Array<number>(40 - codes.length).fill(2)];

/** Plays a duel the way the server does: after each move, code-only steps run and players with nothing to activate pass. */
class Table {
  events: DuelEvent[];
  state: DuelState;
  constructor(events: DuelEvent[]) {
    this.events = [];
    this.state = replay(events.slice(0, 1));
    this.events.push(events[0]!);
    this.push(...events.slice(1));
  }
  play(seat: Seat, intent: Intent) {
    const d = decide(this.state, seat, intent);
    if (!d.ok) throw new Error(d.error);
    return this.push(...d.events);
  }
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
  /** Resolves the chain's last link with these events standing in for its effect. */
  resolve(...events: DuelEvent[]) {
    expect(nextStep(this.state)?.kind).toBe('resolve');
    return this.push(...events, { type: 'linkResolved' });
  }
  /** Puts the next mandatory trigger on the chain, as the server does. */
  trigger() {
    const next = nextStep(this.state);
    if (next?.kind !== 'trigger') throw new Error(`Expected a mandatory trigger, got ${next?.kind}`);
    return this.push({ type: 'effectActivated', player: next.trigger.player, card: next.trigger.card, effect: next.trigger.effect, zone: null, cause: next.trigger.cause });
  }
  /** Ends seat 0's first turn and seat 1's second, so seat 0 can attack on turn 3 with what each has Set. */
  endTurn(seat: Seat) {
    return this.play(seat, { type: 'endTurn', discard: [] });
  }
  activations(seat: Seat) {
    return legalActions(this.state, seat).flatMap((a) => (a.type === 'activate' ? [a.card] : []));
  }
}

describe('responding to a summon', () => {
  // Seat 1 Sets Trap Hole on turn 2; on turn 3 seat 0 summons into it.
  const setup = (summon: number) => {
    const t = new Table(stacked(pad([2, 2, 2, 2, 2, summon]), pad([3, 2, 2, 2, 2, 2])));
    t.endTurn(0);
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 }).endTurn(1);
    return t.play(0, { type: 'normalSummon', card: 'a5', tributes: [], zone: 0 });
  };

  it('opens a window for the opponent, who may activate Trap Hole targeting the summoned monster', () => {
    const t = setup(1);
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 1, cause: { event: 'summoned', card: 'a5', how: 'normal' } });
    expect(viewFor(t.state, 0).waiting).toEqual({ player: 1, for: 'respond', cause: 'the Normal Summon of Axe Raider' });
    // Only the responder acts; the summoner waits.
    expect(legalActions(t.state, 0)).toEqual([{ type: 'surrender' }]);
    expect(t.activations(1)).toEqual(['b0']);
    t.play(1, { type: 'activate', card: 'b0', effect: 0, zone: null });
    expect(t.state.chain).toMatchObject([{ card: 'b0', cause: { card: 'a5' } }]);
    // Seat 0 holds nothing and seat 1 has used its card: both pass and the chain resolves.
    t.resolve({ type: 'targeted', cards: ['a5'] }, { type: 'destroyed', cards: ['a5'], by: 1 });
    expect(t.state.step).toEqual({ at: 'open' });
    expect(t.state.players[1].graveyard).toEqual(['b0']);
  });

  it("isn't offered for a monster its condition doesn't cover, and the duel moves on by itself", () => {
    const t = setup(2);
    expect(t.state.step).toEqual({ at: 'open' });
    const summon = t.events.findIndex((e) => e.type === 'normalSummoned');
    expect(t.events.slice(summon).filter((e) => e.type === 'passed').map((e) => (e as { player: Seat }).player)).toEqual([0, 1]);
  });

  it("isn't offered in the open game", () => {
    const t = setup(2);
    expect(t.activations(1)).toEqual([]);
    expect(decide(t.state, 1, { type: 'activate', card: 'b0', effect: 0, zone: null })).toMatchObject({ ok: false });
  });
});

describe("why can't I?", () => {
  const reasons = (t: Table, seat: Seat, card: string) => viewFor(t.state, seat).blocked.filter((b) => b.card === card).map((b) => b.reason);

  it("says why a Set Trap can't be activated, and stops saying it once the Trap is offered", () => {
    const t = new Table(stacked(pad([2, 2, 2, 2, 2, 1]), pad([3, 2, 2, 2, 2, 2])));
    t.endTurn(0);
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 });
    expect(reasons(t, 1, 'b0')).toEqual(["A Trap can't be activated the turn it was Set."]);
    t.endTurn(1);
    expect(reasons(t, 1, 'b0')).toEqual(["On your opponent's turn you can only respond when a response window gives you priority."]);
    t.play(0, { type: 'normalSummon', card: 'a5', tributes: [], zone: 0 });
    expect(t.activations(1)).toEqual(['b0']);
    expect(reasons(t, 1, 'b0')).toEqual([]);
    // The opponent's view never carries the Set card's reasons.
    expect(viewFor(t.state, 0).blocked.some((b) => b.card === 'b0')).toBe(false);
  });

  it('names the moment a Trap waits for when the window is the wrong one', () => {
    const t = new Table(stacked(pad([2, 2, 2, 2, 2, 2]), pad([3, 2, 2, 2, 2, 2])));
    t.endTurn(0);
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 }).endTurn(1);
    t.play(0, { type: 'normalSummon', card: 'a5', tributes: [], zone: 0 });
    // Weak Knight has 900 ATK, so Trap Hole's window never opens for seat 1 (it passes by itself); in seat 0's open game it is the timing.
    expect(t.state.step).toEqual({ at: 'open' });
    expect(reasons(t, 1, 'b0')[0]).toMatch(/your opponent's turn/);
  });

  it("gives a scripted effect's own reason, and once per turn", () => {
    const t = new Table(stacked(pad([7, 2, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(reasons(t, 0, 'a0')).toEqual(['It can only be activated during the Battle Phase.']);
  });

  it("says why a monster can't attack", () => {
    const t = new Table(stacked(pad([1, 11, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'setMonster', card: 'a1', tributes: [], zone: 1 }).endTurn(0).endTurn(1);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'enterBattle' });
    expect(blockedAttacks(t.state, 0)).toEqual([{ card: 'a1', effect: null, text: null, reason: "A face-down monster can't attack." }]);
    t.play(0, { type: 'attack', attacker: 'a0', target: 'direct' });
    expect(blockedAttacks(t.state, 0).find((b) => b.card === 'a0')?.reason).toBe('It already attacked this turn.');
  });

  it('never lists an effect that is offered', () => {
    const t = new Table(stacked(pad([9, 10, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    const actions = legalActions(t.state, 0);
    const offered = actions.flatMap((a) => (a.type === 'activate' ? [a.card] : []));
    expect(offered.sort()).toEqual(['a0', 'a1']);
    expect(blockedEffects(t.state, 0, actions)).toEqual([]);
  });
});

describe('responding to an attack', () => {
  const setup = (defender: number[]) => {
    const t = new Table(stacked(pad([1, 2, 2, 2, 2, 2]), pad([4, ...defender, 2, 2, 2, 2].slice(0, 6))));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 });
    if (defender.length) t.play(1, { type: 'normalSummon', card: 'b1', tributes: [], zone: 0 });
    t.endTurn(1).play(0, { type: 'enterBattle' });
    return t;
  };

  it('lets Mirror Force destroy the attacker, which then deals no damage', () => {
    const t = setup([]);
    t.play(0, { type: 'attack', attacker: 'a0', target: 'direct' });
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 1, cause: { event: 'attack_declared', card: 'a0' } });
    t.play(1, { type: 'activate', card: 'b0', effect: 0, zone: null });
    t.resolve({ type: 'destroyed', cards: ['a0'], by: 1 });
    expect(t.state.players[1].lp).toBe(8000);
    expect(t.state.attack).toBeNull();
    expect(t.state.step).toEqual({ at: 'open' });
  });

  it('deals damage once both players pass', () => {
    const t = setup([]);
    t.play(0, { type: 'attack', attacker: 'a0', target: 'direct' }).play(1, { type: 'pass' });
    expect(t.state.players[1].lp).toBe(8000 - 1700);
    expect(t.state.step).toEqual({ at: 'open' });
  });

  it('replays an attack whose target left the field: the attacker may attack again', () => {
    const t = setup([2]);
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 });
    // Mirror Force destroys only Attack Position monsters of the attacker's side; here the effect removes the target instead.
    t.play(1, { type: 'activate', card: 'b0', effect: 0, zone: null });
    t.resolve({ type: 'destroyed', cards: ['b1'], by: 1 });
    expect(t.state.players[1].lp).toBe(8000);
    expect(legalActions(t.state, 0)).toContainEqual({ type: 'attack', attacker: 'a0', targets: [], direct: true });
  });
});

describe('chains', () => {
  it('lets only Spell Speed 2 or faster respond, and asks the activating player before resolving', () => {
    // Seat 1 Sets Twister on turn 2; seat 0 Sets one too, so on turn 3 each can answer the other's.
    const t = new Table(stacked(pad([10, 9, 2, 2, 2, 2]), pad([9, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'setSpellTrap', card: 'a1', zone: 0 }).endTurn(0);
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 }).endTurn(1);
    // Seat 0's Set Twister could answer seat 1's End Phase, so seat 0 is asked.
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 0, cause: { event: 'phase', phase: 'end' } });
    t.play(0, { type: 'pass' });
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: 1 });
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 1 });
    t.play(1, { type: 'activate', card: 'b0', effect: 0, zone: null });
    // Seat 0 may chain its own Twister; its Normal Spell couldn't have.
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 0 });
    expect(t.activations(0)).toEqual(['a1']);
    t.play(0, { type: 'activate', card: 'a1', effect: 0, zone: null });
    expect(t.state.chain.map((l) => l.card)).toEqual(['a0', 'b0', 'a1']);
    // Nobody holds anything else: the chain resolves last link first.
    t.resolve().resolve().resolve();
    expect(t.state.chain).toEqual([]);
    expect(t.state.step).toEqual({ at: 'open' });
  });

  it("gives the opponent a window at the start of the Battle Phase and the End Phase, then ends the turn", () => {
    const t = new Table(stacked(pad([2, 2, 2, 2, 2, 2]), pad([9, 2, 2, 2, 2, 2])));
    t.endTurn(0);
    t.play(1, { type: 'setSpellTrap', card: 'b0', zone: 0 }).endTurn(1);
    t.play(0, { type: 'enterBattle' });
    expect(t.state.step).toMatchObject({ at: 'respond', priority: 1, cause: { event: 'phase', phase: 'battle' } });
    t.play(1, { type: 'pass' });
    expect(t.state.step).toEqual({ at: 'open' });
    t.endTurn(0);
    expect(t.state).toMatchObject({ phase: 'end', turn: 3, step: { at: 'respond', priority: 1 } });
    t.play(1, { type: 'pass' });
    expect(t.state).toMatchObject({ turn: 4, turnPlayer: 1, phase: 'main1' });
  });
});

describe('triggers', () => {
  it('fires a mandatory trigger after battle damage, and its stat change lasts', () => {
    const t = new Table(stacked(pad([5, 2, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0).endTurn(1);
    t.play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'a0', target: 'direct' });
    expect(t.state.players[1].lp).toBe(8000 - 1400);
    expect(t.state.step.at).toBe('triggers');
    t.trigger();
    expect(t.state.chain).toMatchObject([{ card: 'a0', cause: { event: 'battle_damage', card: 'a0' } }]);
    t.resolve({ type: 'statsModified', modifier: { card: 'a0', player: 0, atk: 200, def: 0, atkSet: null, defSet: null, levelDelta: 0, levelSet: null, until: 'while_on_field', turn: 3 } });
    expect(statsOf(t.state, 'a0').atk).toBe(1600);
    expect(t.state.step).toEqual({ at: 'open' });
  });

  it("fires on a summon with a target, and a monster's stats can become another's", () => {
    const t = new Table(stacked(pad([1, 2, 2, 2, 2, 2]), pad([6, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 });
    expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'b0', mandatory: true } });
    t.trigger();
    t.resolve(
      { type: 'targeted', cards: ['a0'] },
      { type: 'statsModified', modifier: { card: 'b0', player: 1, atk: 0, def: 0, atkSet: 1700, defSet: 1150, levelDelta: 0, levelSet: null, until: 'while_on_field', turn: 2 } },
    );
    expect(statsOf(t.state, 'b0')).toMatchObject({ atk: 1700, def: 1150 });
  });

  it("doesn't fire a mandatory trigger that has nothing to target", () => {
    const t = new Table(stacked(pad([6, 2, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(t.state.step).toEqual({ at: 'open' });
    expect(t.state.chain).toEqual([]);
  });

  it('offers an optional trigger to its controller, who may decline it', () => {
    const t = new Table(stacked(pad([1, 2, 2, 2, 2, 2]), pad([8, 2, 2, 2, 2, 2])));
    t.endTurn(0);
    t.play(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 }).endTurn(1);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'enterBattle' });
    t.play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[1].graveyard).toEqual(['b0']);
    expect(legalActions(t.state, 1)).toEqual([
      { type: 'activate', card: 'b0', effect: 0, zones: null, text: 'trigger effect' },
      { type: 'pass' },
      { type: 'surrender' },
    ]);
    // Seat 0 sees only that the duel waits on seat 1.
    expect(viewFor(t.state, 0).waiting).toEqual({ player: 1, for: 'respond', cause: null });
    expect(viewFor(t.state, 1).waiting).toEqual({ player: 1, for: 'triggers', cause: null });
    t.play(1, { type: 'pass' });
    expect(t.state.step).toEqual({ at: 'open' });
  });

  it('lets a "When ... you can" trigger miss the timing unless its event was the last thing to happen', () => {
    // Seat 0 activates Pot, then chains its Set Twister. One link Special Summons Trident Warrior from the hand.
    const play = (summonIn: 'first' | 'last') => {
      const t = new Table(stacked(pad([9, 10, 12, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
      t.play(0, { type: 'setSpellTrap', card: 'a0', zone: 0 }).endTurn(0).endTurn(1).play(0, { type: 'pass' });
      t.play(0, { type: 'activate', card: 'a1', effect: 0, zone: 1 }).play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
      const summon: DuelEvent = { type: 'specialSummoned', player: 0, card: 'a2', zone: 0, position: 'attack' };
      // The last link resolves first.
      if (summonIn === 'first') t.resolve(summon).resolve();
      else t.resolve().resolve(summon);
      return t;
    };
    expect(play('first').state.step).toEqual({ at: 'open' });
    expect(legalActions(play('last').state, 0)).toContainEqual({ type: 'activate', card: 'a2', effect: 0, zones: null, text: 'trigger effect' });
  });
});

describe('FLIP effects', () => {
  it('fire when the monster is Flip Summoned', () => {
    const t = new Table(stacked(pad([13, 2, 2, 2, 2, 2]), pad([1, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'setMonster', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 }).endTurn(1);
    t.play(0, { type: 'flipSummon', card: 'a0' });
    expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'a0', mandatory: true, cause: { event: 'flipped', card: 'a0' } } });
  });

  it('may target the monster itself when nothing else is on the field', () => {
    const t = new Table(stacked(pad([13, 2, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'setMonster', card: 'a0', tributes: [], zone: 0 }).endTurn(0).endTurn(1);
    t.play(0, { type: 'flipSummon', card: 'a0' });
    expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'a0' } });
  });

  it('fire after the battle that flipped the monster, even once it was destroyed', () => {
    const t = new Table(stacked(pad([1, 2, 2, 2, 2, 2]), pad([13, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'setMonster', card: 'b0', tributes: [], zone: 0 }).endTurn(1);
    t.play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[1].graveyard).toContain('b0');
    expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'b0', player: 1, cause: { event: 'flipped', card: 'b0' } } });
    t.trigger();
    t.resolve({ type: 'targeted', cards: ['a0'] }, { type: 'destroyed', cards: ['a0'], by: 1 });
    expect(t.state.players[0].graveyard).toContain('a0');
  });
});

describe('continuous effects', () => {
  it("banish the opponent's Spells and Traps leaving the field instead of sending them to the GY (General Wayne)", () => {
    const t = new Table(stacked(pad([20, 2, 2, 2, 2, 2]), pad([10, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'activate', card: 'b0', effect: 0, zone: 0 }).resolve();
    expect(t.state.players[1].banished).toContain('b0');
    expect(t.state.players[1].graveyard).not.toContain('b0');
  });

  it('let a monster Normal Summon one more fitting monster, once a turn, but not Set it (General Grunard)', () => {
    const t = new Table(stacked(pad([22, 23, 23, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    const summons = (type: string) => legalActions(t.state, 0).filter((a) => a.type === type && 'card' in a).map((a) => (a as { card: string }).card);
    expect(summons('normalSummon')).toEqual(['a1', 'a2']);
    expect(summons('setMonster')).toEqual([]);
    t.play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 1 });
    expect(summons('normalSummon')).toEqual([]);
  });

  it('make the opponent discard or have a monster effect negated as it resolves (General Raiho)', () => {
    const t = new Table(stacked(pad([12, 2, 2, 2, 2, 2]), pad([24, 2, 2, 2, 2, 2])));
    t.endTurn(0);
    t.play(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 }).endTurn(1);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    expect(t.state.step).toMatchObject({ at: 'tax', player: 0, by: 'b0' });
    expect(nextStep(t.state)).toMatchObject({ kind: 'wait', player: 0 });
    const declined = new Table(t.events);
    t.play(0, { type: 'tax', discard: 'a1' });
    expect(t.state.players[0].graveyard).toContain('a1');
    expect(nextStep(t.state)?.kind).toBe('resolve');
    declined.play(0, { type: 'tax', discard: null });
    expect(declined.state.chain).toEqual([]);
    expect(declined.state.step).toEqual({ at: 'open' });
  });

  it('negate the FLIP effect of a monster destroyed by battle with this card (Blade Knight)', () => {
    const t = new Table(stacked(pad([25, 2, 2, 2, 2, 2]), pad([13, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'setMonster', card: 'b0', tributes: [], zone: 0 }).endTurn(1);
    t.play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(t.state.players[1].graveyard).toContain('b0');
    expect(t.state.chain).toEqual([]);
    expect(t.state.step).toEqual({ at: 'open' });
  });

  it('stop monsters activating their effects', () => {
    const t = new Table(stacked(pad([26, 2, 2, 2, 2, 2]), pad([12, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'normalSummon', card: 'b0', tributes: [], zone: 0 });
    expect(t.state.step).toEqual({ at: 'open' });
    expect(t.activations(1)).toEqual([]);
  });
});

describe('targets', () => {
  it('can number the non-Tuners used for the Synchro Summon (Junk Destroyer)', () => {
    const t = new Table(stacked(pad([27, 2, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a1', tributes: [], zone: 0 });
    // As if a1 were Synchro Summoned with the Tuner a0 and two non-Tuners.
    const state = structuredClone(t.state);
    state.players[0].monsters[0]!.summoned = { how: 'synchro', turn: 1, materials: ['a0', 'a2', 'a3'] };
    const destroyUpTo = script({ targets: { filter: filter({}), min: 1, max: 'non_tuner_materials', others: false, event: false } });
    expect(targetMax(state, destroyUpTo, 'a1')).toBe(2);
  });
});

describe('the end of the Damage Step', () => {
  it('fires a trigger of a monster that attacked (Chainsaw Insect)', () => {
    const t = new Table(stacked(pad([21, 2, 2, 2, 2, 2]), pad([11, 2, 2, 2, 2, 2])));
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 }).endTurn(0);
    t.play(1, { type: 'setMonster', card: 'b0', tributes: [], zone: 0 }).endTurn(1);
    t.play(0, { type: 'enterBattle' }).play(0, { type: 'attack', attacker: 'a0', target: 0 });
    expect(nextStep(t.state)).toMatchObject({ kind: 'trigger', trigger: { card: 'a0', cause: { event: 'damage_step_end', card: 'a0', target: 'b0' } } });
  });
});

describe('Speed Warrior', () => {
  it('doubles its original ATK in the Battle Phase of the turn it was Normal Summoned, and only then', () => {
    const t = new Table(stacked(pad([7, 2, 2, 2, 2, 2]), pad([2, 2, 2, 2, 2, 2])));
    t.endTurn(0).endTurn(1);
    t.play(0, { type: 'normalSummon', card: 'a0', tributes: [], zone: 0 });
    expect(t.activations(0)).toEqual([]);
    t.play(0, { type: 'enterBattle' });
    expect(t.activations(0)).toEqual(['a0']);
    t.play(0, { type: 'activate', card: 'a0', effect: 0, zone: null });
    t.resolve({ type: 'statsModified', modifier: { card: 'a0', player: 0, atk: 0, def: 0, atkSet: 1800, defSet: null, levelDelta: 0, levelSet: null, until: 'end_of_battle_phase', turn: 3 } });
    expect(statsOf(t.state, 'a0').atk).toBe(1800);
    // Once per Battle Phase.
    expect(t.activations(0)).toEqual([]);
    t.play(0, { type: 'enterMain2' });
    expect(statsOf(t.state, 'a0').atk).toBe(900);
  });
});
