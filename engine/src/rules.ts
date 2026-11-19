// The game rules as code: what a player may do now, and the events an intent produces.

import { pendingTriggers, triggerEvent, whenMatches } from './chain.ts';
import { scriptOf, scriptProblem } from './script.ts';
import { continuousOnField, levelNow, restricted, statsOf } from './continuous.ts';
import { evolve, locate, monsterZoneFree, monsterZonesFor, onField, other } from './state.ts';
import {
  HAND_LIMIT,
  HANDS,
  MONSTER_ZONES,
  OPENING_HAND,
  SPELL_TRAP_ZONES,
  type CardData,
  type DuelEvent,
  type EffectSheet,
  type DuelState,
  type Hand,
  type FieldCard,
  type Forbidden,
  type Happening,
  type Intent,
  type LegalAction,
  type Materials,
  type Seat,
  type Then,
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
const isZone = (i: number, count: number) => Number.isInteger(i) && i >= 0 && i < count;
const freeZones = (zones: (FieldCard | null)[]) => zones.flatMap((z, i) => (z ? [] : [i]));

// ---------------------------------------------------------------------------
// Starting a duel

export interface DuelSetup {
  players: [{ name: string; main: number[]; extra: number[] }, { name: string; main: number[]; extra: number[] }];
  cards: Record<number, CardData>;
  sheets: Record<number, EffectSheet>;
}

/**
 * Shuffles the Decks. The players then decide who goes first with rock-paper-scissors, and the opening hands are dealt
 * once the winner has chosen. `random` returns [0, 1), like Math.random.
 */
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

  return [{ type: 'duelStarted', cards: setup.cards, sheets: setup.sheets, instances, players }];
}

/** What each pick beats. */
const BEATS: Record<Hand, Hand> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/** A rock-paper-scissors pick, or the winner's choice of who goes first, which deals the opening hands. */
function decideStart(run: Run, seat: Seat, intent: Extract<Intent, { type: 'rps' | 'chooseOrder' }>) {
  const step = run.state.step;
  if (intent.type === 'rps') {
    check(step.at === 'rps', 'Rock-paper-scissors is over.');
    check(step.picks[seat] === null, 'You already picked.');
    check(HANDS.includes(intent.hand), 'Pick rock, paper or scissors.');
    const picks: [Hand | null, Hand | null] = [...step.picks];
    picks[seat] = intent.hand;
    run.emit({ type: 'rpsPicked', player: seat, hand: intent.hand });
    const [a, b] = picks;
    if (a && b) run.emit({ type: 'rpsShown', hands: [a, b], winner: a === b ? null : BEATS[a] === b ? 0 : 1 });
    return;
  }
  check(step.at === 'order' && step.chooser === seat, 'Only the winner of rock-paper-scissors chooses who goes first.');
  const first = intent.goFirst ? seat : other(seat);
  run.emit({ type: 'orderChosen', player: seat, first });
  run.emit({ type: 'drew', player: first, count: OPENING_HAND });
  run.emit({ type: 'drew', player: other(first), count: OPENING_HAND });
  beginTurn(run, first, 1);
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
  const step = state.step;
  if (step.at === 'rps') {
    if (step.picks[seat] === null) actions.push({ type: 'rps' });
  } else if (step.at === 'order') {
    if (step.chooser === seat) actions.push({ type: 'chooseOrder' });
  } else if (step.at === 'triggers') {
    // Optional triggers wait for their controller once every mandatory one is on the chain (see chain.ts).
    const pending = pendingTriggers(state);
    const first = pending[0];
    if (first && !first.mandatory && first.player === seat) {
      for (const t of pending) if (t.player === seat && !t.mandatory) actions.push(activateAction(state, t.card, t.effect, null));
      actions.push({ type: 'pass' });
    }
  } else if (step.at === 'respond') {
    if (step.priority === seat) actions.push(...usable(state, seat), { type: 'pass' });
  } else if (step.at === 'open' && state.turnPlayer === seat) {
    const p = state.players[seat];
    actions.push(...usable(state, seat));
    if (isMainPhase(state)) {
      const monsters = ownMonsters(state, seat);
      for (const id of p.hand) {
        const card = cardOf(state, id);
        if (card.kind === 'monster') {
          const tributes = tributesFor(card);
          const tributeFrom = tributes > 0 ? monsters.map((m) => m.id) : [];
          // A tribute leaves its zone free for the monster it makes way for; a Main Deck monster never goes to an Extra Monster Zone.
          const zones = [...Array(MONSTER_ZONES).keys()].filter((i) => monsterZoneFree(state, seat, i) || (tributes > 0 && tributeFrom.includes(p.monsters[i]?.id ?? '')));
          const fits = tributes > 0 ? monsters.length >= tributes && zones.length > 0 : zones.length > 0;
          if (!normalSummonUsed(state) && !card.extraDeck && fits) {
            actions.push({ type: 'normalSummon', card: id, tributes, tributeFrom, zones });
            actions.push({ type: 'setMonster', card: id, tributes, tributeFrom, zones });
          }
        } else if (freeZones(p.spellTraps).length > 0) {
          actions.push({ type: 'setSpellTrap', card: id, zones: freeZones(p.spellTraps) });
        }
      }
      for (const id of p.extra) {
        const action = extraSummonAction(state, seat, id);
        if (action) actions.push(action);
      }
      for (const m of monsters) {
        if (canFlipSummon(state, m)) actions.push({ type: 'flipSummon', card: m.id });
        else if (canChangePosition(state, m)) actions.push({ type: 'changePosition', card: m.id });
      }
    }
    if (state.phase === 'main1' && state.turn > 1 && !forbidden(state, seat, 'battle_phase')) actions.push({ type: 'enterBattle' });
    if (state.phase === 'battle') {
      const targets = attackTargets(state, seat);
      const direct = state.players[other(seat)].monsters.every((m) => m === null);
      for (const m of ownMonsters(state, seat)) {
        if (canAttack(state, m) && (direct || targets.length > 0)) actions.push({ type: 'attack', attacker: m.id, targets, direct });
      }
      actions.push({ type: 'enterMain2' });
    }
    actions.push({ type: 'endTurn', discard: Math.max(0, p.hand.length - HAND_LIMIT) });
  }
  actions.push({ type: 'surrender' });
  return actions;
}

// ---------------------------------------------------------------------------
// Summoning from the Extra Deck. Synchro and Xyz Summons are generic rules, so code checks them from the materials on
// the monster's sheet, with no judge.

type ExtraSummon = Extract<LegalAction, { type: 'extraSummon' }>;

/** A Synchro or Xyz Summon of `id` the player can make now with the monsters they control, or null. */
function extraSummonAction(state: DuelState, seat: Seat, id: string): ExtraSummon | null {
  const card = cardOf(state, id);
  const materials = state.sheets[card.code]?.materials;
  if (!materials) return null;
  const sets = materials.summon === 'xyz' ? xyzMaterials(state, seat, materials) : card.level === null ? [] : synchroMaterials(state, seat, materials, card.level);
  const options = sets.flatMap((set) => {
    const zones = zonesAfterLeaving(state, seat, set);
    return zones.length > 0 ? [{ materials: set, zones }] : [];
  });
  return options.length > 0 ? { type: 'extraSummon', card: id, how: materials.summon, options } : null;
}

/** Every set of `count` face-up monsters the player controls whose current Level is the Xyz Monster's. */
function xyzMaterials(state: DuelState, seat: Seat, materials: Extract<Materials, { summon: 'xyz' }>): string[][] {
  const fitting = ownMonsters(state, seat).filter((m) => m.faceUp && levelNow(state, m.id) === materials.level).map((m) => m.id);
  const sets: string[][] = [];
  const pick = (from: number, chosen: string[]) => {
    if (chosen.length === materials.count) return void sets.push(chosen);
    for (let i = from; i < fitting.length; i++) pick(i + 1, [...chosen, fitting[i]!]);
  };
  pick(0, []);
  return sets;
}

/**
 * Every set of materials for a Synchro Monster of `level`: one face-up Tuner (the one named, if any) and enough face-up
 * non-Tuners, whose current Levels add up exactly. Each set lists the Tuner first, then the rest in field order.
 */
function synchroMaterials(state: DuelState, seat: Seat, materials: Extract<Materials, { summon: 'synchro' }>, level: number): string[][] {
  const faceUp = ownMonsters(state, seat).filter((m) => m.faceUp && levelNow(state, m.id) !== null);
  const isTuner = (id: string) => /\bTuner\b/.test(cardOf(state, id).type);
  const levelOf = (id: string) => levelNow(state, id)!;
  const tuners = faceUp.filter((m) => isTuner(m.id) && (materials.tuner === null || cardOf(state, m.id).name === materials.tuner));
  const others = faceUp.filter((m) => !isTuner(m.id)).map((m) => m.id);
  const { min, max } = materials.nonTuners;
  const sets: string[][] = [];
  for (const tuner of tuners) {
    const need = level - levelOf(tuner.id);
    for (let mask = 1; mask < 1 << others.length; mask++) {
      const picked = others.filter((_, i) => mask & (1 << i));
      if (picked.length < min || (max !== null && picked.length > max)) continue;
      if (picked.reduce((sum, id) => sum + levelOf(id), 0) === need) sets.push([tuner.id, ...picked]);
    }
  }
  return sets;
}

/** The zones a monster from the Extra Deck may go to once these monsters have left the field. */
function zonesAfterLeaving(state: DuelState, seat: Seat, leaving: string[]): number[] {
  const players = state.players.map((p) => ({ ...p, monsters: p.monsters.map((m) => (m && leaving.includes(m.id) ? null : m)) })) as DuelState['players'];
  return monsterZonesFor({ ...state, players }, seat, true);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

function extraSummon(run: Run, seat: Seat, intent: Extract<Intent, { type: 'extraSummon' }>) {
  const state = run.state;
  check(isMainPhase(state), 'You can only Summon in a Main Phase.');
  check(state.players[seat].extra.includes(intent.card), 'That card is not in your Extra Deck.');
  const action = extraSummonAction(state, seat, intent.card);
  check(action, `You can't Summon ${cardOf(state, intent.card).name} now.`);
  check(new Set(intent.materials).size === intent.materials.length, 'Each material must be a different monster.');
  const option = action.options.find((o) => sameSet(o.materials, intent.materials));
  check(option, `Those monsters aren't materials for ${cardOf(state, intent.card).name}.`);
  check(option.zones.includes(intent.zone), 'Choose an empty Monster Zone it can go to.');
  check(intent.position === 'attack' || intent.position === 'defense', 'Choose Attack or Defense Position.');
  run.emit({ type: 'extraSummoned', player: seat, card: intent.card, how: action.how, materials: intent.materials, zone: intent.zone, position: intent.position });
  run.emit({ type: 'checkpoint', cause: run.state.happened.at(-1)!, then: { do: 'open' } });
}

// ---------------------------------------------------------------------------
// Activating effects. Code checks what is the same for every card: the timing (the open game or a response window,
// and the spell speed a window allows), the phase, where the card is, a free zone, once-per-turn use, and the event an
// effect needs (`when`). A scripted effect's own conditions are checked here too (script.ts); for any other effect
// they are the judge's call. Triggers go on the chain in their own step (chain.ts).

/** Spell/Trap properties that can be activated. Equip cards and Continuous Traps, which tie themselves to a monster, come later. */
const ACTIVATABLE_SPELLS = ['Normal', 'Quick-Play', 'Continuous'];
const ACTIVATABLE_TRAPS = ['Normal'];

type Activate = Extract<LegalAction, { type: 'activate' }>;
/** An activation the timing allows, with the event it answers, before its script is checked. */
type Candidate = Activate & { cause: Happening | null };

export function activateAction(state: DuelState, card: string, effect: number, zones: number[] | null): Activate {
  return { type: 'activate', card, effect, zones, text: state.sheets[cardOf(state, card).code]!.effects[effect]!.effect };
}

/** The effects of one card the player may try to activate in the open game or the response window now. */
function candidates(state: DuelState, seat: Seat, id: string): Candidate[] {
  const step = state.step;
  const window = step.at === 'respond' ? step : null;
  if (!window && !(step.at === 'open' && state.turnPlayer === seat)) return [];
  const at = locate(state, id);
  if (!at || at.seat !== seat || state.instances[id]!.owner !== seat) return [];
  const card = cardOf(state, id);
  const sheet = state.sheets[card.code];
  if (!sheet) return [];
  const yourTurn = state.turnPlayer === seat;
  const main = yourTurn && isMainPhase(state);
  /** In the open game, fast effects work in your Main and Battle Phases; a window allows them in any phase. */
  const fast = window !== null || (yourTurn && (main || state.phase === 'battle'));
  // In a chain, a response must be at least as fast as the link it answers, and never Spell Speed 1.
  const minSpeed = window ? Math.max(2, ...state.chain.map((l) => speedOf(state, l))) : 1;
  const p = state.players[seat];
  const result: Candidate[] = [];
  sheet.effects.forEach((effect, index) => {
    if (effect.speed < minSpeed) return;
    if (!onceOk(state, id, card.code, index, effect.opt)) return;
    if (ruledIllegal(state, seat, id, index)) return;
    // An effect that answers an event can only be activated in the window that event opened. Responding to an
    // activation needs negation (a later layer).
    const cause = effect.when ? (window?.cause ?? null) : null;
    if (effect.when && (effect.when.event === 'activated' || !cause || !whenMatches(state, effect.when, cause, id, seat))) return;
    const push = (zones: number[] | null) => result.push({ ...activateAction(state, id, index, zones), cause });
    if (card.kind === 'spell' && effect.kind === 'activation' && ACTIVATABLE_SPELLS.includes(card.race)) {
      const quick = card.race === 'Quick-Play';
      if (!(quick ? fast : main && !window)) return;
      // A Quick-Play Spell can be activated from the hand only on your own turn, and not the turn it was Set.
      if (at.zone === 'hand' && yourTurn && freeZones(p.spellTraps).length > 0) push(freeZones(p.spellTraps));
      const set = at.zone === 'spellTraps' ? p.spellTraps[at.index]! : null;
      if (set && !set.faceUp && !(quick && set.placedTurn === state.turn)) push(null);
    } else if (card.kind === 'trap' && effect.kind === 'activation' && ACTIVATABLE_TRAPS.includes(card.race)) {
      const set = at.zone === 'spellTraps' ? p.spellTraps[at.index]! : null;
      if (fast && set && !set.faceUp && set.placedTurn !== state.turn) push(null);
    } else if (card.kind === 'monster' && (effect.kind === 'ignition' || effect.kind === 'quick')) {
      const m = at.zone === 'monsters' ? p.monsters[at.index]! : null;
      if (!m?.faceUp) return;
      // An ignition effect needs your open Main Phase, unless its script names other phases (Speed Warrior).
      const phased = scriptOf(state, id, index)?.conditions.some((c) => c.if === 'phase');
      if (effect.kind === 'ignition' ? !window && yourTurn && (main || phased) : fast) push(null);
    }
  });
  return result;
}

/** A chain link's Spell Speed, from its effect sheet. */
const speedOf = (state: DuelState, link: { card: string; effect: number }) => state.sheets[cardOf(state, link.card).code]?.effects[link.effect]?.speed ?? 1;

export const ruledIllegal = (state: DuelState, seat: Seat, id: string, effect: number) =>
  state.rulings.find((r) => !r.legal && r.player === seat && r.card === id && r.effect === effect);

export function onceOk(state: DuelState, id: string, code: number, effect: number, opt: 'none' | 'soft' | 'hard') {
  if (opt === 'soft') return !state.usedThisTurn.some((u) => u.card === id && u.effect === effect);
  if (opt === 'hard') return !state.usedThisTurn.some((u) => u.code === code && u.effect === effect);
  return true;
}

function allCandidates(state: DuelState, seat: Seat): Candidate[] {
  const p = state.players[seat];
  const ids = [...p.hand, ...p.monsters.flatMap((m) => (m ? [m.id] : [])), ...p.spellTraps.flatMap((c) => (c ? [c.id] : []))];
  return ids.flatMap((id) => candidates(state, seat, id));
}

/** The activations the player may make now, outside the triggers step. */
function usable(state: DuelState, seat: Seat): Activate[] {
  return allCandidates(state, seat)
    .filter((a) => !scriptProblem(state, seat, a.card, a.effect, a.cause))
    .map(({ cause: _, ...a }) => a);
}

const notJustPlaced = (state: DuelState, m: FieldCard) => m.placedTurn !== state.turn;
const positionUnchanged = (state: DuelState, m: FieldCard) => m.positionChangedTurn !== state.turn;

function canFlipSummon(state: DuelState, m: FieldCard) {
  return !m.faceUp && notJustPlaced(state, m) && positionUnchanged(state, m);
}

function canChangePosition(state: DuelState, m: FieldCard) {
  return m.faceUp && notJustPlaced(state, m) && positionUnchanged(state, m) && m.attackedTurn !== state.turn && !restricted(state, m.id, 'change_position');
}

/** Whether a resolved effect stopped the player doing this for the rest of the turn. */
const forbidden = (state: DuelState, seat: Seat, what: Forbidden) => state.forbidden.some((f) => f.player === seat && f.what === what && f.turn === state.turn);

function canAttack(state: DuelState, m: FieldCard) {
  const seat = locate(state, m.id)!.seat;
  return m.faceUp && m.position === 'attack' && m.attackedTurn !== state.turn && !restricted(state, m.id, 'attack') && !forbidden(state, seat, 'declare_attack');
}

/** The opponent's Monster Zones the player's monsters may attack: every monster there that can be targeted for an attack. */
function attackTargets(state: DuelState, seat: Seat): number[] {
  return state.players[other(seat)].monsters.flatMap((m, i) => (m && !restricted(state, m.id, 'be_attacked') ? [i] : []));
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
    if (intent.type === 'pass') {
      check(legalActions(state, seat).some((a) => a.type === 'pass'), 'There is nothing to pass on now.');
      run.emit({ type: 'passed', player: seat });
      return { ok: true, events: run.events };
    }
    if (intent.type === 'rps' || intent.type === 'chooseOrder') {
      decideStart(run, seat, intent);
      return { ok: true, events: run.events };
    }
    check(state.turn > 0, 'The duel starts once rock-paper-scissors decides who goes first.');
    if (intent.type === 'activate') {
      activate(run, seat, intent);
      return { ok: true, events: run.events };
    }
    check(state.turnPlayer === seat, "It's not your turn.");
    check(state.step.at === 'open', 'Wait for the chain to resolve.');
    apply(run, seat, intent);
    return { ok: true, events: run.events };
  } catch (e) {
    if (e instanceof Illegal) return { ok: false, error: e.message };
    throw e;
  }
}

function apply(run: Run, seat: Seat, intent: Exclude<Intent, { type: 'surrender' | 'pass' | 'activate' | 'rps' | 'chooseOrder' }>) {
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
      check(isZone(intent.zone, MONSTER_ZONES), 'Choose one of your Main Monster Zones.');
      check(monsterZoneFree(run.state, seat, intent.zone), 'That Monster Zone is not empty.');
      run.emit({ type: intent.type === 'normalSummon' ? 'normalSummoned' : 'monsterSet', player: seat, card: intent.card, zone: intent.zone });
      if (intent.type === 'normalSummon') run.emit({ type: 'checkpoint', cause: run.state.happened.at(-1)!, then: { do: 'open' } });
      return;
    }
    case 'extraSummon':
      extraSummon(run, seat, intent);
      return;
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
      run.emit({ type: 'checkpoint', cause: run.state.happened.at(-1)!, then: { do: 'open' } });
      return;
    }
    case 'changePosition': {
      check(isMainPhase(state), 'You can only change positions in a Main Phase.');
      const m = ownMonster(state, seat, intent.card);
      check(canChangePosition(state, m), "That monster's position can't be changed now.");
      run.emit({ type: 'positionChanged', player: seat, card: m.id, position: m.position === 'attack' ? 'defense' : 'attack' });
      return;
    }
    case 'enterBattle':
      check(state.phase === 'main1', 'You can only enter the Battle Phase from Main Phase 1.');
      check(!forbidden(state, seat, 'battle_phase'), "You can't conduct your Battle Phase this turn.");
      check(state.turn > 1, "The player who goes first can't conduct a Battle Phase on the first turn.");
      run.emit({ type: 'phaseChanged', phase: 'battle' });
      // The opponent's chance to act as the Battle Phase starts (Threatening Roar).
      run.emit({ type: 'checkpoint', cause: { event: 'phase', phase: 'battle', player: seat, group: state.resolvedLinks }, then: { do: 'open' } });
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
      // A last chance to respond in the End Phase; the turn ends once that is over (endTurn below).
      run.emit({ type: 'checkpoint', cause: { event: 'phase', phase: 'end', player: seat, group: state.resolvedLinks }, then: { do: 'endTurn', discard: [...discard] } });
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
  const foeMonsters = state.players[other(seat)].monsters;
  if (target === 'direct') {
    check(foeMonsters.every((m) => m === null), "You can't attack directly while your opponent controls a monster.");
  } else {
    check(foeMonsters[target], 'There is no monster in that zone.');
    check(attackTargets(state, seat).includes(target), "That monster can't be targeted for an attack.");
  }
  run.emit({ type: 'attackDeclared', player: seat, attacker: attacker.id, target: target === 'direct' ? null : foeMonsters[target]!.id });
  // Triggers and responses to the attack come first (Mirror Force); damage follows once they are done (damage below).
  run.emit({ type: 'checkpoint', cause: run.state.happened.find((h) => h.event === 'attack_declared')!, then: { do: 'damage' } });
}

// ---------------------------------------------------------------------------
// What follows a sequence of triggers and chains (the `continue` step)

/** The events that come once a sequence is over: the attack's damage, or the end of the turn. */
export function continuation(state: DuelState, then: Then): DuelEvent[] {
  const run = new Run(state);
  if (then.do === 'damage') damage(run);
  else if (then.do === 'endTurn') endTurn(run, then.discard);
  return run.events;
}

/**
 * The attack's damage, if it still stands. An attacker that left the field or changed position stops attacking. A
 * target that left, or a direct attack whose defender now has a monster, is a replay: the attack ends and the
 * monster may attack again. Triggers from the battle (Magna Drago) follow.
 */
function damage(run: Run) {
  const state = run.state;
  const seat = state.turnPlayer;
  const foe = other(seat);
  // An attack an effect negated is already over.
  if (!state.attack) return run.emit({ type: 'checkpoint', cause: null, then: { do: 'open' } });
  const { attacker: attackerId, target } = state.attack;
  const at = locate(state, attackerId);
  const attacker = at?.zone === 'monsters' && at.seat === seat ? state.players[seat].monsters[at.index]! : null;
  const targetAt = target === null ? null : locate(state, target);
  const foeMonsters = state.players[foe].monsters;
  if (!attacker || !attacker.faceUp || attacker.position !== 'attack') run.emit({ type: 'attackEnded', replay: false });
  else if (target === null ? foeMonsters.some((m) => m !== null) : targetAt?.zone !== 'monsters' || targetAt.seat !== foe) {
    run.emit({ type: 'attackEnded', replay: true });
  } else {
    const atk = statsOf(state, attackerId).atk;
    if (target === null) run.emit({ type: 'battleDamage', player: foe, amount: atk, by: attackerId });
    else battle(run, attackerId, atk, target);
    run.emit({ type: 'attackEnded', replay: false });
  }
  endIfLpGone(run);
  if (!run.state.result) run.emit({ type: 'checkpoint', cause: null, then: { do: 'open' } });
}

function battle(run: Run, attackerId: string, atk: number, target: string) {
  const seat = run.state.turnPlayer;
  const foe = other(seat);
  const defender = onField(run.state, target);
  if (!defender.faceUp) run.emit({ type: 'flippedByAttack', card: target });
  const stats = statsOf(run.state, target);
  // A monster an effect protects survives the battle; damage is dealt all the same (Sonic Chick).
  const destroy = (cards: string[]) => {
    const state = run.state;
    const lost = cards.filter((id) => !restricted(state, id, 'be_destroyed_by_battle', id === attackerId ? target : attackerId));
    if (lost.length > 0) run.emit({ type: 'destroyedByBattle', cards: lost });
  };
  if (defender.position === 'attack') {
    const def = stats.atk;
    if (atk > def) {
      destroy([target]);
      run.emit({ type: 'battleDamage', player: foe, amount: atk - def, by: attackerId });
    } else if (atk < def) {
      destroy([attackerId]);
      run.emit({ type: 'battleDamage', player: seat, amount: def - atk, by: target });
    } else if (atk > 0) {
      destroy([attackerId, target]);
    }
  } else {
    const def = stats.def;
    if (atk > def) destroy([target]);
    else if (atk < def) run.emit({ type: 'battleDamage', player: seat, amount: def - atk, by: target });
  }
}

/**
 * Cards that destroy themselves in this End Phase: those of the turn player's opponent whose count of that player's
 * turns since activation has come (Swords of Revealing Light).
 */
function selfDestructing(state: DuelState): string[] {
  return continuousOnField(state).flatMap((f) => {
    if (f.effect.apply !== 'self_destruct' || f.seat === state.turnPlayer) return [];
    const since = onField(state, f.source).activatedTurn;
    if (since === null) return [];
    // Turns alternate, so the turns of this card's controller's opponent since then are every other one, ending now.
    const turns = Math.floor((state.turn - since + 1) / 2);
    return turns === f.effect.opponentTurns ? [f.source] : [];
  });
}

/** Discards down to the hand limit (the cards the player chose, if still in hand) and starts the next turn. */
function endTurn(run: Run, chosen: string[]) {
  const state = run.state;
  const seat = state.turnPlayer;
  const hand = state.players[seat].hand;
  const excess = Math.max(0, hand.length - HAND_LIMIT);
  const kept = chosen.filter((id) => hand.includes(id));
  const discard = [...kept, ...hand.filter((id) => !kept.includes(id)).reverse()].slice(0, excess);
  const expiring = selfDestructing(state);
  if (expiring.length > 0) run.emit({ type: 'destroyed', cards: expiring });
  if (discard.length > 0) run.emit({ type: 'discarded', player: seat, cards: discard });
  beginTurn(run, other(seat), state.turn + 1);
}

/** Activates an effect the player chose: in the open game, a response window, or as an optional trigger. */
function activate(run: Run, seat: Seat, intent: Extract<Intent, { type: 'activate' }>) {
  const state = run.state;
  const ruling = ruledIllegal(state, seat, intent.card, intent.effect);
  check(!ruling, `The judge already ruled this activation illegal, and nothing has changed since: ${ruling?.summary}`);
  if (state.step.at === 'triggers') {
    const trigger = pendingTriggers(state).find((t) => t.card === intent.card && t.effect === intent.effect && t.player === seat && !t.mandatory);
    check(trigger && legalActions(state, seat).some((a) => a.type === 'activate' && a.card === intent.card), "That effect can't be activated now.");
    for (const e of triggerEvent(trigger)) run.emit(e);
    return;
  }
  const options = allCandidates(state, seat).filter((a) => a.card === intent.card && a.effect === intent.effect);
  check(options.length > 0, "That effect can't be activated now.");
  const problem = scriptProblem(state, seat, intent.card, intent.effect, options[0]!.cause);
  check(!problem, problem!);
  const fromHand = options.find((a) => a.zones !== null);
  if (fromHand) check(intent.zone !== null && fromHand.zones!.includes(intent.zone), 'Choose an empty Spell & Trap Zone.');
  run.emit({ type: 'effectActivated', player: seat, card: intent.card, effect: intent.effect, zone: fromHand ? intent.zone : null, cause: options[0]!.cause });
}

/** Ends the duel if a player's LP reached 0. */
export function endIfLpGone(run: Run) {
  const [a, b] = run.state.players;
  if (a.lp > 0 && b.lp > 0) return;
  const winner = a.lp === 0 && b.lp === 0 ? null : a.lp === 0 ? 1 : 0;
  run.emit({ type: 'duelEnded', result: { winner, reason: 'lp' } });
}
