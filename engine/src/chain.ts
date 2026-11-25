// Triggers, response windows and what comes next. Code decides all of the timing: which triggers fire after an event,
// the order they go on the chain, who may respond, and when the chain resolves (docs/chains.md). Running an effect
// itself (paying, choosing, resolving) is the server's job, through scripts or the judge.

import { cardOf, continuation, legalActions, onceOk, ruledIllegal } from './rules.ts';
import { fits, scriptProblem } from './script.ts';
import { flipNegatedByBattle, lockProblem, negated, taxedBy } from './continuous.ts';
import { locate, summonMatches, summonName } from './state.ts';
import type { DuelEvent, DuelState, Happening, Seat, When } from './types.ts';
import { PHASE_NAMES } from './types.ts';

/** Whether an event is the one an effect of `card` (controlled by `seat`) waits for. */
export function whenMatches(state: DuelState, when: When, h: Happening, card: string, seat: Seat): boolean {
  // A response window opened by an attack answers the attack and the targeting alike.
  if (when.event === 'attacked' && h.event === 'attack_declared' && h.target) {
    return whenMatches(state, when, { event: 'attacked', card: h.target, player: h.player === 0 ? 1 : 0, attacker: h.card, group: h.group }, card, seat);
  }
  if (h.event === 'phase') return when.event === 'end_phase' && h.phase === 'end';
  if (h.event === 'activated' && when.targeting && !(state.chain[h.link]?.targets ?? []).some((id) => fits(state, id, when.targeting!, seat))) return false;
  if (when.event === 'direct_attack_damage') return h.event === 'battle_damage' && h.direct && whenMatches(state, { ...when, event: 'battle_damage' }, h, card, seat);
  // "Destroyed" by battle or by an effect: in battle, by the other monster's controller.
  if (when.event === 'destroyed') {
    if (h.event === 'destroyed_by_effect') return whenMatches(state, { ...when, event: 'destroyed_by_effect' }, h, card, seat);
    if (h.event !== 'destroyed_by_battle' || (when.by && (h.player !== seat) !== (when.by === 'you'))) return false;
    return whenMatches(state, { ...when, event: 'destroyed_by_battle', by: null }, h, card, seat);
  }
  if (when.event !== h.event) return false;
  // A destroyed card is checked as it was on the field: whose it was, and whether it was face-up.
  if (h.event === 'destroyed_by_effect') {
    const mine = h.player === seat;
    const f = when.filter;
    if (when.by && (h.by === seat) !== (when.by === 'you')) return false;
    if (when.self && h.card !== card) return false;
    return !f || ((f.side === 'either' || mine === (f.side === 'you')) && (f.faceUp === null || f.faceUp === h.faceUp));
  }
  if (h.event === 'summoned' && !summonMatches(h.how, when.how)) return false;
  // "If this card attacked or was attacked": either monster in the battle.
  if (h.event === 'damage_step_end' && when.self) return h.card === card || h.target === card;
  if (when.self && h.card !== card) return false;
  return !when.filter || fits(state, h.card, when.filter, seat);
}

/** Every FLIP effect waits for its own card to be flipped face-up, and never misses the timing. */
const FLIP: When = { event: 'flipped', self: true, filter: null, how: [], canMiss: false, by: null, targeting: null };

/** A trigger that fired and isn't on the chain yet. */
export interface PendingTrigger {
  player: Seat;
  card: string;
  effect: number;
  mandatory: boolean;
  cause: Happening;
}

/**
 * The triggers waiting to go on the chain, in the order they go: the turn player's mandatory ones, the opponent's,
 * then the turn player's optional ones and the opponent's (simultaneous effects go on the chain, "SEGOC"). A trigger
 * whose script can't do what it must on this board doesn't fire; a player who passed declines their optional ones.
 * FLIP effects are triggers too, and still go on the chain if their monster left the field after it was flipped
 * (destroyed by the battle that flipped it).
 */
export function pendingTriggers(state: DuelState): PendingTrigger[] {
  const step = state.step;
  if (step.at !== 'triggers' || state.happened.length === 0) return [];
  // What happened during the last link to resolve, or since the last chain (nothing happens between a chain's last
  // link and its triggers).
  const last = state.resolvedLinks - 1;
  const found: PendingTrigger[] = [];
  for (const id of Object.keys(state.instances)) {
    const sheet = state.sheets[cardOf(state, id).code];
    const at = locate(state, id);
    if (!sheet || !at) continue;
    sheet.effects.forEach((effect, index) => {
      const flip = effect.kind === 'flip';
      const when = flip ? FLIP : effect.when;
      if ((effect.kind !== 'trigger' && !flip) || !when || when.event === 'activated') return;
      if (step.handled.includes(`${id}:${index}`) || (!effect.mandatory && step.passed.includes(at.seat))) return;
      // A monster whose effects are negated triggers nothing.
      const onField = at.zone === 'monsters' || at.zone === 'spellTraps' ? state.players[at.seat][at.zone][at.index]! : null;
      const place = onField ? effect.from === 'field' && onField.faceUp && !negated(state, id) : flip ? !flipNegatedByBattle(state, id) : at.zone === effect.from;
      if (!place || lockProblem(state, at.seat, id, index) || !onceOk(state, id, sheet.code, index, effect.opt) || ruledIllegal(state, at.seat, id, index)) return;
      const cause = state.happened.find((h) => (!when.canMiss || h.group >= last) && whenMatches(state, when, h, id, at.seat));
      if (!cause || scriptProblem(state, at.seat, id, index, cause)) return;
      found.push({ player: at.seat, card: id, effect: index, mandatory: effect.mandatory, cause });
    });
  }
  const rank = (t: PendingTrigger) => (t.mandatory ? 0 : 2) + (t.player === state.turnPlayer ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}

/** The event that puts a trigger on the chain. */
export function triggerEvent(t: PendingTrigger): DuelEvent[] {
  return [{ type: 'effectActivated', player: t.player, card: t.card, effect: t.effect, zone: null, cause: t.cause }];
}

/**
 * What the duel needs next, for the server to do:
 * - `events`: code-only steps to commit (triggers done, the attack's damage, the next turn);
 * - `trigger`: activate a mandatory trigger (with its script or the judge), then come back;
 * - `resolve`: resolve the chain's last link;
 * - `wait`: a player must act. `autoPass` when they have nothing they could activate, so the server passes for them;
 *   `floor` when that pass must wait out the response time floor, so its speed reveals nothing (not needed when the
 *   player is the one whose own action opened the window).
 */
export type Next =
  | { kind: 'events'; events: DuelEvent[] }
  | { kind: 'trigger'; trigger: PendingTrigger }
  | { kind: 'resolve' }
  | { kind: 'wait'; player: Seat; autoPass: boolean; floor: boolean };

export function nextStep(state: DuelState): Next | null {
  if (state.result) return null;
  const step = state.step;
  switch (step.at) {
    // Deciding who goes first waits on the players' own picks; nothing happens by itself.
    case 'rps':
    case 'order':
      return null;
    case 'open':
      return { kind: 'wait', player: state.turnPlayer, autoPass: false, floor: false };
    case 'triggers': {
      const first = pendingTriggers(state)[0];
      if (!first) return { kind: 'events', events: [{ type: 'triggersDone' }] };
      return first.mandatory ? { kind: 'trigger', trigger: first } : { kind: 'wait', player: first.player, autoPass: false, floor: false };
    }
    case 'respond': {
      const canAct = legalActions(state, step.priority).some((a) => a.type === 'activate');
      return { kind: 'wait', player: step.priority, autoPass: !canAct, floor: step.priority !== step.actor };
    }
    case 'resolve': {
      const link = state.chain.at(-1)!;
      const by = taxedBy(state, link);
      if (by) return { kind: 'events', events: [{ type: 'taxDemanded', player: link.player, by }] };
      // A negated activation resolves doing nothing, so code finishes it.
      return link.negated ? { kind: 'events', events: [{ type: 'linkResolved' }] } : { kind: 'resolve' };
    }
    case 'continue':
      return { kind: 'events', events: continuation(state, step.then) };
    case 'replace':
    case 'tax':
      return { kind: 'wait', player: step.player, autoPass: false, floor: false };
  }
}

/** Who the duel waits on in a triggers step or a response window, as a player's view (or a spectator's, null) shows it. */
export function waitingFor(state: DuelState, seat: Seat | null): { player: Seat; for: 'respond' | 'triggers' | 'replace' | 'tax'; cause: string | null } | null {
  const step = state.step;
  if (step.at === 'replace') return { player: step.player, for: 'replace', cause: cardOf(state, step.card).name };
  if (step.at === 'tax') return { player: step.player, for: 'tax', cause: cardOf(state, step.by).name };
  if (step.at === 'respond') {
    // With a chain building, players respond to its last link.
    const last = state.chain.at(-1);
    return { player: step.priority, for: 'respond', cause: last ? `the activation of ${cardOf(state, last.card).name}` : describeCause(state, step.cause) };
  }
  if (step.at !== 'triggers') return null;
  const first = pendingTriggers(state)[0];
  if (!first || first.mandatory) return null;
  // The opponent sees a plain wait: whether a trigger is waiting in a hidden place is not theirs to know.
  return { player: first.player, for: first.player === seat ? 'triggers' : 'respond', cause: null };
}

/** "Axe Raider's attack", for the response prompt. Every event here is public. */
export function describeCause(state: DuelState, cause: Happening | null): string | null {
  if (!cause) return null;
  const name = (id: string) => cardOf(state, id).name;
  switch (cause.event) {
    case 'summoned':
      return `the ${summonName[cause.how]} Summon of ${name(cause.card)}`;
    case 'attack_declared':
      return `${name(cause.card)}'s attack${cause.target ? ` on ${locate(state, cause.target)?.zone === 'monsters' && !isFaceDown(state, cause.target) ? name(cause.target) : 'a face-down monster'}` : ' directly'}`;
    case 'phase':
      return `the start of ${state.players[cause.player].name}'s ${PHASE_NAMES[cause.phase]}`;
    case 'attacked':
      return `the attack on ${isFaceDown(state, cause.card) ? 'a face-down monster' : name(cause.card)}`;
    case 'destroyed_by_battle':
      return `the destruction of ${name(cause.card)}`;
    case 'battle_destroying':
      return `${name(cause.card)} destroying ${name(cause.target)} by battle`;
    case 'battle_damage':
      return `the battle damage ${name(cause.card)} inflicted`;
    case 'activated':
      return `the activation of ${name(cause.card)}`;
    case 'destroyed_by_effect':
      return `the destruction of ${name(cause.card)}`;
    case 'damage_step_start':
      return `the start of the Damage Step`;
    case 'damage_step_end':
      return `the end of the Damage Step`;
    case 'sent_to_graveyard':
      return `${name(cause.card)} going to the GY`;
    case 'flipped':
      return `${name(cause.card)} being flipped face-up`;
  }
}

const isFaceDown = (state: DuelState, id: string) => {
  const at = locate(state, id)!;
  return at.zone === 'monsters' && !state.players[at.seat].monsters[at.index]!.faceUp;
};
