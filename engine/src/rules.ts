// The game rules as code: what a player may do now, and the events an intent produces.

import { evolve, locate, other, replay, statsOf } from './state.ts';
import {
  HAND_LIMIT,
  MONSTER_ZONES,
  OPENING_HAND,
  SPELL_TRAP_ZONES,
  type CardData,
  type DuelEvent,
  type EffectSheet,
  type DuelState,
  type FieldCard,
  type Intent,
  type LegalAction,
  type Seat,
} from './types.ts';

export type Decision = { ok: true; events: DuelEvent[] } | { ok: false; error: string };

/** Collects events, folding each into the state so later checks see the board as it now is. */
export class Run {
  events: DuelEvent[] = [];
  state: DuelState;
  constructor(state: DuelState) {
    this.state = state;
  }
  emit(event: DuelEvent) {
    this.events.push(event);
    this.state = evolve(this.state, event);
  }
}

export class Illegal extends Error {}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Illegal(message);
}

export const cardOf = (state: DuelState, id: string): CardData => state.cards[state.instances[id]!.code]!;

export function tributesFor(card: CardData): number {
  const level = card.level ?? 0;
  return level >= 7 ? 2 : level >= 5 ? 1 : 0;
}

const isMainPhase = (state: DuelState) => state.phase === 'main1' || state.phase === 'main2';
const ownMonsters = (state: DuelState, seat: Seat) =>
  state.players[seat].monsters.filter((c): c is FieldCard => c !== null);
const freeZone = (zones: (FieldCard | null)[]) => zones.indexOf(null);
const isZone = (i: number, count: number) => Number.isInteger(i) && i >= 0 && i < count;
const freeZones = (zones: (FieldCard | null)[]) => zones.flatMap((z, i) => (z ? [] : [i]));

// ---------------------------------------------------------------------------
// Starting a duel

export interface DuelSetup {
  players: [{ name: string; main: number[]; extra: number[] }, { name: string; main: number[]; extra: number[] }];
  cards: Record<number, CardData>;
  sheets: Record<number, EffectSheet>;
}

/** Shuffles, picks who goes first and deals opening hands. `random` returns [0, 1), like Math.random. */
export function startDuel(setup: DuelSetup, random: () => number): DuelEvent[] {
  const instances: Record<string, { code: number; owner: Seat }> = {};
  const used = new Set<string>();
  const newId = () => {
    let id: string;
    do id = Math.floor(random() * 36 ** 8).toString(36).padStart(8, '0');
    while (used.has(id));
    used.add(id);
    return id;
  };
  const players = setup.players.map((p, seat) => {
    const make = (code: number) => {
      if (!setup.cards[code]) throw new Error(`No card data for ${code}`);
      const id = newId();
      instances[id] = { code, owner: seat as Seat };
      return id;
    };
    return { name: p.name, deck: shuffle(p.main.map(make), random), extra: p.extra.map(make) };
  }) as [{ name: string; deck: string[]; extra: string[] }, { name: string; deck: string[]; extra: string[] }];

  const first: Seat = random() < 0.5 ? 0 : 1;
  const start: DuelEvent = { type: 'duelStarted', cards: setup.cards, sheets: setup.sheets, instances, players, first };
  const run = new Run(replay([start]));
  run.events.push(start);
  run.emit({ type: 'drew', player: first, count: OPENING_HAND });
  run.emit({ type: 'drew', player: other(first), count: OPENING_HAND });
  beginTurn(run, first, 1);
  return run.events;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function beginTurn(run: Run, player: Seat, turn: number) {
  run.emit({ type: 'turnStarted', player, turn });
  run.emit({ type: 'phaseChanged', phase: 'draw' });
  // The player who goes first skips their first draw.
  if (turn > 1) {
    if (run.state.players[player].deck.length === 0) {
      run.emit({ type: 'duelEnded', result: { winner: other(player), reason: 'deckOut' } });
      return;
    }
    run.emit({ type: 'drew', player, count: 1 });
  }
  run.emit({ type: 'phaseChanged', phase: 'standby' });
  run.emit({ type: 'phaseChanged', phase: 'main1' });
}

// ---------------------------------------------------------------------------
// Legal actions

export const normalSummonUsed = (state: DuelState) => state.normalSummons >= state.normalSummonLimit;

export function legalActions(state: DuelState, seat: Seat): LegalAction[] {
  if (state.result) return [];
  const actions: LegalAction[] = [];
  // While an effect waits to resolve, nobody acts (responses arrive in layer 4).
  if (state.chain.length > 0) return [{ type: 'surrender' }];
  if (state.turnPlayer === seat) {
    const p = state.players[seat];
    actions.push(...activations(state, seat));
    if (isMainPhase(state)) {
      const monsters = ownMonsters(state, seat);
      for (const id of p.hand) {
        const card = cardOf(state, id);
        if (card.kind === 'monster') {
          const tributes = tributesFor(card);
          const fits = tributes > 0 ? monsters.length >= tributes : freeZone(p.monsters) >= 0;
          if (!normalSummonUsed(state) && !card.extraDeck && fits) {
            const tributeFrom = tributes > 0 ? monsters.map((m) => m.id) : [];
            // A tribute leaves its zone free for the monster it makes way for.
            const zones = tributes > 0 ? p.monsters.flatMap((z, i) => (z === null || tributeFrom.includes(z.id) ? [i] : [])) : freeZones(p.monsters);
            actions.push({ type: 'normalSummon', card: id, tributes, tributeFrom, zones });
            actions.push({ type: 'setMonster', card: id, tributes, tributeFrom, zones });
          }
        } else if (freeZone(p.spellTraps) >= 0) {
          actions.push({ type: 'setSpellTrap', card: id, zones: freeZones(p.spellTraps) });
        }
      }
      for (const m of monsters) {
        if (canFlipSummon(state, m)) actions.push({ type: 'flipSummon', card: m.id });
        else if (canChangePosition(state, m)) actions.push({ type: 'changePosition', card: m.id });
      }
    }
    if (state.phase === 'main1' && state.turn > 1) actions.push({ type: 'enterBattle' });
    if (state.phase === 'battle') {
      const targets = state.players[other(seat)].monsters.flatMap((m, i) => (m ? [i] : []));
      for (const m of ownMonsters(state, seat)) {
        if (canAttack(state, m)) actions.push({ type: 'attack', attacker: m.id, targets, direct: targets.length === 0 });
      }
      actions.push({ type: 'enterMain2' });
    }
    actions.push({ type: 'endTurn', discard: Math.max(0, p.hand.length - HAND_LIMIT) });
  }
  actions.push({ type: 'surrender' });
  return actions;
}

// ---------------------------------------------------------------------------
// Activating effects. Code checks only what is the same for every card: whose turn, which phase, where the card
// is, a free zone, once-per-turn use. Whether the card's own conditions hold is the judge's call.

/** Spell/Trap properties that work in layer 2. Continuous, Equip and Field cards need lingering effects (layer 5). */
const ACTIVATABLE_SPELLS = ['Normal', 'Quick-Play'];
const ACTIVATABLE_TRAPS = ['Normal'];

/** The effects of one card the player may try to activate now. */
function activatableEffects(state: DuelState, seat: Seat, id: string): Extract<LegalAction, { type: 'activate' }>[] {
  const at = locate(state, id);
  if (!at || at.seat !== seat || state.instances[id]!.owner !== seat) return [];
  const card = cardOf(state, id);
  const sheet = state.sheets[card.code];
  if (!sheet) return [];
  const main = isMainPhase(state);
  const openPhase = main || state.phase === 'battle';
  const p = state.players[seat];
  // A Spell/Trap with a continuous effect stays on the field doing something (Swords of Revealing Light); that needs
  // lingering effects, which arrive in layer 5.
  const lingers = card.kind !== 'monster' && sheet.effects.some((e) => e.kind === 'continuous');
  const result: Extract<LegalAction, { type: 'activate' }>[] = [];
  sheet.effects.forEach((effect, index) => {
    if (!onceOk(state, id, card.code, index, effect.opt)) return;
    if (ruledIllegal(state, seat, id, index)) return;
    const text = effect.effect;
    if (lingers) return;
    if (card.kind === 'spell' && effect.kind === 'activation' && ACTIVATABLE_SPELLS.includes(card.race)) {
      const quick = card.race === 'Quick-Play';
      if (!(quick ? openPhase : main)) return;
      if (at.zone === 'hand' && freeZones(p.spellTraps).length > 0) {
        result.push({ type: 'activate', card: id, effect: index, zones: freeZones(p.spellTraps), text });
      }
      const set = at.zone === 'spellTraps' ? p.spellTraps[at.index]! : null;
      // A Quick-Play Spell can't be activated the turn it was Set.
      if (set && !set.faceUp && !(quick && set.placedTurn === state.turn)) {
        result.push({ type: 'activate', card: id, effect: index, zones: null, text });
      }
    } else if (card.kind === 'trap' && effect.kind === 'activation' && ACTIVATABLE_TRAPS.includes(card.race)) {
      const set = at.zone === 'spellTraps' ? p.spellTraps[at.index]! : null;
      if (openPhase && set && !set.faceUp && set.placedTurn !== state.turn) {
        result.push({ type: 'activate', card: id, effect: index, zones: null, text });
      }
    } else if (card.kind === 'monster' && (effect.kind === 'ignition' || effect.kind === 'quick')) {
      const m = at.zone === 'monsters' ? p.monsters[at.index]! : null;
      if (m?.faceUp && (effect.kind === 'ignition' ? main : openPhase)) {
        result.push({ type: 'activate', card: id, effect: index, zones: null, text });
      }
    }
  });
  return result;
}

const ruledIllegal = (state: DuelState, seat: Seat, id: string, effect: number) =>
  state.ruledIllegal.find((r) => r.player === seat && r.card === id && r.effect === effect);

function onceOk(state: DuelState, id: string, code: number, effect: number, opt: 'none' | 'soft' | 'hard') {
  if (opt === 'soft') return !state.usedThisTurn.some((u) => u.card === id && u.effect === effect);
  if (opt === 'hard') return !state.usedThisTurn.some((u) => u.code === code && u.effect === effect);
  return true;
}

function activations(state: DuelState, seat: Seat): LegalAction[] {
  const p = state.players[seat];
  const ids = [...p.hand, ...p.monsters.flatMap((m) => (m ? [m.id] : [])), ...p.spellTraps.flatMap((c) => (c ? [c.id] : []))];
  return ids.flatMap((id) => activatableEffects(state, seat, id));
}

const notJustPlaced = (state: DuelState, m: FieldCard) => m.placedTurn !== state.turn;
const positionUnchanged = (state: DuelState, m: FieldCard) => m.positionChangedTurn !== state.turn;

function canFlipSummon(state: DuelState, m: FieldCard) {
  return !m.faceUp && notJustPlaced(state, m) && positionUnchanged(state, m);
}

function canChangePosition(state: DuelState, m: FieldCard) {
  return m.faceUp && notJustPlaced(state, m) && positionUnchanged(state, m) && m.attackedTurn !== state.turn;
}

function canAttack(state: DuelState, m: FieldCard) {
  return m.faceUp && m.position === 'attack' && m.attackedTurn !== state.turn;
}

// ---------------------------------------------------------------------------
// Deciding: an intent either becomes events or is refused with a reason

export function decide(state: DuelState, seat: Seat, intent: Intent): Decision {
  try {
    check(!state.result, 'The duel is over.');
    const run = new Run(state);
    run.emit({ type: 'intent', player: seat, intent });
    if (intent.type === 'surrender') {
      run.emit({ type: 'duelEnded', result: { winner: other(seat), reason: 'surrender' } });
      return { ok: true, events: run.events };
    }
    check(state.turnPlayer === seat, "It's not your turn.");
    check(state.chain.length === 0, 'Wait for the effect to resolve.');
    apply(run, seat, intent);
    return { ok: true, events: run.events };
  } catch (e) {
    if (e instanceof Illegal) return { ok: false, error: e.message };
    throw e;
  }
}

function apply(run: Run, seat: Seat, intent: Exclude<Intent, { type: 'surrender' }>) {
  const state = run.state;
  const p = state.players[seat];
  switch (intent.type) {
    case 'normalSummon':
    case 'setMonster': {
      check(isMainPhase(state), 'You can only summon in a Main Phase.');
      check(!normalSummonUsed(state), 'You already used your Normal Summons and Sets this turn.');
      check(p.hand.includes(intent.card), 'That card is not in your hand.');
      const card = cardOf(state, intent.card);
      check(card.kind === 'monster' && !card.extraDeck, 'Only Main Deck monsters can be Normal Summoned or Set.');
      const needed = tributesFor(card);
      const tributes = new Set(intent.tributes);
      check(tributes.size === intent.tributes.length, 'Each tribute must be a different monster.');
      check(tributes.size === needed, `${card.name} needs ${needed} tribute${needed === 1 ? '' : 's'}.`);
      for (const id of tributes) {
        const at = locate(state, id);
        check(at?.zone === 'monsters' && at.seat === seat, 'Tributes must be monsters you control.');
      }
      if (needed > 0) run.emit({ type: 'tributed', player: seat, cards: [...tributes] });
      check(isZone(intent.zone, MONSTER_ZONES), 'There is no Monster Zone there.');
      check(run.state.players[seat].monsters[intent.zone] === null, 'That Monster Zone is not empty.');
      run.emit({ type: intent.type === 'normalSummon' ? 'normalSummoned' : 'monsterSet', player: seat, card: intent.card, zone: intent.zone });
      return;
    }
    case 'setSpellTrap': {
      check(isMainPhase(state), 'You can only Set cards in a Main Phase.');
      check(p.hand.includes(intent.card), 'That card is not in your hand.');
      check(cardOf(state, intent.card).kind !== 'monster', 'Only Spells and Traps go in the Spell & Trap Zone.');
      check(isZone(intent.zone, SPELL_TRAP_ZONES), 'There is no Spell & Trap Zone there.');
      check(p.spellTraps[intent.zone] === null, 'That Spell & Trap Zone is not empty.');
      run.emit({ type: 'spellTrapSet', player: seat, card: intent.card, zone: intent.zone });
      return;
    }
    case 'flipSummon': {
      check(isMainPhase(state), 'You can only Flip Summon in a Main Phase.');
      const m = ownMonster(state, seat, intent.card);
      check(canFlipSummon(state, m), "That monster can't be Flip Summoned now.");
      run.emit({ type: 'flipSummoned', player: seat, card: m.id });
      return;
    }
    case 'changePosition': {
      check(isMainPhase(state), 'You can only change positions in a Main Phase.');
      const m = ownMonster(state, seat, intent.card);
      check(canChangePosition(state, m), "That monster's position can't be changed now.");
      run.emit({ type: 'positionChanged', player: seat, card: m.id, position: m.position === 'attack' ? 'defense' : 'attack' });
      return;
    }
    case 'activate': {
      const ruling = ruledIllegal(state, seat, intent.card, intent.effect);
      check(!ruling, `The judge already ruled this activation illegal, and nothing has changed since: ${ruling?.summary}`);
      const options = activatableEffects(state, seat, intent.card).filter((a) => a.effect === intent.effect);
      check(options.length > 0, "That effect can't be activated now.");
      const fromHand = options.find((a) => a.zones !== null);
      if (fromHand) {
        check(intent.zone !== null && fromHand.zones!.includes(intent.zone), 'Choose an empty Spell & Trap Zone.');
      }
      run.emit({ type: 'effectActivated', player: seat, card: intent.card, effect: intent.effect, zone: fromHand ? intent.zone : null });
      return;
    }
    case 'enterBattle':
      check(state.phase === 'main1', 'You can only enter the Battle Phase from Main Phase 1.');
      check(state.turn > 1, "The player who goes first can't conduct a Battle Phase on the first turn.");
      run.emit({ type: 'phaseChanged', phase: 'battle' });
      return;
    case 'enterMain2':
      check(state.phase === 'battle', 'Main Phase 2 comes after the Battle Phase.');
      run.emit({ type: 'phaseChanged', phase: 'main2' });
      return;
    case 'attack':
      attack(run, seat, intent.attacker, intent.target);
      return;
    case 'endTurn': {
      check(isMainPhase(state) || state.phase === 'battle', 'You can only end your turn from a Main or Battle Phase.');
      const excess = Math.max(0, p.hand.length - HAND_LIMIT);
      const discard = new Set(intent.discard);
      check(discard.size === intent.discard.length && discard.size === excess, `Discard exactly ${excess} card${excess === 1 ? '' : 's'}.`);
      for (const id of discard) check(p.hand.includes(id), 'You can only discard cards from your hand.');
      run.emit({ type: 'phaseChanged', phase: 'end' });
      if (excess > 0) run.emit({ type: 'discarded', player: seat, cards: [...discard] });
      beginTurn(run, other(seat), state.turn + 1);
      return;
    }
  }
}

function ownMonster(state: DuelState, seat: Seat, id: string): FieldCard {
  const at = locate(state, id);
  check(at?.zone === 'monsters' && at.seat === seat, 'That is not a monster you control.');
  return state.players[seat].monsters[at.index]!;
}

function attack(run: Run, seat: Seat, attackerId: string, target: number | 'direct') {
  const state = run.state;
  check(state.phase === 'battle', 'You can only attack in the Battle Phase.');
  const attacker = ownMonster(state, seat, attackerId);
  check(canAttack(state, attacker), "That monster can't attack now.");
  const foe = other(seat);
  const foeMonsters = state.players[foe].monsters;
  const atk = statsOf(state, attacker.id).atk;

  if (target === 'direct') {
    check(foeMonsters.every((m) => m === null), "You can't attack directly while your opponent controls a monster.");
    run.emit({ type: 'attackDeclared', player: seat, attacker: attacker.id, target: null });
    run.emit({ type: 'battleDamage', player: foe, amount: atk });
    return endIfLpGone(run);
  }

  const defender = foeMonsters[target];
  check(defender, 'There is no monster in that zone.');
  run.emit({ type: 'attackDeclared', player: seat, attacker: attacker.id, target: defender.id });
  if (!defender.faceUp) run.emit({ type: 'flippedByAttack', card: defender.id });

  const stats = statsOf(state, defender.id);
  if (defender.position === 'attack') {
    const def = stats.atk;
    if (atk > def) {
      run.emit({ type: 'destroyedByBattle', cards: [defender.id] });
      run.emit({ type: 'battleDamage', player: foe, amount: atk - def });
    } else if (atk < def) {
      run.emit({ type: 'destroyedByBattle', cards: [attacker.id] });
      run.emit({ type: 'battleDamage', player: seat, amount: def - atk });
    } else if (atk > 0) {
      run.emit({ type: 'destroyedByBattle', cards: [attacker.id, defender.id] });
    }
  } else {
    const def = stats.def;
    if (atk > def) run.emit({ type: 'destroyedByBattle', cards: [defender.id] });
    else if (atk < def) run.emit({ type: 'battleDamage', player: seat, amount: def - atk });
  }
  endIfLpGone(run);
}

/** Ends the duel if a player's LP reached 0. */
export function endIfLpGone(run: Run) {
  const [a, b] = run.state.players;
  if (a.lp > 0 && b.lp > 0) return;
  const winner = a.lp === 0 && b.lp === 0 ? null : a.lp === 0 ? 1 : 0;
  run.emit({ type: 'duelEnded', result: { winner, reason: 'lp' } });
}
