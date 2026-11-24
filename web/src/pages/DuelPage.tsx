import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DuelSummary, Me } from '@yugioh/shared';
import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { api, errorText, loginHref } from '../api.ts';
import { Board } from '../board/Board.tsx';
import { Loading, Notice } from './Notice.tsx';
import { Prepare } from './Prepare.tsx';

export function DuelPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const duel = useQuery({
    queryKey: ['duel', id],
    queryFn: () => api<DuelSummary>(`/duels/${id}`),
    // Until the duel starts, check now and then whether the opponent has arrived, or is ready.
    refetchInterval: (q) => (q.state.data?.status === 'waiting' || q.state.data?.status === 'preparing' ? 3000 : false),
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
    if (d.status === 'preparing')
      return <Notice title="The players are choosing their decks">The duel starts once both are ready. Keep this page open to watch it.</Notice>;
    if (d.canJoin) return <Join duel={d} me={me} />;
    return (
      <Notice title={`${d.players[0].name} challenges you`}>
        Your account needs the admin's approval before you can play. Check back once it's approved.
      </Notice>
    );
  }
  // Players choose their decks from the moment they sit down, the challenger before anyone accepts.
  if (d.status === 'waiting' || d.status === 'preparing') return <Prepare duel={d} />;
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

/** Accepting a challenge. A signed-out visitor either logs in or gives a name and plays as a guest. */
function Join({ duel, me }: { duel: DuelSummary; me: Me }) {
  const queryClient = useQueryClient();
  const [guestName, setGuestName] = useState('');
  const asGuest = me.kind === 'anonymous';
  const join = useMutation({
    mutationFn: () => api<DuelSummary>(`/duels/${duel.id}/join`, { method: 'POST', body: JSON.stringify(asGuest ? { guestName } : {}) }),
    onSuccess: (next) => {
      queryClient.setQueryData(['duel', duel.id], next);
      if (asGuest) void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <section className="notice box join">
      <h1>{duel.players[0].name} challenges you</h1>
      <div className="notice-body">
        <p>
          Once you accept, you both choose your decks. Both decks follow the <strong>{duel.banlist}</strong> banlist
          {duel.premadeOnly ? ', and must be premade decks' : ''}.
        </p>
        {asGuest && (
          <label className="field">
            <span className="small muted">Your name</span>
            <input placeholder="What your opponent sees" maxLength={30} value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          </label>
        )}
        <div className="actions">
          <button className="primary big" onClick={() => join.mutate()} disabled={join.isPending || (asGuest && guestName.trim() === '')}>
            {asGuest ? 'Play as guest' : 'Accept'}
          </button>
          {asGuest && (
            <span className="muted small">
              or <Link to={loginHref(window.location.pathname)}>log in</Link> to play with your account
            </span>
          )}
        </div>
        {join.isError && <p className="error">{errorText(join.error)}</p>}
        {asGuest && (
          <p className="muted small">
            A guest can play any challenge they get a link to, until a day after their last duel finishes. Guests keep their
            decks as .ydk files: download one before the duel, and upload it next time.
          </p>
        )}
      </div>
    </section>
  );
}
