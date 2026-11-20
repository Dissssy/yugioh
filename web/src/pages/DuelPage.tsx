import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DuelSummary, Me } from '@yugioh/shared';
import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { api, errorText, loginHref, useDecks } from '../api.ts';
import { Board } from '../board/Board.tsx';
import { DeckPicker } from './Duels.tsx';
import { Loading, Notice } from './Notice.tsx';

export function DuelPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const duel = useQuery({
    queryKey: ['duel', id],
    queryFn: () => api<DuelSummary>(`/duels/${id}`),
    // While waiting for an opponent, check now and then whether they've arrived.
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 3000 : false),
  });

  if (duel.isError)
    return (
      <Notice title="Duel not found" tone="error" action={<Link className="button" to="/">Back home</Link>}>
        This duel doesn't exist. Check the link you were sent.
      </Notice>
    );
  if (!duel.data) return <Loading />;
  const d = duel.data;

  if (d.yourSeat === null) {
    // Anyone else holding the link watches: live, or the replay once it's over.
    if (d.status === 'finished') return <Navigate to={`/duel/${d.id}/replay`} replace />;
    if (d.status === 'active') return <Board key={d.id} duelId={d.id} watching="live" />;
    if (d.canJoin) return <Join duel={d} me={me} />;
    return (
      <Notice title={`${d.players[0].name} challenges you`}>
        Your account needs the admin's approval before you can play. Check back once it's approved.
      </Notice>
    );
  }
  if (d.status === 'waiting') return <Waiting duel={d} />;
  return <Board duelId={d.id} />;
}

/** A finished duel played back, for anyone holding the link (docs/next-steps.md, Replays). */
export function ReplayPage() {
  const { id = '' } = useParams();
  const duel = useQuery({ queryKey: ['duel', id], queryFn: () => api<DuelSummary>(`/duels/${id}`) });
  if (duel.isError)
    return (
      <Notice title="Duel not found" tone="error" action={<Link className="button" to="/">Back home</Link>}>
        This duel doesn't exist. Check the link you were sent.
      </Notice>
    );
  if (!duel.data) return <Loading />;
  if (duel.data.status !== 'finished')
    return (
      <Notice title="Not over yet" action={<Link className="button" to={`/duel/${id}`}>Go to the duel</Link>}>
        A duel can be watched again once it has finished.
      </Notice>
    );
  return <Board key={id} duelId={id} watching="replay" />;
}

function Waiting({ duel }: { duel: DuelSummary }) {
  const link = window.location.href;
  const [copied, setCopied] = useState(false);
  return (
    <section className="notice box">
      <p className="waiting-label" role="status">
        <span className="dot" /> Waiting for an opponent
      </p>
      <h1>Send this link to your opponent</h1>
      <div className="notice-body">
        <p>
          You'll play <strong>{duel.players[0].deck}</strong>. They can log in, or play as a guest without an account.
        </p>
        <div className="row">
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button
            className="primary"
            onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <p className="muted small">The duel starts as soon as they pick a deck.</p>
      </div>
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
    <section className="notice box join">
      <h1>{duel.players[0].name} challenges you</h1>
      <div className="notice-body">
        <p>
          They play <strong>{duel.players[0].deck}</strong>. Pick the deck you'll play.
        </p>
        <DeckPicker value={chosen} onChange={setDeckId} />
        {asGuest && (
          <label className="field">
            <span className="small muted">Your name</span>
            <input placeholder="What your opponent sees" maxLength={30} value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          </label>
        )}
        <div className="actions">
          <button className="primary big" onClick={() => chosen !== null && join.mutate(chosen)} disabled={join.isPending || !ready}>
            {asGuest ? 'Play as guest' : 'Accept and start'}
          </button>
          {asGuest && (
            <span className="muted small">
              or <a href={loginHref(window.location.pathname)}>log in</a> to play with your account
            </span>
          )}
        </div>
        {join.isError && <p className="error">{errorText(join.error)}</p>}
        {asGuest && (
          <p className="muted small">
            A guest can play any challenge they get a link to, until a day after their last duel finishes.
          </p>
        )}
      </div>
    </section>
  );
}
