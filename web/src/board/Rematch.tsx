// A rematch at the end of a duel (docs/ux-niceties.md): the same players, decks and banlist. Asking and accepting are
// the same button; the rematch starts once both have pressed it, and both boards move to it. Either player may change
// their deck first, on the rematch's pre-duel page, which is where a best of three will side deck.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DuelSummary } from '@yugioh/shared';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText } from '../api.ts';

export function Rematch({ duelId }: { duelId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Both kept up to date by the player's duel feed.
  const duel = useQuery({ queryKey: ['duel', duelId], queryFn: () => api<DuelSummary>(`/duels/${duelId}`) });
  const rematchId = duel.data?.rematch ?? null;
  const rematch = useQuery({ queryKey: ['duel', rematchId], queryFn: () => api<DuelSummary>(`/duels/${rematchId}`), enabled: rematchId !== null });
  const ask = useMutation({
    mutationFn: () => api<DuelSummary>(`/duels/${duelId}/rematch`, { method: 'POST', body: '{}' }),
    onSuccess: (next) => {
      queryClient.setQueryData(['duel', next.id], next);
      queryClient.setQueryData<DuelSummary>(['duel', duelId], (d) => d && { ...d, rematch: next.id });
      void queryClient.invalidateQueries({ queryKey: ['duels'] });
    },
  });

  const next = rematch.data;
  useEffect(() => {
    if (next?.status === 'active') void navigate(`/duel/${next.id}`);
  }, [next?.status, next?.id, navigate]);

  if (!duel.data || duel.data.yourSeat === null) return null;
  const mine = duel.data.yourSeat;
  const opponent = duel.data.players[mine === 0 ? 1 : 0]?.name ?? 'Your opponent';
  const youReady = next?.players[mine]?.ready ?? false;
  const theyReady = next?.players[mine === 0 ? 1 : 0]?.ready ?? false;
  return (
    <span className="rematch">
      {next && !youReady && theyReady && <span>{opponent} wants a rematch.</span>}
      {youReady ? (
        <span className="muted">Waiting for {opponent} to accept…</span>
      ) : (
        <button className="primary" onClick={() => ask.mutate()} disabled={ask.isPending}>
          {theyReady ? 'Accept the rematch' : 'Rematch'}
        </button>
      )}
      {next && (
        <Link className="small" to={`/duel/${next.id}`}>
          Change your deck first
        </Link>
      )}
      {ask.isError && <span className="error small">{errorText(ask.error)}</span>}
    </span>
  );
}
