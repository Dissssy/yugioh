// Continuous effects (see Continuous in types.ts): the stats they change and what they stop monsters doing. Nothing
// here is stored: every read derives what applies from the cards face-up on the field now, so an effect stops the
// moment its card leaves or its condition fails.

import { cardsFitting, conditionProblem, fits, identityFits, materialsOf } from './script.ts';
import { levelOf, locate } from './state.ts';
import type { CardFilter, ChainLink, Continuous, DuelState, FieldCard, Restriction, Seat } from './types.ts';

type Applied = Extract<Continuous, { apply: 'stats' | 'restrict' | 'battle' | 'force_position' | 'lock' | 'negate_battled_flips' | 'extra_normal_summon' | 'discard_or_negate' }>;
type Stats = Extract<Continuous, { apply: 'stats' }>;
export type Restrict = Extract<Continuous, { apply: 'restrict' }>;
type Battle = Extract<Continuous, { apply: 'battle' }>;
type ForcePosition = Extract<Continuous, { apply: 'force_position' }>;
type Lock = Extract<Continuous, { apply: 'lock' }>;

/** A continuous effect in force: the card it comes from, that card's controller, the effect's index, and what it does. */
export interface InForce<C extends Continuous = Applied> {
  source: string;
  seat: Seat;
  index: number;
  effect: C;
}

/** Face-up cards on the field, with their controllers. A Spell or Trap still on the chain hasn't resolved yet. */
function faceUpOnField(state: DuelState): { card: FieldCard; seat: Seat }[] {
  return ([0, 1] as const).flatMap((seat) =>
    (['monsters', 'spellTraps'] as const).flatMap((zone) =>
      state.players[seat][zone].flatMap((card) => (card?.faceUp && !(zone === 'spellTraps' && state.chain.some((l) => l.card === card.id)) ? [{ card, seat }] : [])),
    ),
  );
}

/**
 * Whether a card on the field has its effects negated: by a resolved effect, or by a card tied to it whose effect
 * negates it (Fiendish Chain). The tying card's own negation counts only when a resolved effect did it, so two such
 * cards can't negate each other in a loop.
 */
export function negated(state: DuelState, id: string): boolean {
  const at = locate(state, id);
  if (at?.zone !== 'monsters' && at?.zone !== 'spellTraps') return false;
  if (state.players[at.seat][at.zone][at.index]!.effectsNegated) return true;
  return faceUpOnField(state).some(
    ({ card }) =>
      card.linked === id &&
      !card.effectsNegated &&
      (state.sheets[state.instances[card.id]!.code]?.effects ?? []).some((e) => e.continuous?.apply === 'negate_linked' && e.status !== 'flagged'),
  );
}

/** Every continuous effect on a face-up card on the field whose effects aren't negated. */
export function continuousOnField(state: DuelState): InForce<Continuous>[] {
  return faceUpOnField(state).flatMap(({ card, seat }) =>
    negated(state, card.id)
      ? []
      : (state.sheets[state.instances[card.id]!.code]?.effects ?? []).flatMap((e, index) =>
          e.kind === 'continuous' && e.continuous && e.status !== 'flagged' ? [{ source: card.id, seat, index, effect: e.continuous }] : [],
        ),
  );
}

/**
 * The continuous effects that apply to cards and players now: those whose `while` conditions hold, and the abilities
 * `grant` steps gave monsters this turn.
 */
export function inForce(state: DuelState): InForce[] {
  const own = continuousOnField(state).filter(
    (f): f is InForce => 'while' in f.effect && f.effect.while.every((w) => !conditionProblem(state, w, f.seat, f.source)),
  );
  return [...own, ...granted(state)];
}

/** The abilities granted to face-up monsters this turn, each as a continuous effect on the monster itself. */
function granted(state: DuelState): InForce[] {
  return state.granted.flatMap(({ card, effect: g }): InForce[] => {
    const at = locate(state, card);
    if (at?.zone !== 'monsters' || !state.players[at.seat].monsters[at.index]!.faceUp) return [];
    const effect: Applied =
      g.apply === 'restrict'
        ? { apply: 'restrict', to: 'self', others: false, cannot: g.cannot, by: null, compare: null, once: false, while: [] }
        : { apply: 'battle', to: 'self', attacks: g.attacks, piercing: g.piercing, noDamageToYou: false, direct: g.direct, while: [] };
    return [{ source: card, seat: at.seat, index: -1, effect }];
  });
}

/** The face-up monsters a `force_position` effect in force holds in another position than they are in, with that position. */
export function positionsToForce(state: DuelState): { card: string; position: 'attack' | 'defense' }[] {
  const forcing = inForce(state).filter((f): f is InForce<ForcePosition> => f.effect.apply === 'force_position');
  if (forcing.length === 0) return [];
  return ([0, 1] as const).flatMap((seat) =>
    state.players[seat].monsters.flatMap((m) => {
      const f = m?.faceUp ? forcing.find((f) => affects(state, f, m.id)) : undefined;
      return m && f && m.position !== f.effect.position ? [{ card: m.id, position: f.effect.position }] : [];
    }),
  );
}

/** Whether an effect in force applies to this card. */
function affects(state: DuelState, f: InForce<Stats | Restrict | Battle | ForcePosition>, id: string): boolean {
  const to = f.effect.to;
  if (to === 'self') return id === f.source;
  if (to === 'linked') {
    const at = locate(state, f.source);
    return at?.zone === 'spellTraps' && state.players[at.seat].spellTraps[at.index]!.linked === id;
  }
  if (f.effect.apply === 'restrict' && f.effect.others && id === f.source) return false;
  return fits(state, id, to, f.seat);
}

/**
 * How many Xyz Materials this face-up monster can detach instead of being destroyed, if a replacement of its own
 * applies and it has enough; else null.
 */
export function replacement(state: DuelState, id: string): number | null {
  const at = locate(state, id);
  if (at?.zone !== 'monsters') return null;
  const m = state.players[at.seat].monsters[at.index]!;
  const r = continuousOnField(state).find((f) => f.source === id && f.effect.apply === 'replace_destruction');
  return r?.effect.apply === 'replace_destruction' && m.materials.length >= r.effect.detach ? r.effect.detach : null;
}

/** The stat changes in force on a face-up monster. */
function statsOn(state: DuelState, id: string): InForce<Stats>[] {
  const at = locate(state, id);
  if (at?.zone !== 'monsters' || !state.players[at.seat].monsters[at.index]!.faceUp) return [];
  return inForce(state).filter((f): f is InForce<Stats> => f.effect.apply === 'stats' && affects(state, f as InForce<Stats>, id));
}

/** How many times a stat change applies: once, or once per card that fits `per`, per Xyz Material of its card, or per counter on it. */
function times(state: DuelState, f: InForce<Stats>): number {
  const per = f.effect.per;
  if (per === 'counters') {
    const at = locate(state, f.source);
    const card = at && (at.zone === 'monsters' || at.zone === 'spellTraps') ? state.players[at.seat][at.zone][at.index] : null;
    return Object.values(card?.counters ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  }
  return per === null ? 1 : per === 'materials' ? materialsOf(state, f.source).length : cardsFitting(state, per, f.seat, '').length;
}

/**
 * The continuous effect that stops this card doing `what`, if one does. `against` is the monster it battles, for
 * `be_destroyed_by_battle`, or the card whose effect it is, for `be_destroyed_by_effect` and `be_affected`. A `once`
 * effect already used this turn stops nothing.
 */
export function restriction(state: DuelState, id: string, what: Restriction, against: string | null = null): InForce<Restrict> | null {
  const stat = (card: string, s: 'atk' | 'def') => statsOf(state, card)[s];
  return (
    inForce(state).find(
      (f): f is InForce<Restrict> =>
        f.effect.apply === 'restrict' &&
        f.effect.cannot.includes(what) &&
        affects(state, f as InForce<Restrict>, id) &&
        (!f.effect.by || (against !== null && fits(state, against, f.effect.by, f.seat))) &&
        (!f.effect.compare || stat(id, f.effect.compare.stat) >= stat(f.source, f.effect.compare.self)) &&
        (!f.effect.once || !state.usedThisTurn.some((u) => u.card === f.source && u.effect === f.index)),
    ) ?? null
  );
}

export const restricted = (state: DuelState, id: string, what: Restriction, against: string | null = null) => restriction(state, id, what, against) !== null;

/** The LP a monster's own effect makes it pay to attack (Dark Elf); 0 for most. */
export const attackCost = (state: DuelState, id: string) =>
  continuousOnField(state).reduce((sum, f) => sum + (f.source === id && f.effect.apply === 'attack_cost' ? f.effect.lp : 0), 0);

/** The monsters of `seat`'s opponent that `seat`'s monsters may only attack (Ring of Magnetism); empty when none lures them. */
export function lures(state: DuelState, seat: Seat): string[] {
  const foe = seat === 0 ? 1 : 0;
  return continuousOnField(state).flatMap((f) => {
    if (f.effect.apply !== 'lure' || f.seat !== foe) return [];
    const at = locate(state, f.source)!;
    const id = f.effect.to === 'self' ? f.source : at.zone === 'spellTraps' ? state.players[at.seat].spellTraps[at.index]!.linked : null;
    const there = id ? locate(state, id) : null;
    return id && there?.zone === 'monsters' && there.seat === foe ? [id] : [];
  });
}

/** What this face-up monster's `mark_attackers` effects do to `attacker`, a monster that attacked it. */
export function marksFor(state: DuelState, target: string, attacker: string): { mark: 'no_attack' | 'destroy'; turns: number }[] {
  return continuousOnField(state).flatMap((f) =>
    f.source === target && f.effect.apply === 'mark_attackers' && fits(state, attacker, f.effect.filter, f.seat) ? [{ mark: f.effect.mark, turns: f.effect.turns }] : [],
  );
}

/** The battle changes in force on a face-up monster. */
function battleOn(state: DuelState, id: string): Battle[] {
  return inForce(state).flatMap((f) => (f.effect.apply === 'battle' && affects(state, f as InForce<Battle>, id) ? [f.effect] : []));
}

/** How many attacks a monster can declare each Battle Phase: 1, or more if an effect says so (Hayabusa Knight). */
export const attacksAllowed = (state: DuelState, id: string) => Math.max(1, ...battleOn(state, id).map((b) => b.attacks));
/** Whether a monster attacking a Defense Position monster inflicts piercing battle damage. */
export const piercing = (state: DuelState, id: string) => battleOn(state, id).some((b) => b.piercing);
/** Whether a monster can attack directly while the opponent controls monsters (Rapid Warrior). */
export const attacksDirectly = (state: DuelState, id: string) => battleOn(state, id).some((b) => b.direct);
/** Whether its controller takes no battle damage from attacks involving this monster (Fortress Warrior). */
export const shieldsBattleDamage = (state: DuelState, id: string) => battleOn(state, id).some((b) => b.noDamageToYou);

/** The locks in force on a player: from continuous effects, and those effects left behind that still hold. */
function locksOn(state: DuelState, seat: Seat): InForce<Lock>[] {
  const lingering = state.lingering.flatMap((l): InForce<Lock>[] => {
    const at = locate(state, l.source);
    const faceUp = (at?.zone === 'monsters' || at?.zone === 'spellTraps') && state.players[at.seat][at.zone][at.index]!.faceUp;
    const over = state.turn > l.untilTurn || (state.turn === l.untilTurn && state.phase === 'end');
    if (over || (l.whileFaceUp && !faceUp)) return [];
    return [{ source: l.source, seat: l.seat, index: -1, effect: { apply: 'lock', player: l.player, cannot: 'activate', filter: l.filter, perTurn: null, setFirst: false, while: [] } }];
  });
  return [...inForce(state), ...lingering].filter(
    (f): f is InForce<Lock> => f.effect.apply === 'lock' && (f.effect.player === 'both' || (f.effect.player === 'you') === (f.seat === seat)),
  );
}

/**
 * Why a lock stops the player activating this card's effects now (Mind Drain, Medium of the Ice Barrier, Warlock of
 * the Ice Barrier); null if none does. A `perTurn` lock counts the player's activations this turn of cards that fit.
 * A Spell or Trap is locked as a card ("activate 1 Spell/Trap Card"): only its activation, not the effects it has once
 * face-up; a monster's effects are locked.
 */
export function lockProblem(state: DuelState, seat: Seat, id: string, effect: number): string | null {
  const card = state.cards[state.instances[id]!.code]!;
  const cardActivation = (code: number, index: number) => state.cards[code]!.kind === 'monster' || state.sheets[code]?.effects[index]?.kind === 'activation';
  if (!cardActivation(card.code, effect)) return restrictedActivation(state, id);
  const at = locate(state, id)!;
  const set = at.zone === 'spellTraps' && !state.players[at.seat].spellTraps[at.index]!.faceUp;
  // A player knows their own Set cards, so a lock on Spells applies to a Set Spell too.
  const fitting = (filter: CardFilter, lockSeat: Seat) =>
    set
      ? identityFits(card, filter) && (!filter.places.length || filter.places.some((p) => p === 'field' || p === 'spellTraps')) && (filter.side === 'either' || (filter.side === 'you') === (at.seat === lockSeat))
      : fits(state, id, filter, lockSeat);
  for (const f of locksOn(state, seat)) {
    const lock = f.effect;
    if (lock.cannot !== 'activate' || (lock.filter && !fitting(lock.filter, f.seat))) continue;
    const by = state.cards[state.instances[f.source]!.code]!.name;
    if (lock.perTurn !== null) {
      const used = state.usedThisTurn.filter((u) => {
        const kind = state.sheets[u.code]?.effects[u.effect]?.kind;
        return u.player === seat && kind !== 'condition' && kind !== 'continuous' && cardActivation(u.code, u.effect) && (!lock.filter || identityFits(state.cards[u.code]!, lock.filter));
      }).length;
      if (used >= lock.perTurn) return `${by} allows only ${lock.perTurn} such activation${lock.perTurn === 1 ? '' : 's'} each turn.`;
      continue;
    }
    if (lock.setFirst) {
      // "Cannot activate them until their next turn": from the controller's first turn after the one it was Set on.
      if (set && state.turn > state.players[at.seat].spellTraps[at.index]!.placedTurn + (state.turnPlayer === at.seat ? 0 : 1)) continue;
      return `${by}: ${card.kind === 'spell' ? 'Spells' : 'these cards'} must be Set first and activated on a later turn.`;
    }
    return `${by} stops you activating that.`;
  }
  return restrictedActivation(state, id);
}

/** Why a restriction on the card itself stops it activating its effects (Crackdown), or null. */
function restrictedActivation(state: DuelState, id: string): string | null {
  const r = restriction(state, id, 'activate_effects');
  return r ? `${state.cards[state.instances[r.source]!.code]!.name} stops it activating its effects.` : null;
}

/** Whether the monster that destroyed `id` by battle negates its FLIP effects (Blade Knight). */
export function flipNegatedByBattle(state: DuelState, id: string): boolean {
  const negators = new Set(inForce(state).flatMap((f) => (f.effect.apply === 'negate_battled_flips' ? [f.source] : [])));
  return state.happened.some((h) => h.event === 'battle_destroying' && h.target === id && negators.has(h.card));
}

/**
 * The card that makes the controller of the resolving link discard or have it negated (General Raiho), if one does: a
 * monster effect activated on the field, against a card of the other player in force.
 */
export function taxedBy(state: DuelState, link: ChainLink): string | null {
  const card = state.cards[state.instances[link.card]!.code]!;
  const effect = state.sheets[card.code]?.effects[link.effect];
  if (link.negated || link.taxed || card.kind !== 'monster' || effect?.from !== 'field') return null;
  return inForce(state).find((f) => f.effect.apply === 'discard_or_negate' && f.seat !== link.player)?.source ?? null;
}

/** Whether a lock stops the player Tribute Summoning (Revealer of the Ice Barrier). */
export const tributeSummonLocked = (state: DuelState, seat: Seat) => locksOn(state, seat).some((f) => f.effect.cannot === 'tribute_summon');

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
  // Reverse Trap: additions subtract and subtractions add until the End Phase.
  const sign = state.statsReversed ? -1 : 1;
  return { atk: Math.max(0, atk + sign * atkDelta), def: Math.max(0, def + sign * defDelta), level: levelNow(state, id) };
}

/** A card's name now: one a continuous effect of its own gives it while it is on the field (Dupe Frog), else the printed one. */
export function nameOf(state: DuelState, id: string): string {
  const own = continuousOnField(state).find((f) => f.source === id && f.effect.apply === 'name');
  return own?.effect.apply === 'name' ? own.effect.name : state.cards[state.instances[id]!.code]!.name;
}

type SynchroMaterial = Extract<Continuous, { apply: 'synchro_material' }>;

/** What a monster on the field says about itself as Synchro Material (Quickdraw Synchron), if anything. */
export function synchroMaterialRules(state: DuelState, id: string): SynchroMaterial[] {
  return continuousOnField(state).flatMap((f) => (f.source === id && f.effect.apply === 'synchro_material' ? [f.effect] : []));
}
