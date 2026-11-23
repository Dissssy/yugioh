// Fusion Summons. A Fusion Monster's sheet lists its materials (`Materials` with summon "fusion"), and an effect such
// as Polymerization Fusion Summons it with the `fusion_summon` step: its controller picks the Fusion Monster, then
// the materials one by one, from the places the step allows. The materials go to the GY.

import { nameOf } from './continuous.ts';
import { identityFits, specialSummonForbidden } from './script.ts';
import { monsterZonesFor } from './state.ts';
import type { DuelState, FusionMaterial, FusionPlace, Materials, Seat } from './types.ts';

type Fusion = Extract<Materials, { summon: 'fusion' }>;

/** The materials a Fusion Monster's sheet lists, or null if it isn't one. */
export function fusionOf(state: DuelState, id: string): Fusion | null {
  const materials = state.sheets[state.instances[id]!.code]?.materials;
  return materials?.summon === 'fusion' ? materials : null;
}

/** Whether a card fits one material: a card name (as the card is now named), or a description. */
function fitsMaterial(state: DuelState, id: string, material: FusionMaterial): boolean {
  const card = state.cards[state.instances[id]!.code]!;
  if (card.kind !== 'monster') return false;
  return typeof material === 'string' ? nameOf(state, id) === material : identityFits(card, material, nameOf(state, id));
}

/** The player's monsters that may be materials, from the places the step allows. A face-down monster may be one. */
export function fusionCandidates(state: DuelState, seat: Seat, from: FusionPlace[]): string[] {
  const p = state.players[seat];
  const isMonster = (id: string) => state.cards[state.instances[id]!.code]!.kind === 'monster';
  return from.flatMap((place) => (place === 'field' ? p.monsters.flatMap((m) => (m ? [m.id] : [])) : (place === 'hand' ? p.hand : place === 'deck' ? p.deck : p.graveyard).filter(isMonster)));
}

/** Whether these cards, each used once, can fill every one of the materials (a matching found by backtracking). */
function covers(state: DuelState, cards: string[], materials: FusionMaterial[]): boolean {
  if (cards.length !== materials.length) return false;
  const used = new Set<string>();
  const fill = (i: number): boolean => {
    if (i === materials.length) return true;
    for (const id of cards) {
      if (used.has(id) || !fitsMaterial(state, id, materials[i]!)) continue;
      used.add(id);
      if (fill(i + 1)) return true;
      used.delete(id);
    }
    return false;
  };
  return fill(0);
}

/** The zones a Fusion Monster may go to once these monsters have left the field. */
export function fusionZones(state: DuelState, seat: Seat, leaving: string[]): number[] {
  const players = state.players.map((p) => ({ ...p, monsters: p.monsters.map((m) => (m && leaving.includes(m.id) ? null : m)) })) as DuelState['players'];
  return monsterZonesFor({ ...state, players }, seat, true);
}

/**
 * The cards that can be the next material for this Fusion Monster, given those already picked: each leaves a way to
 * finish the set that also leaves the monster a zone.
 */
export function fusionMaterialOptions(state: DuelState, seat: Seat, fusion: string, from: FusionPlace[], picked: string[]): string[] {
  const materials = fusionOf(state, fusion)?.materials ?? [];
  const pool = fusionCandidates(state, seat, from);
  return pool.filter((id) => !picked.includes(id) && hasZoneAfter(state, seat, [...picked, id], pool, materials));
}

/** Whether `picked` can be finished into a full set of materials from `pool` that leaves the Fusion Monster a zone. */
function hasZoneAfter(state: DuelState, seat: Seat, picked: string[], pool: string[], materials: FusionMaterial[]): boolean {
  const rest = pool.filter((id) => !picked.includes(id));
  const go = (from: number, chosen: string[]): boolean => {
    if (chosen.length === materials.length) return covers(state, chosen, materials) && fusionZones(state, seat, chosen).length > 0;
    for (let i = from; i < rest.length; i++) if (go(i + 1, [...chosen, rest[i]!])) return true;
    return false;
  };
  return go(0, picked);
}

/** The Fusion Monsters in the player's Extra Deck they can Fusion Summon now with materials from these places. */
export function fusionMonsters(state: DuelState, seat: Seat, from: FusionPlace[]): string[] {
  return state.players[seat].extra.filter((id) => fusionOf(state, id) && !specialSummonForbidden(state, seat, id) && fusionMaterialOptions(state, seat, id, from, []).length > 0);
}

/** Whether these cards are a full, valid set of materials for the Fusion Monster. */
export function fusionMaterialsFit(state: DuelState, seat: Seat, fusion: string, from: FusionPlace[], cards: string[]): boolean {
  const materials = fusionOf(state, fusion)?.materials;
  const pool = fusionCandidates(state, seat, from);
  return !!materials && new Set(cards).size === cards.length && cards.every((id) => pool.includes(id)) && covers(state, cards, materials);
}
