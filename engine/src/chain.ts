// Triggers, response windows and what comes next. Code decides all of the timing: which triggers fire after an event,
// the order they go on the chain, who may respond, and when the chain resolves (docs/chains.md). Running an effect
// itself (paying, choosing, resolving) is the server's job, through scripts or the judge.

import { cardOf, continuation, legalActions, onceOk, ruledIllegal } from './rules.ts';
import { fits, scriptProblem } from './script.ts';
import { locate } from './state.ts';
import type { DuelEvent, DuelState, Happening, Seat, When } from './types.ts';

/** Whether an event is the one an effect of `card` (controlled by `seat`) waits for. */
export function whenMatches(state: DuelState, when: When, h: Happening, card: string, seat: Seat): boolean {
  // A response window opened by an attack answers the attack and the targeting alike.
  if (when.event === 'attacked' && h.event === 'attack_declared' && h.target) {
    return whenMatches(state, when, { event: 'attacked', card: h.target, player: h.player === 0 ? 1 : 0, attacker: h.card, group: h.group }, card, seat);
  }
  if (h.event === 'phase' || when.event !== h.event) return false;
  if (h.event === 'summoned' && when.how.length > 0 && !when.how.includes(h.how)) return false;
  if (when.self && h.card !== card) return false;
  return !when.filter || fits(state, h.card, when.filter, seat);
}

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
      const when = effect.when;
      if (effect.kind !== 'trigger' || !when || when.event === 'activated') return;
      if (step.handled.includes(`${id}:${index}`) || (!effect.mandatory && step.passed.includes(at.seat))) return;
      const place = at.zone === 'monsters' || at.zone === 'spellTraps' ? when.from === 'field' && state.players[at.seat][at.zone][at.index]!.faceUp : at.zone === when.from;
      if (!place || !onceOk(state, id, sheet.code, index, effect.opt) || ruledIllegal(state, at.seat, id, index)) return;
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
    case 'resolve':
      return { kind: 'resolve' };
    case 'continue':
      return { kind: 'events', events: continuation(state, step.then) };
  }
}

/** Who the duel waits on in a triggers step or a response window, as a player's view shows it. */
export function waitingFor(state: DuelState, seat: Seat): { player: Seat; for: 'respond' | 'triggers'; cause: string | null } | null {
  const step = state.step;
  if (step.at === 'respond') return { player: step.priority, for: 'respond', cause: describeCause(state, step.cause) };
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
      return `the ${cause.how === 'normal' ? 'Normal' : cause.how === 'flip' ? 'Flip' : 'Special'} Summon of ${name(cause.card)}`;
    case 'attack_declared':
      return `${name(cause.card)}'s attack${cause.target ? ` on ${locate(state, cause.target)?.zone === 'monsters' && !isFaceDown(state, cause.target) ? name(cause.target) : 'a face-down monster'}` : ' directly'}`;
    case 'phase':
      return `the start of ${state.players[cause.player].name}'s ${cause.phase === 'battle' ? 'Battle Phase' : 'End Phase'}`;
    case 'attacked':
      return `the attack on ${isFaceDown(state, cause.card) ? 'a face-down monster' : name(cause.card)}`;
    case 'destroyed_by_battle':
      return `the destruction of ${name(cause.card)}`;
    case 'battle_damage':
      return `the battle damage ${name(cause.card)} inflicted`;
  }
}

const isFaceDown = (state: DuelState, id: string) => {
  const at = locate(state, id)!;
  return at.zone === 'monsters' && !state.players[at.seat].monsters[at.index]!.faceUp;
};
