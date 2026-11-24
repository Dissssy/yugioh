// The player's duels kept live from their feed (GET /api/me/duels/stream), and the ways to move between them: the
// switcher, the G key, and the count in the tab's title.

import { useQueryClient } from '@tanstack/react-query';
import type { DuelSummary, YourMove } from '@yugioh/shared';
import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useDuels } from './api.ts';
import { typing } from './board/nav.ts';
import { newsOf, tell } from './notify.tsx';

/**
 * Keeps the viewer's duels, the list and each one's own summary, up to date while they can play, and tells them when a
 * duel they aren't looking at needs them (notify.tsx).
 */
export function useDuelFeed(enabled: boolean) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const current = useRef<string | null>(null);
  current.current = useCurrentDuel();
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/me/duels/stream');
    // Whatever changed while the feed was down is fetched again on each (re)connect.
    source.onopen = () => void queryClient.invalidateQueries({ queryKey: ['duels'] });
    source.onmessage = (e: MessageEvent<string>) => {
      const duel = JSON.parse(e.data) as DuelSummary;
      const before = queryClient.getQueryData<DuelSummary[]>(['duels'])?.find((d) => d.id === duel.id) ?? queryClient.getQueryData<DuelSummary>(['duel', duel.id]);
      const news = newsOf(before, duel);
      const looking = current.current === duel.id && document.visibilityState === 'visible';
      if (news) tell(duel, news, looking, () => void navigate(`/duel/${duel.id}`));
      queryClient.setQueryData<DuelSummary[]>(['duels'], (list) =>
        list && (list.some((d) => d.id === duel.id) ? list.map((d) => (d.id === duel.id ? duel : d)) : [duel, ...list]),
      );
      queryClient.setQueryData(['duel', duel.id], duel);
    };
    return () => source.close();
  }, [enabled, queryClient, navigate]);
}

/** The duels being played or prepared that the viewer sits in, newest first. */
function useLiveDuels(enabled: boolean): DuelSummary[] {
  const duels = useDuels(enabled);
  return (duels.data ?? []).filter((d) => d.yourSeat !== null && (d.status === 'active' || d.status === 'preparing'));
}

/** The duel whose page is open, if any. */
function useCurrentDuel(): string | null {
  return useLocation().pathname.match(/^\/duel\/([^/]+)$/)?.[1] ?? null;
}

export const moveText: Record<YourMove, string> = { deck: 'Choose your deck', turn: 'Your turn', answer: 'Waiting on your answer' };

/**
 * G opens the next duel waiting on the viewer, after the open one, and the tab's title counts the duels waiting on
 * them, so a background tab shows it.
 */
export function useDuelSwitching(enabled: boolean) {
  const live = useLiveDuels(enabled);
  const current = useCurrentDuel();
  const navigate = useNavigate();
  const waiting = live.filter((d) => d.yourMove !== null);

  useEffect(() => {
    const base = 'Yu-Gi-Oh Duels';
    document.title = waiting.length > 0 ? `(${waiting.length}) ${base}` : base;
  }, [waiting.length]);

  const next = nextWaiting(live, current);
  useEffect(() => {
    if (!next) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e) || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'g') return;
      e.preventDefault();
      void navigate(`/duel/${next.id}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, navigate]);
}

/** The first duel waiting on the viewer after the open one, going round the list; never the open one itself. */
function nextWaiting(live: DuelSummary[], current: string | null): DuelSummary | null {
  const at = live.findIndex((d) => d.id === current);
  const order = [...live.slice(at + 1), ...live.slice(0, Math.max(at, 0))];
  return order.find((d) => d.yourMove !== null) ?? null;
}

/**
 * The viewer's other live duels as chips, each lit while it waits on them. Shown in the top bar, and on the duel
 * screen, which has no top bar. Nothing when there are no other duels.
 */
export function DuelSwitcher({ enabled }: { enabled: boolean }) {
  const current = useCurrentDuel();
  const others = useLiveDuels(enabled).filter((d) => d.id !== current);
  if (others.length === 0) return null;
  return (
    <nav className="duel-switcher" aria-label="Your other duels">
      {others.map((d) => {
        const opponent = d.yourSeat === null ? null : d.players[d.yourSeat === 0 ? 1 : 0];
        const how = d.yourMove ? moveText[d.yourMove] : d.status === 'preparing' ? 'Your opponent is choosing a deck' : 'Your opponent is playing';
        return (
          <Link key={d.id} to={`/duel/${d.id}`} className={`duel-chip${d.yourMove ? ' needs-you' : ''}`} title={how}>
            <span className="duel-chip-dot" aria-hidden />
            {opponent?.name ?? 'Open seat'}
            <span className="sr-only">: {how}</span>
          </Link>
        );
      })}
    </nav>
  );
}
