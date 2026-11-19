// Continuous effects (see Continuous in types.ts) and the stats they change. Nothing here is stored: every read derives
// what applies from the cards face-up on the field now, so an effect stops the moment its card leaves or its
// condition fails.

import { cardsFitting, conditionProblem, fits, materialsOf } from './script.ts';
import { levelOf, locate } from './state.ts';
import type { Continuous, DuelState, Seat } from './types.ts';

/** A continuous effect in force: the card it comes from, that card's controller, and what it does. */
export interface InForce {
  source: string;
  seat: Seat;
  effect: Continuous;
}

/**
 * The continuous effects of every face-up card on the field whose conditions hold. A Spell or Trap applies once its
 * activation has resolved, not while it waits on the chain.
 */
export function inForce(state: DuelState): InForce[] {
  const found: InForce[] = [];
  for (const seat of [0, 1] as const) {
    for (const zone of ['monsters', 'spellTraps'] as const) {
      for (const c of state.players[seat][zone]) {
        if (!c?.faceUp || (zone === 'spellTraps' && state.chain.some((l) => l.card === c.id))) continue;
        const sheet = state.sheets[state.instances[c.id]!.code];
        for (const e of sheet?.effects ?? []) {
          if (e.kind !== 'continuous' || !e.continuous || e.status === 'flagged') continue;
          if (e.continuous.while.every((w) => !conditionProblem(state, w, seat, c.id))) found.push({ source: c.id, seat, effect: e.continuous });
        }
      }
    }
  }
  return found;
}

/** The continuous effects in force on a face-up monster. */
export function inForceOn(state: DuelState, id: string): InForce[] {
  const at = locate(state, id);
  if (at?.zone !== 'monsters' || !state.players[at.seat].monsters[at.index]!.faceUp) return [];
  return inForce(state).filter((f) => (f.effect.to === 'self' ? f.source === id : fits(state, id, f.effect.to, f.seat)));
}

/** How many times a stat change applies: once, or once per card that fits `per` or per Xyz Material of its card. */
function times(state: DuelState, f: InForce): number {
  const per = f.effect.per;
  return per === null ? 1 : per === 'materials' ? materialsOf(state, f.source).length : cardsFitting(state, per, f.seat, '').length;
}

/**
 * A face-up monster's current Level: the printed one (none for an Xyz Monster), a continuous "becomes", then
 * modifiers in order (a set Level overrides earlier ones), then continuous gains and losses. Never below 1. Kept apart
 * from ATK and DEF, so an effect that counts monsters of a Level (Tenshin) never needs its own ATK to do so.
 */
export function levelNow(state: DuelState, id: string): number | null {
  const effects = inForceOn(state, id);
  let level = levelOf(state.cards[state.instances[id]!.code]!);
  for (const f of effects) if (level !== null && f.effect.levelSet !== null) level = f.effect.levelSet;
  for (const m of state.modifiers) {
    if (m.card !== id) continue;
    if (m.levelSet !== null) level = m.levelSet;
    if (level !== null) level = Math.max(1, level + m.levelDelta);
  }
  for (const f of effects) if (level !== null) level = Math.max(1, level + f.effect.levelDelta);
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
  for (const f of inForceOn(state, id)) {
    if (!f.effect.atk && !f.effect.def) continue;
    const n = times(state, f);
    atkDelta += f.effect.atk * n;
    defDelta += f.effect.def * n;
  }
  return { atk: Math.max(0, atk + atkDelta), def: Math.max(0, def + defDelta), level: levelNow(state, id) };
}
