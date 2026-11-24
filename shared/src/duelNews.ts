// What a player is told about their duels, by the site while it is open (web/src/notify.tsx) and by Web Push while it
// is closed (server/src/push.ts).

import type { DuelSummary } from './api.ts';

/** What changed in a duel that its player should hear about, or null. `before` is the summary they had. */
export function newsOf(before: DuelSummary | undefined, after: DuelSummary): string | null {
  if (after.yourSeat === null) return null;
  const them = after.yourSeat === 0 ? 1 : 0;
  const opponent = after.players[them]?.name ?? 'Your opponent';
  if (!before && after.rematchOf !== null && after.status === 'preparing' && after.players[them]?.ready && !after.players[after.yourSeat]?.ready)
    return `${opponent} wants a rematch.`;
  if (before?.status === 'waiting' && after.status === 'preparing') return `${opponent} accepted your challenge. Choose your deck.`;
  if (before?.status === 'preparing' && after.status === 'active') return `Your duel against ${opponent} has started.`;
  if (after.yourMove !== null && after.yourMove !== before?.yourMove) {
    if (after.yourMove === 'turn') return `Your turn against ${opponent}.`;
    if (after.yourMove === 'answer') return `${opponent} is waiting on your answer.`;
  }
  if (after.status === 'preparing' && after.players[them]?.ready && before?.players[them]?.ready === false) return `${opponent} is ready.`;
  return null;
}
