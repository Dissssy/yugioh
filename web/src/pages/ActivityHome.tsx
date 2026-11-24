// The home page inside the Discord Activity (docs/discord.md): the open games where it was opened, or in a DM, the DM's
// one game.
import { useMutation } from '@tanstack/react-query';
import type { DuelSummary } from '@yugioh/shared';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useOpenGames } from '../api.ts';
import { NewChallenge, OpenGamesList } from './Duels.tsx';
import { Dashboard } from './Home.tsx';
import { Loading, Notice } from './Notice.tsx';

/** Opening the Activity in a DM goes into its game once; coming back home after that stays home. */
let enteredDmGame = false;

export function ActivityHome({ title }: { title: string }) {
  const openGames = useOpenGames();
  if (openGames.isError) return <Notice title="Can't load the games" tone="error">{errorText(openGames.error)}</Notice>;
  if (!openGames.data) return <Loading />;
  const { dm, games } = openGames.data;
  if (dm) return <DmHome title={title} games={games} />;
  return (
    <Dashboard title={title} list={<OpenGamesList games={games} />}>
      <NewChallenge />
    </Dashboard>
  );
}

/**
 * A DM plays one game at a time, since whoever opened the Activity there most likely came to duel the other person.
 * Opening it goes straight into that game, taking the empty seat; with no game going, the first one in starts it.
 */
function DmHome({ title, games }: { title: string; games: DuelSummary[] }) {
  const navigate = useNavigate();
  const current = games.find((g) => g.status !== 'finished');
  const join = useMutation({
    mutationFn: (id: string) => api<DuelSummary>(`/duels/${id}/join`, { method: 'POST', body: '{}' }),
    onSettled: (_data, _error, id) => void navigate(`/duel/${id}`),
  });
  useEffect(() => {
    if (!current || enteredDmGame) return;
    enteredDmGame = true;
    if (current.canJoin) join.mutate(current.id);
    else void navigate(`/duel/${current.id}`);
    // Only a new game here sends the player in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  return (
    <Dashboard title={title} list={<OpenGamesList games={games} title="Games in this DM" />}>
      {current ? (
        <section className="box">
          <h2>A game is going</h2>
          <p className="muted small">One game at a time in a DM. It shows up on the right too.</p>
          <div className="actions">
            <Link className="button primary" to={`/duel/${current.id}`}>{current.yourSeat === null && !current.canJoin ? 'Watch it' : 'Back to the game'}</Link>
          </div>
        </section>
      ) : (
        <NewChallenge dm />
      )}
    </Dashboard>
  );
}
