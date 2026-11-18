import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DuelSummary, Me } from '@yugioh/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api, errorText, loginHref, useDecks } from '../api.ts';
import { Board } from '../board/Board.tsx';
import { DeckPicker } from './Duels.tsx';

export function DuelPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const duel = useQuery({
    queryKey: ['duel', id],
    queryFn: () => api<DuelSummary>(`/duels/${id}`),
    // While waiting for an opponent, check now and then whether they've arrived.
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 3000 : false),
  });

  if (duel.isError) return <p className="error">This duel doesn't exist.</p>;
  if (!duel.data) return <p>Loading…</p>;
  const d = duel.data;

  if (d.yourSeat === null) {
    if (d.status !== 'waiting') return <p>This duel already has two players.</p>;
    if (d.canJoin) return <Join duel={d} me={me} />;
    return <p>{d.createdBy} challenges you, but your account needs the admin's approval before you can play.</p>;
  }
  if (d.status === 'waiting') return <Waiting duel={d} />;
  return <Board duelId={d.id} />;
}

function Waiting({ duel }: { duel: DuelSummary }) {
  const link = window.location.href;
  return (
    <section>
      <h1>Waiting for an opponent</h1>
      <p>
        You'll play <strong>{duel.decks[0]}</strong>. Send this link to your opponent. They can log in, or play as a guest
        without an account.
      </p>
      <p className="row">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button onClick={() => navigator.clipboard.writeText(link)}>Copy</button>
      </p>
      <p className="muted">The duel starts as soon as they pick a deck.</p>
    </section>
  );
}

/** Accepting a challenge. A signed-out visitor either logs in or gives a name and plays as a guest. */
function Join({ duel, me }: { duel: DuelSummary; me: Me }) {
  const decks = useDecks();
  const queryClient = useQueryClient();
  const [deckId, setDeckId] = useState<number | null>(null);
  const [guestName, setGuestName] = useState('');
  const chosen = deckId ?? decks.data?.[0]?.id ?? null;
  const asGuest = me.kind === 'anonymous';
  const join = useMutation({
    mutationFn: (id: number) =>
      api<DuelSummary>(`/duels/${duel.id}/join`, {
        method: 'POST',
        body: JSON.stringify(asGuest ? { deckId: id, guestName } : { deckId: id }),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(['duel', duel.id], next);
      if (asGuest) void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const ready = chosen !== null && (!asGuest || guestName.trim() !== '');
  return (
    <section>
      <h1>{duel.createdBy} challenges you</h1>
      {asGuest && (
        <p>
          <a className="button" href={loginHref(window.location.pathname)}>Log in</a> to play with your account, or play as a
          guest without one. A guest can play any challenge they get a link to, until a day after their last duel finishes.
        </p>
      )}
      <p>They play <strong>{duel.decks[0]}</strong>. Pick your deck:</p>
      <p className="row">
        {asGuest && (
          <input placeholder="Your name" maxLength={30} value={guestName} onChange={(e) => setGuestName(e.target.value)} />
        )}
        <DeckPicker value={chosen} onChange={setDeckId} />
        <button onClick={() => chosen !== null && join.mutate(chosen)} disabled={join.isPending || !ready}>
          {asGuest ? 'Play as guest' : 'Accept and start'}
        </button>
      </p>
      {join.isError && <p className="error">{errorText(join.error)}</p>}
    </section>
  );
}
