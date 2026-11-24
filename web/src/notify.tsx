// Desktop notifications from the player's duel feed (duelFeed.tsx): their turn, an answer needed, a challenge accepted,
// an opponent ready. They work from any page and from a background tab while the site is open. The Discord Activity
// runs in a frame that can't ask for permission, so there they are off and the setting is hidden.

import type { DuelSummary } from '@yugioh/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { duelSettings, useDuelSettings } from './board/settings.ts';
import { inActivity } from './discord.ts';
import { play } from './sound.ts';

/** Whether this browser can show notifications here. */
export const canNotify = !inActivity && 'Notification' in window;

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

/** The key browsers subscribe to Web Push with, or null when the server sends none (or this browser can't get them). */
function usePushKey(): string | null {
  const key = useQuery({
    queryKey: ['push'],
    queryFn: () => api<{ publicKey: string }>('/push').then((r) => r.publicKey, () => null),
    enabled: canNotify && 'serviceWorker' in navigator && 'PushManager' in window,
    staleTime: Infinity,
  });
  return key.data ?? null;
}

/** Subscribes this browser to Web Push for the player, or ends its subscription. */
async function setPush(on: boolean, publicKey: string) {
  const worker = await navigator.serviceWorker.register('/sw.js');
  const existing = await worker.pushManager.getSubscription();
  if (!on) {
    if (!existing) return;
    await api('/me/push', { method: 'DELETE', body: JSON.stringify({ endpoint: existing.endpoint }) });
    await existing.unsubscribe();
    return;
  }
  const subscription = existing ?? (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
  await api('/me/push', { method: 'PUT', body: JSON.stringify(subscription.toJSON()) });
}

/** With notifications on, keeps this browser's Web Push subscription with whoever is playing here now. */
export function usePushSync(enabled: boolean) {
  const pushKey = usePushKey();
  const [settings] = useDuelSettings();
  const on = enabled && pushKey !== null && settings.notify && Notification.permission === 'granted';
  useEffect(() => {
    if (on) setPush(true, pushKey).catch((error: unknown) => console.error('Web Push subscription failed:', error));
  }, [on, pushKey]);
}

/**
 * The switch for desktop notifications, which asks the browser's permission when turned on. Where the server sends Web
 * Push, it also subscribes this browser, so notifications arrive with the site closed.
 */
export function NotifySetting() {
  const [settings, update] = useDuelSettings();
  const [permission, setPermission] = useState(canNotify ? Notification.permission : 'denied');
  const pushKey = usePushKey();
  const [failed, setFailed] = useState(false);
  if (!canNotify) return null;
  const on = settings.notify && permission === 'granted';
  const toggle = async (want: boolean) => {
    if (want && permission !== 'granted') {
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== 'granted') return;
    }
    update({ notify: want });
    if (!pushKey) return;
    try {
      await setPush(want, pushKey);
      setFailed(false);
    } catch (error) {
      console.error('Web Push subscription failed:', error);
      setFailed(true);
    }
  };
  return (
    <label>
      <input type="checkbox" checked={on} disabled={permission === 'denied'} onChange={(e) => void toggle(e.target.checked)} /> Desktop notifications
      {permission === 'denied' ? (
        <span className="muted small"> (blocked: allow notifications for this site in your browser's settings)</span>
      ) : (
        <span className="muted small"> when a duel waits on you{pushKey ? ', even with the site closed' : ', while the site is open in a tab'}</span>
      )}
      {failed && <span className="error small"> Couldn't turn on notifications with the site closed; they still work while it's open.</span>}
    </label>
  );
}
