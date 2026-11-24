// The game rules as code: what a player may do now, and the events an intent produces.

import { pendingTriggers, triggerEvent, whenMatches } from './chain.ts';
import { fits, identityFits, scriptOf, scriptProblem, specialSummonForbidden } from './script.ts';
import { attacksAllowed, continuousOnField, inForce, type InForce, type Restrict, levelNow, lockProblem, nameOf, negated, synchroMaterialRules, piercing, replacement, restricted, restriction, shieldsBattleDamage, statsOf, tributeSummonLocked } from './continuous.ts';
import { evolve, isToken, locate, monsterZoneFree, monsterZonesFor, onField, other } from './state.ts';
import {
  HAND_LIMIT,
  HANDS,
  MONSTER_ZONES,
  OPENING_HAND,
  FIELD_ZONE,
  SPELL_TRAP_ZONES,
  type Blocked,
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
    // A card reaching the hand may complete a hand that wins the Duel.
    if (!this.state.result && (event.type === 'drew' || (event.type === 'moved' && event.to === 'hand'))) {
      const winners = handWinners(this.state);
      if (winners.length > 0) this.emit({ type: 'duelEnded', result: { winner: winners.length === 1 ? winners[0]! : null, reason: 'handWin' } });
    }
  }
}

/** The players holding every card a `win_with_hand` effect of a card in their hand names (Exodia). */
function handWinners(state: DuelState): Seat[] {
  return ([0, 1] as const).filter((seat) => {
    const hand = state.players[seat].hand;
    const names = new Set(hand.map((id) => cardOf(state, id).name));
    return hand.some((id) =>
      state.sheets[cardOf(state, id).code]?.effects.some((e) => e.status !== 'flagged' && e.continuous?.apply === 'win_with_hand' && e.continuous.names.every((n) => names.has(n))),
    );
  });
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

const isFieldSpell = (card: CardData) => card.kind === 'spell' && card.race === 'Field';

/**
 * The zones a Spell or Trap from the hand may be Set or activated in: an empty Spell & Trap Zone, or for a Field Spell
 * the Field Zone, even when it holds one already (that one goes to the GY: see `placeSpellTrap`).
 */
export function spellTrapZonesFor(state: DuelState, seat: Seat, card: CardData): number[] {
  return isFieldSpell(card) ? [FIELD_ZONE] : freeZones(state.players[seat].spellTraps.slice(0, SPELL_TRAP_ZONES));
}

/** Before a card goes to `zone`: a Field Spell already in the Field Zone is sent to the GY. */
function clearFieldZone(run: Run, seat: Seat, zone: number) {
  const old = zone === FIELD_ZONE ? run.state.players[seat].spellTraps[FIELD_ZONE] : null;
  if (old) run.emit({ type: 'moved', card: old.id, owner: run.state.instances[old.id]!.owner, from: 'spellTraps', to: 'graveyard' });
}

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

/**
 * Once the turn's Normal Summons are used: the continuous effect that lets the player Normal Summon this card from their
 * hand anyway (General Grunard), if one can now.
 */
export function extraNormalSummon(state: DuelState, seat: Seat, id: string): { card: string; effect: number } | null {
  if (!normalSummonUsed(state)) return null;
  const f = inForce(state).find((f) => {
    if (f.seat !== seat || f.effect.apply !== 'extra_normal_summon' || !fits(state, id, f.effect.filter, seat)) return false;
    const code = state.instances[f.source]!.code;
    return onceOk(state, f.source, code, f.index, state.sheets[code]!.effects[f.index]!.opt);
  });
  return f ? { card: f.source, effect: f.index } : null;
}

/**
 * What the duel waits on `seat` for: its own turn, or an answer (a response, a trigger, a pick, a rollback offer). Null
 * when it waits on nobody, on the other player, or only for a pass the server makes by itself because there is nothing
 * to activate. Questions from the judge aren't part of the state, so the server adds those.
 */
export function yourMove(state: DuelState, seat: Seat): 'turn' | 'answer' | null {
  // Surrendering is always open, so it never makes the duel wait.
  const actions = legalActions(state, seat).filter((a) => a.type !== 'surrender');
  if (actions.some((a) => a.type === 'rollback')) return 'answer';
  if (state.step.at === 'open') return actions.length > 0 ? 'turn' : null;
  if (state.step.at === 'respond') return actions.some((a) => a.type !== 'pass') ? 'answer' : null;
  return actions.length > 0 ? 'answer' : null;
}

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
  }
  if (state.rollback && !state.rollback.accepted.includes(seat)) actions.push({ type: 'rollback' });
  if (step.at === 'tax') {
    if (step.player === seat) actions.push({ type: 'tax', card: state.chain.at(-1)!.card, by: step.by, hand: [...state.players[seat].hand] });
  } else if (step.at === 'replace') {
    const count = replacement(state, step.card);
    if (step.player === seat && count !== null) actions.push({ type: 'replace', card: step.card, materials: onField(state, step.card).materials, count });
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
          if (!card.extraDeck && canNormalSummon(state, card) && fits) {
            const fresh = !normalSummonUsed(state);
            if ((fresh || extraNormalSummon(state, seat, id)) && (tributes === 0 || !tributeSummonLocked(state, seat))) actions.push({ type: 'normalSummon', card: id, tributes, tributeFrom, zones });
            if (fresh) actions.push({ type: 'setMonster', card: id, tributes, tributeFrom, zones });
          }
        } else if (spellTrapZonesFor(state, seat, card).length > 0) {
          actions.push({ type: 'setSpellTrap', card: id, zones: spellTrapZonesFor(state, seat, card) });
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
  if (!materials || materials.summon === 'fusion' || specialSummonForbidden(state, seat, id)) return null;
  const sets = materials.summon === 'xyz' ? xyzMaterials(state, seat, materials) : card.level === null ? [] : synchroMaterials(state, seat, materials, card);
  const options = sets.flatMap((set) => {
    const zones = zonesAfterLeaving(state, seat, set);
    return zones.length > 0 ? [{ materials: set, zones }] : [];
  });
  return options.length > 0 ? { type: 'extraSummon', card: id, how: materials.summon, options } : null;
}

/** Whether a monster's sheet allows it to be Normal Summoned or Set ("Cannot be Normal Summoned/Set"). */
const canNormalSummon = (state: DuelState, card: CardData) => state.sheets[card.code]?.normalSummon !== false;

/** Every set of `count` face-up monsters the player controls whose current Level is the Xyz Monster's. */
function xyzMaterials(state: DuelState, seat: Seat, materials: Extract<Materials, { summon: 'xyz' }>): string[][] {
  // A Token can't be an Xyz Material.
  const fitting = ownMonsters(state, seat).filter((m) => m.faceUp && !isToken(state, m.id) && levelNow(state, m.id) === materials.level).map((m) => m.id);
  const sets: string[][] = [];
  const pick = (from: number, chosen: string[]) => {
    if (chosen.length === materials.count) return void sets.push(chosen);
    for (let i = from; i < fitting.length; i++) pick(i + 1, [...chosen, fitting[i]!]);
  };
  pick(0, []);
  return sets;
}

/**
 * Every set of materials for this Synchro Monster: one face-up Tuner (the one named, if any, or a monster that can
 * substitute for it) and enough face-up non-Tuners, whose current Levels add up to its Level exactly. Monsters that
 * can't be Synchro Material for it are left out. Each set lists the Tuner first, then the rest in field order.
 */
function synchroMaterials(state: DuelState, seat: Seat, materials: Extract<Materials, { summon: 'synchro' }>, synchro: CardData): string[][] {
  const level = synchro.level!;
  const has = (text: string | null, part: string) => text !== null && text.toLowerCase().includes(part.toLowerCase());
  const usable = (id: string) =>
    synchroMaterialRules(state, id).every(
      (r) => !r.never && (!r.onlyFor || identityFits(synchro, r.onlyFor)) && (r.onlyForTuner === null || has(materials.tuner, r.onlyForTuner)),
    );
  const faceUp = ownMonsters(state, seat).filter((m) => m.faceUp && levelNow(state, m.id) !== null && usable(m.id));
  const isTuner = (id: string) => /\bTuner\b/.test(cardOf(state, id).type);
  const levelOf = (id: string) => levelNow(state, id)!;
  const named = (id: string) =>
    materials.tuner === null || nameOf(state, id) === materials.tuner || synchroMaterialRules(state, id).some((r) => r.substitutes !== null && has(materials.tuner, r.substitutes));
  const tuners = faceUp.filter((m) => isTuner(m.id) && named(m.id));
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

/** Spell/Trap properties that can be activated. Field Spells come later. */
const ACTIVATABLE_SPELLS = ['Normal', 'Quick-Play', 'Continuous', 'Equip', 'Field'];
const ACTIVATABLE_TRAPS = ['Normal', 'Continuous', 'Counter'];

type Activate = Extract<LegalAction, { type: 'activate' }>;
/** An activation the timing allows, with the event it answers, before its script is checked. */
type Candidate = Activate & { cause: Happening | null };

export function activateAction(state: DuelState, card: string, effect: number, zones: number[] | null): Activate {
  return { type: 'activate', card, effect, zones, text: state.sheets[cardOf(state, card).code]!.effects[effect]!.effect };
}

/** One effect of a card: the activation the timing allows now, or why it doesn't. */
type EffectCheck = { effect: number; candidate: Candidate } | { effect: number; reason: string };

/** Why no effect can be activated now, whatever the card, or null when some may be. */
function timingProblem(state: DuelState, seat: Seat): string | null {
  const step = state.step;
  if (step.at === 'respond') return step.priority === seat ? null : 'Wait until you have priority in this response window.';
  if (step.at === 'open') return state.turnPlayer === seat ? null : "On your opponent's turn you can only respond when a response window gives you priority.";
  return 'Not now: the duel is resolving something first.';
}

/**
 * Each effect of one card, checked against what code knows for every card: the timing (the open game or a response
 * window, and the spell speed a window allows), the phase, where the card is, a free zone, once-per-turn use, a
 * standing ruling and the event the effect needs. A passing effect becomes a candidate; its script is checked after.
 */
function checkEffects(state: DuelState, seat: Seat, id: string): EffectCheck[] {
  const at = locate(state, id);
  if (!at || at.seat !== seat || state.instances[id]!.owner !== seat) return [];
  const card = cardOf(state, id);
  const sheet = state.sheets[card.code];
  if (!sheet) return [];
  const timing = timingProblem(state, seat);
  const step = state.step;
  const window = step.at === 'respond' ? step : null;
  const yourTurn = state.turnPlayer === seat;
  const main = yourTurn && isMainPhase(state);
  /** In the open game, fast effects work in your Main and Battle Phases; a window allows them in any phase. */
  const fast = window !== null || (yourTurn && (main || state.phase === 'battle'));
  // In a chain, a response must be at least as fast as the link it answers, and never Spell Speed 1.
  const minSpeed = window ? Math.max(2, ...state.chain.map((l) => speedOf(state, l))) : 1;
  const p = state.players[seat];
  return sheet.effects.map((effect, index): EffectCheck => {
    const no = (reason: string): EffectCheck => ({ effect: index, reason });
    if (effect.kind === 'trigger') return no(`A trigger effect: it comes up by itself (${effect.window || 'when its event happens'}).`);
    if (effect.kind === 'continuous') return no('Always on while the card is face-up on the field; it is never activated.');
    if (effect.kind === 'condition') return procedureCheck(state, seat, id, index, timing);
    if (effect.kind === 'flip') return no('A Flip effect: it happens when the card is flipped face-up.');
    // Where the card is and its state come first: they are the reasons a player can do least about.
    const set = at.zone === 'spellTraps' ? p.spellTraps[at.index]! : null;
    const m = at.zone === 'monsters' ? p.monsters[at.index]! : null;
    const quick = card.kind === 'spell' && card.race === 'Quick-Play';
    if (card.kind === 'spell' && effect.kind === 'activation') {
      if (!ACTIVATABLE_SPELLS.includes(card.race)) return no(`${card.race} Spells can't be activated on this site yet.`);
      if (at.zone !== 'hand' && !set) return no('Only from your hand or a Spell & Trap Zone.');
      if (set?.faceUp) return no('It is already face-up.');
      if (quick && set && set.placedTurn === state.turn) return no("A Quick-Play Spell Set this turn can't be activated until a later turn.");
      if (at.zone === 'hand' && spellTrapZonesFor(state, seat, card).length === 0) return no('Your Spell & Trap Zones are full.');
    } else if (card.kind === 'trap' && effect.kind === 'activation') {
      if (!ACTIVATABLE_TRAPS.includes(card.race)) return no(`${card.race} Traps can't be activated on this site yet.`);
      if (!set) return no('A Trap must be Set first, and activated on a later turn.');
      if (set.faceUp) return no('It is already face-up.');
      if (set.placedTurn === state.turn) return no("A Trap can't be activated the turn it was Set.");
    } else if (effect.kind === 'ignition' || effect.kind === 'quick') {
      // A monster's effect, a face-up Spell or Trap's effect, or any card's effect used from the hand or GY (Terror of Trishula).
      const fieldCard = m ?? set;
      if (effect.from !== 'field' && at.zone !== effect.from) return no(`Only while it is in your ${effect.from === 'hand' ? 'hand' : 'GY'}.`);
      if (effect.from === 'field' && !fieldCard?.faceUp) return no('Only while it is face-up on the field.');
      if (fieldCard && negated(state, id)) return no('Its effects are negated.');
    } else {
      return no('This effect is not activated.');
    }
    const locked = lockProblem(state, seat, id, index);
    if (locked) return no(locked);
    if (timing) return no(timing);
    if (effect.speed < minSpeed) {
      return no(minSpeed === 3 ? 'Only a Counter Trap can respond to a Counter Trap.' : `A Spell Speed ${effect.speed} effect can't be activated in response to Spell Speed ${minSpeed}.`);
    }
    if (!onceOk(state, id, card.code, index, effect.opt)) return no('Once per turn: it was already used this turn.');
    const ruling = ruledIllegal(state, seat, id, index);
    if (ruling) return no(`The judge refused it on this board: ${ruling.summary}`);
    // The phase each kind needs.
    if (card.kind === 'spell') {
      if (!(quick ? fast : main && !window)) {
        return no(quick ? 'A Quick-Play Spell can be activated in your Main or Battle Phase, or in response.' : 'Only in your own Main Phase, with no chain going.');
      }
      if (at.zone === 'hand' && !yourTurn) return no('A Quick-Play Spell can be activated from the hand only on your own turn.');
    } else if (card.kind === 'trap' || effect.kind === 'quick') {
      if (!fast) return no('Only in your Main or Battle Phase, or in response.');
    } else {
      // An ignition effect needs your open Main Phase, unless its script names other phases (Speed Warrior).
      const phased = scriptOf(state, id, index)?.conditions.some((c) => c.if === 'phase');
      if (window) return no("An ignition effect can't be activated in response.");
      if (!(yourTurn && (main || phased))) return no('Only in your own Main Phase.');
    }
    // An effect that answers an event can only be activated in the window that event opened; one that answers an
    // activation, in the window the last link on the chain opened.
    const cause = effect.when?.event === 'activated' ? lastActivation(state) : effect.when ? (window?.cause ?? null) : null;
    if (effect.when && (!cause || !whenMatches(state, effect.when, cause, id, seat))) return no(`Only at its moment: ${effect.window || 'when the event it answers happens'}.`);
    const zones = card.kind !== 'monster' && at.zone === 'hand' ? spellTrapZonesFor(state, seat, card) : null;
    return { effect: index, candidate: { ...activateAction(state, id, index, zones), cause } };
  });
}

/**
 * A Summoning procedure from the hand (a `condition` effect with a script): its controller's open Main Phase, like an
 * ignition effect. Its script's conditions and cost are checked after, like an activation's.
 */
function procedureCheck(state: DuelState, seat: Seat, id: string, index: number, timing: string | null): EffectCheck {
  const no = (reason: string): EffectCheck => ({ effect: index, reason });
  const effect = state.sheets[cardOf(state, id).code]!.effects[index]!;
  if (!scriptOf(state, id, index)) return no('A summoning condition, not an effect you activate.');
  if (locate(state, id)?.zone !== 'hand') return no('A Summoning procedure: it Special Summons this card from your hand.');
  if (timing) return no(timing);
  if (state.step.at !== 'open' || !isMainPhase(state)) return no('Only in your own Main Phase, with no chain going.');
  if (!onceOk(state, id, cardOf(state, id).code, index, effect.opt)) return no('Once per turn: it was already used this turn.');
  const ruling = ruledIllegal(state, seat, id, index);
  if (ruling) return no(`The judge refused it on this board: ${ruling.summary}`);
  return { effect: index, candidate: { ...activateAction(state, id, index, null), cause: null } };
}

/** Whether effect `effect` of the card is a Summoning procedure (see `procedureCheck`). */
export const isProcedure = (state: DuelState, card: string, effect: number) => state.sheets[cardOf(state, card).code]?.effects[effect]?.kind === 'condition';

/**
 * The checkpoint after a Summoning procedure: triggers and responses to the Summon it made, or just a return to the
 * open game if it made none.
 */
export function procedureDone(state: DuelState, card: string): DuelEvent {
  const summoned = state.happened.findLast((h) => h.event === 'summoned' && h.card === card) ?? null;
  return { type: 'checkpoint', cause: summoned, then: { do: 'open' } };
}

/** The effects of one card the player may try to activate in the open game or the response window now. */
function candidates(state: DuelState, seat: Seat, id: string): Candidate[] {
  return checkEffects(state, seat, id).flatMap((c) => ('candidate' in c ? [c.candidate] : []));
}

/**
 * Why each effect of the player's cards (hand and field) can't be activated now, for "Why can't I?". An effect that
 * `actions` (the player's legal actions now) offers isn't listed, nor is one waiting as an optional trigger. Reasons only use what the player can see.
 */
export function blockedEffects(state: DuelState, seat: Seat, actions: LegalAction[]): Blocked[] {
  if (state.result || state.step.at === 'rps' || state.step.at === 'order') return [];
  const offered = actions.flatMap((a) => (a.type === 'activate' ? [`${a.card}:${a.effect}`] : []));
  const p = state.players[seat];
  const ids = [...p.hand, ...p.monsters.flatMap((m) => (m ? [m.id] : [])), ...p.spellTraps.flatMap((c) => (c ? [c.id] : [])), ...p.graveyard];
  return ids.flatMap((id) =>
    checkEffects(state, seat, id).flatMap((c): Blocked[] => {
      if (offered.includes(`${id}:${c.effect}`)) return [];
      // In the GY, only the effects used from there are worth explaining.
      if (p.graveyard.includes(id) && state.sheets[cardOf(state, id).code]!.effects[c.effect]!.from !== 'graveyard') return [];
      const text = state.sheets[cardOf(state, id).code]!.effects[c.effect]!.effect;
      if ('reason' in c) return [{ card: id, effect: c.effect, text, reason: c.reason }];
      const problem = scriptProblem(state, seat, id, c.effect, c.candidate.cause);
      return problem ? [{ card: id, effect: c.effect, text, reason: problem }] : [];
    }),
  );
}

/** Why each of the player's monsters can't attack now, in their Battle Phase, for "Why can't I?". */
export function blockedAttacks(state: DuelState, seat: Seat): Blocked[] {
  if (state.result || state.step.at !== 'open' || state.turnPlayer !== seat || state.phase !== 'battle') return [];
  const targets = attackTargets(state, seat);
  const direct = state.players[other(seat)].monsters.every((m) => m === null);
  return ownMonsters(state, seat).flatMap((m): Blocked[] => {
    const reason = !m.faceUp
      ? 'A face-down monster can\'t attack.'
      : m.position !== 'attack'
        ? 'Only a monster in Attack Position can attack.'
        : !attackLeft(state, m)
          ? 'It already attacked this turn.'
          : forbidden(state, seat, 'declare_attack')
            ? "An effect stopped you declaring attacks this turn."
            : restricted(state, m.id, 'attack')
              ? "A card's effect stops it attacking."
              : !direct && targets.length === 0
                ? "None of your opponent's monsters can be attacked."
                : null;
    return reason ? [{ card: m.id, effect: null, text: null, reason }] : [];
  });
}

/** The activation a response window answers: the chain's last link, while players may respond to it. */
function lastActivation(state: DuelState): Happening | null {
  const last = state.chain.at(-1);
  if (state.step.at !== 'respond' || !last) return null;
  return { event: 'activated', card: last.card, player: last.player, link: state.chain.length - 1, group: state.resolvedLinks };
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
  const ids = [...p.hand, ...p.monsters.flatMap((m) => (m ? [m.id] : [])), ...p.spellTraps.flatMap((c) => (c ? [c.id] : [])), ...p.graveyard];
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
  return m.faceUp && notJustPlaced(state, m) && positionUnchanged(state, m) && m.attacks?.turn !== state.turn && !restricted(state, m.id, 'change_position');
}

/** Whether a resolved effect stopped the player doing this for the rest of the turn. */
const forbidden = (state: DuelState, seat: Seat, what: Forbidden) => state.forbidden.some((f) => f.player === seat && f.what === what && f.turn === state.turn);

function canAttack(state: DuelState, m: FieldCard) {
  const seat = locate(state, m.id)!.seat;
  return m.faceUp && m.position === 'attack' && attackLeft(state, m) && !restricted(state, m.id, 'attack') && !forbidden(state, seat, 'declare_attack');
}

/** Whether a monster has an attack left this turn: most have one, some more (Hayabusa Knight). */
const attackLeft = (state: DuelState, m: FieldCard) => m.attacks?.turn !== state.turn || m.attacks.count < attacksAllowed(state, m.id);

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
    if (intent.type === 'rollback') {
      check(state.rollback && !state.rollback.accepted.includes(seat), 'There is no rewind for you to answer.');
      run.emit({ type: 'rollbackAnswered', player: seat, accept: intent.accept });
      return { ok: true, events: run.events };
    }
    if (intent.type === 'tax') {
      const offer = legalActions(state, seat).find((a) => a.type === 'tax');
      check(offer, 'Nothing is asking you that now.');
      check(intent.discard === null || offer.hand.includes(intent.discard), 'Discard a card from your hand.');
      if (intent.discard) run.emit({ type: 'discarded', player: seat, cards: [intent.discard] });
      run.emit({ type: 'taxAnswered', negated: intent.discard === null });
      return { ok: true, events: run.events };
    }
    if (intent.type === 'replace') {
      const offer = legalActions(state, seat).find((a) => a.type === 'replace');
      check(offer, 'Nothing is asking you that now.');
      const picked = new Set(intent.materials);
      check(picked.size === intent.materials.length && intent.materials.every((m) => offer.materials.includes(m)), 'Pick materials attached to that monster.');
      check(picked.size === 0 || picked.size === offer.count, `Detach exactly ${offer.count}, or none.`);
      run.emit({ type: 'replacementChosen', card: offer.card, materials: intent.materials });
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
      check(p.hand.includes(intent.card), 'That card is not in your hand.');
      const extra = intent.type === 'normalSummon' ? extraNormalSummon(state, seat, intent.card) : null;
      check(!normalSummonUsed(state) || extra !== null, 'You already used your Normal Summons and Sets this turn.');
      const card = cardOf(state, intent.card);
      check(card.kind === 'monster' && !card.extraDeck, 'Only Main Deck monsters can be Normal Summoned or Set.');
      check(canNormalSummon(state, card), `${card.name} cannot be Normal Summoned or Set.`);
      const needed = tributesFor(card);
      check(intent.type === 'setMonster' || needed === 0 || !tributeSummonLocked(state, seat), "An effect stops you Tribute Summoning.");
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
      if (intent.type === 'normalSummon') run.emit({ type: 'normalSummoned', player: seat, card: intent.card, zone: intent.zone, extra });
      else run.emit({ type: 'monsterSet', player: seat, card: intent.card, zone: intent.zone });
      if (intent.type === 'normalSummon') run.emit({ type: 'checkpoint', cause: run.state.happened.at(-1)!, then: { do: 'open' } });
      return;
    }
    case 'extraSummon':
      extraSummon(run, seat, intent);
      return;
    case 'setSpellTrap': {
      check(isMainPhase(state), 'You can only Set cards in a Main Phase.');
      check(p.hand.includes(intent.card), 'That card is not in your hand.');
      const card = cardOf(state, intent.card);
      check(card.kind !== 'monster', 'Only Spells and Traps go in the Spell & Trap Zone.');
      check(spellTrapZonesFor(state, seat, card).includes(intent.zone), isFieldSpell(card) ? 'A Field Spell goes in the Field Zone.' : 'Choose an empty Spell & Trap Zone.');
      clearFieldZone(run, seat, intent.zone);
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
      returnBorrowed(run);
      // A last chance to respond in the End Phase; the turn ends once that is over (endTurn below).
      run.emit({ type: 'checkpoint', cause: { event: 'phase', phase: 'end', player: seat, group: state.resolvedLinks }, then: { do: 'endTurn', discard: [...discard] } });
      return;
    }
  }
}

/**
 * Monsters taken "until the End Phase" go back to their owners as it starts, into a free Main Monster Zone, or to the
 * GY if they have none.
 */
function returnBorrowed(run: Run) {
  for (const p of run.state.players) {
    for (const m of p.monsters) {
      if (!m?.returnsAtEndPhase) continue;
      const owner = run.state.instances[m.id]!.owner;
      const zone = monsterZonesFor(run.state, owner, false)[0];
      if (zone === undefined) run.emit({ type: 'moved', card: m.id, owner, from: 'monsters', to: 'graveyard' });
      else run.emit({ type: 'controlChanged', card: m.id, to: owner, zone, until: null });
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
  run.emit({ type: 'checkpoint', cause: run.state.happened.find((h) => h.event === 'attack_declared')!, then: { do: 'damage_step' } });
}

// ---------------------------------------------------------------------------
// What follows a sequence of triggers and chains (the `continue` step)

/** The events that come once a sequence is over: the attack's damage, or the end of the turn. */
export function continuation(state: DuelState, then: Then): DuelEvent[] {
  const run = new Run(state);
  if (then.do === 'damage_step') damageStep(run);
  else if (then.do === 'damage') damage(run);
  else if (then.do === 'endTurn') endTurn(run, then.discard);
  return run.events;
}

/** The attacking monster, if it is still on its controller's field face-up in Attack Position. */
function stillAttacking(state: DuelState, id: string): boolean {
  const at = locate(state, id);
  const m = at?.zone === 'monsters' && at.seat === state.turnPlayer ? state.players[at.seat].monsters[at.index]! : null;
  return !!m && m.faceUp && m.position === 'attack';
}

/** Whether the attack's target is still the opponent's monster. */
const targetStands = (state: DuelState, target: string) => {
  const at = locate(state, target);
  return at?.zone === 'monsters' && at.seat === other(state.turnPlayer);
};

/**
 * The attack enters the Damage Step, if it still stands. An attacker that left the field or changed position stops
 * attacking. A target that left, or a direct attack whose defender now has a monster, is a replay: the attack ends and
 * the monster may attack again. Triggers at the start of the Damage Step (Zubaba Knight) come before damage.
 */
function damageStep(run: Run) {
  const state = run.state;
  // An attack an effect negated is already over.
  if (!state.attack) return run.emit({ type: 'checkpoint', cause: null, then: { do: 'open' } });
  const { attacker, target } = state.attack;
  const foeMonsters = state.players[other(state.turnPlayer)].monsters;
  if (!stillAttacking(state, attacker)) run.emit({ type: 'attackEnded', replay: false });
  else if (target === null ? foeMonsters.some((m) => m !== null) : !targetStands(state, target)) run.emit({ type: 'attackEnded', replay: true });
  else {
    run.emit({ type: 'damageStepStarted' });
    return run.emit({ type: 'checkpoint', cause: null, then: { do: 'damage' } });
  }
  run.emit({ type: 'checkpoint', cause: null, then: { do: 'open' } });
}

/**
 * The attack's damage. If the attacker or its target left the field during the Damage Step, the attack just ends.
 * Triggers from the battle (Magna Drago) follow.
 */
function damage(run: Run) {
  const state = run.state;
  const seat = state.turnPlayer;
  const foe = other(seat);
  if (!state.attack) return run.emit({ type: 'checkpoint', cause: null, then: { do: 'open' } });
  const { attacker: attackerId, target } = state.attack;
  if (!stillAttacking(state, attackerId) || (target !== null && !targetStands(state, target))) run.emit({ type: 'attackEnded', replay: false });
  else if (target === null) run.emit({ type: 'battleDamage', player: foe, amount: statsOf(state, attackerId).atk, by: attackerId });
  else {
    if (!onField(state, target).faceUp) run.emit({ type: 'flipped', card: target });
    const result = battle(run.state, attackerId, target);
    // A monster that would be destroyed but can detach materials instead waits for its controller to decide.
    const replaced = run.state.attack!.replaced;
    const asking = result.destroyed.find((id) => replacement(run.state, id) !== null && !(id in replaced));
    if (asking) return run.emit({ type: 'replacementOffered', card: asking, player: locate(run.state, asking)!.seat, then: { do: 'damage' } });
    for (const f of result.protectedOnce) run.emit({ type: 'protectionUsed', player: f.seat, card: f.source, effect: f.index });
    for (const id of result.destroyed) for (const m of replaced[id] ?? []) run.emit({ type: 'moved', card: m, owner: run.state.instances[m]!.owner, from: 'materials', to: 'graveyard' });
    const lost = result.destroyed.filter((id) => !replaced[id]?.length);
    if (lost.length > 0) run.emit({ type: 'destroyedByBattle', cards: lost });
    if (result.damage) run.emit({ type: 'battleDamage', ...result.damage });
  }
  if (run.state.attack) run.emit({ type: 'attackEnded', replay: false });
  endIfLpGone(run);
  if (!run.state.result) run.emit({ type: 'checkpoint', cause: null, then: { do: 'open' } });
}

type Damage = { player: Seat; amount: number; by: string };

/**
 * Damage calculation between an attacker and a face-up target: the monsters destroyed (not those an effect protects,
 * Sonic Chick), the battle damage dealt (piercing, or none to a player whose monster shields them), and the
 * once-per-turn protections this battle used up (Fortress Warrior).
 */
function battle(state: DuelState, attackerId: string, target: string): { destroyed: string[]; damage: Damage | null; protectedOnce: InForce<Restrict>[] } {
  const seat = state.turnPlayer;
  const foe = other(seat);
  const atk = statsOf(state, attackerId).atk;
  const stats = statsOf(state, target);
  const result = (destroyed: string[], damage: Damage | null) => {
    const protections = destroyed.map((id) => restriction(state, id, 'be_destroyed_by_battle', id === attackerId ? target : attackerId));
    const shielded = damage && shieldsBattleDamage(state, damage.player === seat ? attackerId : target);
    return {
      destroyed: destroyed.filter((_, i) => !protections[i]),
      damage: shielded ? null : damage,
      protectedOnce: protections.filter((f) => f !== null && f.effect.once) as InForce<Restrict>[],
    };
  };
  if (onField(state, target).position === 'attack') {
    const def = stats.atk;
    if (atk > def) return result([target], { player: foe, amount: atk - def, by: attackerId });
    if (atk < def) return result([attackerId], { player: seat, amount: def - atk, by: target });
    return result(atk > 0 ? [attackerId, target] : [], null);
  }
  const def = stats.def;
  if (atk > def) return result([target], piercing(state, attackerId) ? { player: foe, amount: atk - def, by: attackerId } : null);
  return result([], atk < def ? { player: seat, amount: def - atk, by: target } : null);
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
  for (const id of expiring) run.emit({ type: 'destroyed', cards: [id], by: locate(state, id)!.seat });
  // A pledge not kept: "take 2000 damage if you did not Normal Summon the added monster" (Where Arf Thou?).
  for (const pl of state.pledges) run.emit({ type: 'lpChanged', player: pl.player, amount: -pl.damage, kind: 'damage' });
  endIfLpGone(run);
  if (run.state.result) return;
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
  if (isProcedure(state, intent.card, intent.effect)) return run.emit({ type: 'procedureUsed', player: seat, card: intent.card, effect: intent.effect });
  const fromHand = options.find((a) => a.zones !== null);
  if (fromHand) check(intent.zone !== null && fromHand.zones!.includes(intent.zone), 'Choose an empty Spell & Trap Zone.');
  if (fromHand) clearFieldZone(run, seat, intent.zone!);
  run.emit({ type: 'effectActivated', player: seat, card: intent.card, effect: intent.effect, zone: fromHand ? intent.zone : null, cause: options[0]!.cause });
}

/** Ends the duel if a player's LP reached 0. */
export function endIfLpGone(run: Run) {
  const [a, b] = run.state.players;
  if (a.lp > 0 && b.lp > 0) return;
  const winner = a.lp === 0 && b.lp === 0 ? null : a.lp === 0 ? 1 : 0;
  run.emit({ type: 'duelEnded', result: { winner, reason: 'lp' } });
}
