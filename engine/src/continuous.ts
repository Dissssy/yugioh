// Continuous effects (see Continuous in types.ts): the stats they change and what they stop monsters doing. Nothing
// here is stored: every read derives what applies from the cards face-up on the field now, so an effect stops the
// moment its card leaves or its condition fails.

import { cardsFitting, conditionProblem, fits, materialsOf } from './script.ts';
import { levelOf, locate } from './state.ts';
import type { Continuous, DuelState, Restriction, Seat } from './types.ts';

type Applied = Exclude<Continuous, { apply: 'self_destruct' }>;
type Stats = Extract<Continuous, { apply: 'stats' }>;

/** A continuous effect in force: the card it comes from, that card's controller, and what it does. */
export interface InForce<C extends Continuous = Applied> {
  source: string;
  seat: Seat;
  effect: C;
}

/** Every continuous effect on a face-up card on the field. A Spell or Trap's apply once its activation has resolved. */
export function continuousOnField(state: DuelState): InForce<Continuous>[] {
  const found: InForce<Continuous>[] = [];
  for (const seat of [0, 1] as const) {
    for (const zone of ['monsters', 'spellTraps'] as const) {
      for (const c of state.players[seat][zone]) {
        if (!c?.faceUp || (zone === 'spellTraps' && state.chain.some((l) => l.card === c.id))) continue;
        for (const e of state.sheets[state.instances[c.id]!.code]?.effects ?? []) {
          if (e.kind === 'continuous' && e.continuous && e.status !== 'flagged') found.push({ source: c.id, seat, effect: e.continuous });
        }
      }
    }
  }
  return found;
}

/** The continuous effects that apply to cards now: those whose `while` conditions hold. */
export function inForce(state: DuelState): InForce[] {
  return continuousOnField(state).filter(
    (f): f is InForce => f.effect.apply !== 'self_destruct' && f.effect.while.every((w) => !conditionProblem(state, w, f.seat, f.source)),
  );
}

/** Whether an effect in force applies to this card. */
function affects(state: DuelState, f: InForce, id: string): boolean {
  const to = f.effect.to;
  if (to === 'self') return id === f.source;
  if (f.effect.apply === 'restrict' && f.effect.others && id === f.source) return false;
  return fits(state, id, to, f.seat);
}

/** The stat changes in force on a face-up monster. */
function statsOn(state: DuelState, id: string): InForce<Stats>[] {
  const at = locate(state, id);
  if (at?.zone !== 'monsters' || !state.players[at.seat].monsters[at.index]!.faceUp) return [];
  return inForce(state).filter((f): f is InForce<Stats> => f.effect.apply === 'stats' && affects(state, f, id));
}

/** How many times a stat change applies: once, or once per card that fits `per` or per Xyz Material of its card. */
function times(state: DuelState, f: InForce<Stats>): number {
  const per = f.effect.per;
  return per === null ? 1 : per === 'materials' ? materialsOf(state, f.source).length : cardsFitting(state, per, f.seat, '').length;
}

/**
 * Whether a continuous effect stops this card doing `what`. For `be_destroyed_by_battle`, `against` is the monster it
 * battles.
 */
export function restricted(state: DuelState, id: string, what: Restriction, against: string | null = null): boolean {
  return inForce(state).some(
    (f) =>
      f.effect.apply === 'restrict' &&
      f.effect.cannot.includes(what) &&
      affects(state, f, id) &&
      (what !== 'be_destroyed_by_battle' || !f.effect.by || (against !== null && fits(state, against, f.effect.by, f.seat))),
  );
}

/**
 * A face-up monster's current Level: the printed one (none for an Xyz Monster), a continuous "becomes", then
 * modifiers in order (a set Level overrides earlier ones), then continuous gains and losses. Never below 1. Kept apart
 * from ATK and DEF, so an effect that counts monsters of a Level (Tenshin) never needs its own ATK to do so.
 */
export function levelNow(state: DuelState, id: string): number | null {
  const effects = statsOn(state, id);
  let level = levelOf(state.cards[state.instances[id]!.code]!);
  for (const { effect: e } of effects) if (level !== null && e.levelSet !== null) level = e.levelSet;
  for (const m of state.modifiers) {
    if (m.card !== id) continue;
    if (m.levelSet !== null) level = m.levelSet;
    if (level !== null) level = Math.max(1, level + m.levelDelta);
  }
  for (const { effect: e } of effects) if (level !== null) level = Math.max(1, level + e.levelDelta);
  return level;
}

/** A face-up monster's ATK, DEF and Level now. "Becomes" sets the base (the latest wins); every gain and loss is added on top. */
export function statsOf(state: DuelState, id: string): { atk: number; def: number; level: number | null } {
  const card = state.cards[state.instances[id]!.code]!;
  let atk = card.atk ?? 0;
  let def = card.def ?? 0;
  let atkDelta = 0;
  let defDelta = 0;
  for (const m of state.modifiers) {
    if (m.card !== id) continue;
    if (m.atkSet !== null) atk = m.atkSet;
    if (m.defSet !== null) def = m.defSet;
    atkDelta += m.atk;
    defDelta += m.def;
  }
  for (const f of statsOn(state, id)) {
    if (!f.effect.atk && !f.effect.def) continue;
    const n = times(state, f);
    atkDelta += f.effect.atk * n;
    defDelta += f.effect.def * n;
  }
  return { atk: Math.max(0, atk + atkDelta), def: Math.max(0, def + defDelta), level: levelNow(state, id) };
}
