// Text the judge or appeal writes for players must not name a card a player can't see.

import { visibleTo, type DuelState, type Seat } from '@yugioh/engine';

/**
 * The first card name in `text` that one of `seats` can't see (and sees no other copy of), or null. A name that
 * `publicText` (the text of the card being used) contains reveals nothing: "add 1 "Genex Controller" from your Deck".
 */
export function hiddenNameIn(state: DuelState, text: string, seats: Seat[], publicText = ''): string | null {
  const lower = text.toLowerCase();
  const known = publicText.toLowerCase();
  for (const seat of seats) {
    const seen = new Set<number>();
    const unseen = new Set<number>();
    for (const [id, { code }] of Object.entries(state.instances)) (visibleTo(state, id, seat) ? seen : unseen).add(code);
    for (const code of unseen) {
      if (seen.has(code)) continue;
      const name = state.cards[code]!.name;
      if (lower.includes(name.toLowerCase()) && !known.includes(name.toLowerCase())) return name;
    }
  }
  return null;
}
