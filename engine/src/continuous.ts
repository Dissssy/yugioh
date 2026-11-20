// Continuous effects (see Continuous in types.ts): the stats they change and what they stop monsters doing. Nothing
// here is stored: every read derives what applies from the cards face-up on the field now, so an effect stops the
// moment its card leaves or its condition fails.

import { cardsFitting, conditionProblem, fits, identityFits, materialsOf } from './script.ts';
import { levelOf, locate } from './state.ts';
import type { CardFilter, ChainLink, Continuous, DuelState, FieldCard, Restriction, Seat } from './types.ts';

type Applied = Extract<Continuous, { apply: 'stats' | 'restrict' | 'battle' | 'lock' | 'negate_battled_flips' | 'extra_normal_summon' | 'discard_or_negate' }>;
type Stats = Extract<Continuous, { apply: 'stats' }>;
export type Restrict = Extract<Continuous, { apply: 'restrict' }>;
type Battle = Extract<Continuous, { apply: 'battle' }>;
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

/** The continuous effects that apply to cards and players now: those whose `while` conditions hold. */
export function inForce(state: DuelState): InForce[] {
  return continuousOnField(state).filter(
    (f): f is InForce => 'while' in f.effect && f.effect.while.every((w) => !conditionProblem(state, w, f.seat, f.source)),
  );
}

/** Whether an effect in force applies to this card. */
function affects(state: DuelState, f: InForce<Stats | Restrict | Battle>, id: string): boolean {
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

/** How many times a stat change applies: once, or once per card that fits `per` or per Xyz Material of its card. */
function times(state: DuelState, f: InForce<Stats>): number {
  const per = f.effect.per;
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

/** The battle changes in force on a face-up monster. */
function battleOn(state: DuelState, id: string): Battle[] {
  return inForce(state).flatMap((f) => (f.effect.apply === 'battle' && affects(state, f as InForce<Battle>, id) ? [f.effect] : []));
}

/** How many attacks a monster can declare each Battle Phase: 1, or more if an effect says so (Hayabusa Knight). */
export const attacksAllowed = (state: DuelState, id: string) => Math.max(1, ...battleOn(state, id).map((b) => b.attacks));
/** Whether a monster attacking a Defense Position monster inflicts piercing battle damage. */
export const piercing = (state: DuelState, id: string) => battleOn(state, id).some((b) => b.piercing);
/** Whether its controller takes no battle damage from attacks involving this monster (Fortress Warrior). */
export const shieldsBattleDamage = (state: DuelState, id: string) => battleOn(state, id).some((b) => b.noDamageToYou);

/** The locks in force on a player. */
function locksOn(state: DuelState, seat: Seat): InForce<Lock>[] {
  return inForce(state).filter(
    (f): f is InForce<Lock> => f.effect.apply === 'lock' && (f.effect.player === 'both' || (f.effect.player === 'you') === (f.seat === seat)),
  );
}

/**
 * Why a lock stops the player activating this card's effects now (Mind Drain, Medium of the Ice Barrier, Warlock of
 * the Ice Barrier); null if none does. A `perTurn` lock counts the player's activations this turn of cards that fit.
 */
export function lockProblem(state: DuelState, seat: Seat, id: string): string | null {
  const card = state.cards[state.instances[id]!.code]!;
  const at = locate(state, id)!;
  const set = at.zone === 'spellTraps' && !state.players[at.seat].spellTraps[at.index]!.faceUp;
  // A player knows their own Set cards, so a lock on Spells applies to a Set Spell too.
  const fitting = (filter: CardFilter, lockSeat: Seat) =>
    set
      ? identityFits(card, filter) && ['any', 'field', 'spellTraps'].includes(filter.place) && (filter.side === 'either' || (filter.side === 'you') === (at.seat === lockSeat))
      : fits(state, id, filter, lockSeat);
  for (const f of locksOn(state, seat)) {
    const lock = f.effect;
    if (lock.cannot !== 'activate' || (lock.filter && !fitting(lock.filter, f.seat))) continue;
    const by = state.cards[state.instances[f.source]!.code]!.name;
    if (lock.perTurn !== null) {
      const used = state.usedThisTurn.filter((u) => {
        const kind = state.sheets[u.code]?.effects[u.effect]?.kind;
        return u.player === seat && kind !== 'condition' && kind !== 'continuous' && (!lock.filter || identityFits(state.cards[u.code]!, lock.filter));
      }).length;
      if (used >= lock.perTurn) return `${by} allows only ${lock.perTurn} such activation${lock.perTurn === 1 ? '' : 's'} each turn.`;
      continue;
    }
    if (lock.setFirst) {
      if (set && state.players[at.seat].spellTraps[at.index]!.placedTurn < state.turn) continue;
      return `${by}: ${card.kind === 'spell' ? 'Spells' : 'these cards'} must be Set first and activated on a later turn.`;
    }
    return `${by} stops you activating that.`;
  }
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
  return { atk: Math.max(0, atk + atkDelta), def: Math.max(0, def + defDelta), level: levelNow(state, id) };
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
