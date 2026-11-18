import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DuelSummary, Me } from '@yugioh/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api, errorText, useDecks } from '../api.ts';
import { Board } from '../board/Board.tsx';
import { DeckPicker } from './Duels.tsx';

export function DuelPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const duel = useQuery({
    queryKey: ['duel', id],
    queryFn: () => api<DuelSummary>(`/duels/${id}`),
    // While waiting for an opponent, check now and then whether they've arrived.
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 3000 : false),
    enabled: me.kind !== 'anonymous',
  });

  if (me.kind === 'anonymous') return <p>Log in, or open an invite link from a player, to play.</p>;
  if (duel.isError) return <p className="error">This duel doesn't exist, or you can't see it.</p>;
  if (!duel.data) return <p>Loading…</p>;
  const d = duel.data;

  if (d.status === 'waiting') {
    if (d.yourSeat === 0) return <Waiting duel={d} />;
    if (d.canJoin) return <Join duel={d} />;
    return <p>This challenge is waiting for an opponent.</p>;
  }
  if (d.yourSeat === null) return <p>This duel is between two other players.</p>;
  return <Board duelId={d.id} />;
}

function Waiting({ duel }: { duel: DuelSummary }) {
  const link = window.location.href;
  return (
    <section>
      <h1>Waiting for an opponent</h1>
      <p>
        You'll play <strong>{duel.decks[0]}</strong>. Send this link to your opponent. Players with an account can open it
        directly; someone without one needs one of your invite links first, then finds this challenge on their home page.
      </p>
      <p className="row">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button onClick={() => navigator.clipboard.writeText(link)}>Copy</button>
      </p>
      <p className="muted">The duel starts as soon as they pick a deck.</p>
    </section>
  );
}

function Join({ duel }: { duel: DuelSummary }) {
  const decks = useDecks();
  const queryClient = useQueryClient();
  const [deckId, setDeckId] = useState<number | null>(null);
  const chosen = deckId ?? decks.data?.[0]?.id ?? null;
  const join = useMutation({
    mutationFn: (id: number) => api<DuelSummary>(`/duels/${duel.id}/join`, { method: 'POST', body: JSON.stringify({ deckId: id }) }),
    onSuccess: (next) => queryClient.setQueryData(['duel', duel.id], next),
  });
  return (
    <section>
      <h1>{duel.createdBy} challenges you</h1>
      <p>They play <strong>{duel.decks[0]}</strong>. Pick your deck:</p>
      <p className="row">
        <DeckPicker value={chosen} onChange={setDeckId} />
        <button onClick={() => chosen !== null && join.mutate(chosen)} disabled={join.isPending || chosen === null}>
          Accept and start
        </button>
      </p>
      {join.isError && <p className="error">{errorText(join.error)}</p>}
    </section>
  );
}
