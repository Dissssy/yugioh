import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DuelStatus, DuelSummary } from '@yugioh/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useDecks, useDuels } from '../api.ts';
import { formatDate } from './Home.tsx';

const statusText: Record<DuelStatus, string> = { waiting: 'Waiting', active: 'In progress', finished: 'Finished' };
const statusOrder: Record<DuelStatus, number> = { active: 0, waiting: 1, finished: 2 };

/** The viewer's duels, live ones first. */
export function Duels() {
  const duels = useDuels();
  const sorted = [...(duels.data ?? [])].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
  return (
    <section className="box duels">
      <h2>Your duels</h2>
      {duels.isError && <p className="error">Couldn't load your duels.</p>}
      {duels.data && sorted.length === 0 && (
        <div className="empty">
          <div className="card back" aria-hidden />
          <p className="muted">No duels yet. Challenges you create or accept show up here.</p>
        </div>
      )}
      {sorted.length > 0 && (
        <ul className="duel-list">
          {sorted.map((d) => (
            <li key={d.id}>
              <Link to={`/duel/${d.id}`} className="duel-row">
                <span className="duel-title">
                  <strong>{d.decks[0]}</strong>
                  <span className="vs">vs</span>
                  <strong className={d.decks[1] ? '' : 'muted'}>{d.decks[1] ?? 'open seat'}</strong>
                </span>
                <span className="muted small">
                  {d.yourSeat === 0 ? 'Your challenge' : `${d.createdBy}'s challenge`} · {formatDate(d.createdAt)}
                </span>
                <span className={`pill ${d.status}`}>{statusText[d.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NewChallenge() {
  const decks = useDecks();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deckId, setDeckId] = useState<number | null>(null);
  const create = useMutation({
    mutationFn: (id: number) => api<DuelSummary>('/duels', { method: 'POST', body: JSON.stringify({ deckId: id }) }),
    onSuccess: (duel) => {
      void queryClient.invalidateQueries({ queryKey: ['duels'] });
      void navigate(`/duel/${duel.id}`);
    },
  });
  const chosen = deckId ?? decks.data?.[0]?.id ?? null;
  return (
    <section className="box">
      <h2>New challenge</h2>
      {decks.data?.length === 0 ? (
        <p className="muted">Card data hasn't been imported yet, so there are no decks to play with.</p>
      ) : (
        <>
          <p className="muted small">Pick your deck, then send the challenge link to your opponent.</p>
          <DeckPicker value={chosen} onChange={setDeckId} />
          <div className="actions">
            <button className="primary" onClick={() => chosen !== null && create.mutate(chosen)} disabled={create.isPending || chosen === null}>
              Create challenge
            </button>
            {create.isError && <span className="error">{errorText(create.error)}</span>}
          </div>
        </>
      )}
    </section>
  );
}

/** The decks as a set of tiles; the chosen one is lit. */
export function DeckPicker({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const decks = useDecks();
  return (
    <div className="deck-picker" role="radiogroup" aria-label="Deck">
      {decks.data?.map((d) => (
        <label key={d.id} className={`deck-choice${d.id === value ? ' chosen' : ''}`}>
          <input type="radio" name="deck" checked={d.id === value} onChange={() => onChange(d.id)} />
          <span className="deck-stack" aria-hidden>
            <span className="card back" />
            <span className="card back" />
            <span className="card back" />
          </span>
          <span className="deck-name">
            <strong>{d.name}</strong>
            <span className="muted small">
              {d.mainCount} cards · {d.extraCount} Extra
            </span>
          </span>
          <Link to={`/decks/${d.id}`} className="small">See cards</Link>
        </label>
      ))}
    </div>
  );
}
