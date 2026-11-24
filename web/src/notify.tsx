// Desktop notifications from the player's duel feed (duelFeed.tsx): their turn, an answer needed, a challenge accepted,
// an opponent ready. They work from any page and from a background tab while the site is open. The Discord Activity
// runs in a frame that can't ask for permission, so there they are off and the setting is hidden.

import type { DuelSummary } from '@yugioh/shared';
import { useState } from 'react';
import { useDuelSettings, duelSettings } from './board/settings.ts';
import { inActivity } from './discord.ts';
import { play } from './sound.ts';

/** Whether this browser can show notifications here. */
export const canNotify = !inActivity && 'Notification' in window;

/** What changed in a duel that its player should hear about, or null. `before` is the summary they had. */
export function newsOf(before: DuelSummary | undefined, after: DuelSummary): string | null {
  if (after.yourSeat === null) return null;
  const opponent = after.players[after.yourSeat === 0 ? 1 : 0]?.name ?? 'Your opponent';
  if (before?.status === 'waiting' && after.status === 'preparing') return `${opponent} accepted your challenge. Choose your deck.`;
  if (before?.status === 'preparing' && after.status === 'active') return `Your duel against ${opponent} has started.`;
  if (after.yourMove !== null && after.yourMove !== before?.yourMove) {
    if (after.yourMove === 'turn') return `Your turn against ${opponent}.`;
    if (after.yourMove === 'answer') return `${opponent} is waiting on your answer.`;
  }
  const them = after.yourSeat === 0 ? 1 : 0;
  if (after.status === 'preparing' && after.players[them]?.ready && before?.players[them]?.ready === false) return `${opponent} is ready.`;
  return null;
}

/**
 * Tells the player `news` about a duel: a ping, and a desktop notification when they have them on and aren't `looking`
 * at that duel already. A duel being played makes its own sounds on its board. Clicking the notification opens it.
 */
export function tell(duel: DuelSummary, news: string, looking: boolean, open: () => void) {
  if (looking && duel.status === 'active') return;
  play('answer');
  if (looking || !canNotify || !duelSettings().notify || Notification.permission !== 'granted') return;
  const notification = new Notification('Yu-Gi-Oh Duels', { body: news, tag: duel.id });
  notification.onclick = () => {
    window.focus();
    open();
    notification.close();
  };
}

/** The switch for desktop notifications, which asks the browser's permission when turned on. */
export function NotifySetting() {
  const [settings, update] = useDuelSettings();
  const [permission, setPermission] = useState(canNotify ? Notification.permission : 'denied');
  if (!canNotify) return null;
  const on = settings.notify && permission === 'granted';
  const toggle = async (want: boolean) => {
    if (want && permission !== 'granted') {
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== 'granted') return;
    }
    update({ notify: want });
  };
  return (
    <label>
      <input type="checkbox" checked={on} disabled={permission === 'denied'} onChange={(e) => void toggle(e.target.checked)} /> Desktop notifications
      {permission === 'denied' ? (
        <span className="muted small"> (blocked: allow notifications for this site in your browser's settings)</span>
      ) : (
        <span className="muted small"> when a duel waits on you, while the site is open in a tab</span>
      )}
    </label>
  );
}
