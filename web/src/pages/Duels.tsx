import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DuelStatus, DuelSummary } from '@yugioh/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useDecks, useDuels } from '../api.ts';
import { formatDate } from './Home.tsx';

const statusText: Record<DuelStatus, string> = { waiting: 'Waiting for an opponent', active: 'In progress', finished: 'Finished' };

/** The viewer's duels; accounts can also start a new challenge. */
export function Duels({ canChallenge }: { canChallenge: boolean }) {
  const duels = useDuels();
  return (
    <>
      <h2>Duels</h2>
      {canChallenge && <NewChallenge />}
      {duels.data && duels.data.length === 0 && (
        <p className="muted">No duels yet.</p>
      )}
      {duels.data && duels.data.length > 0 && (
        <ul className="list">
          {duels.data.map((d) => (
            <li key={d.id}>
              <Link to={`/duel/${d.id}`}>{describe(d)}</Link>
              <span className="muted">
                {statusText[d.status]} · {formatDate(d.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function describe(d: DuelSummary) {
  return d.decks[1] ? `${d.decks[0]} vs ${d.decks[1]}` : `Your challenge with ${d.decks[0]}`;
}

function NewChallenge() {
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
  if (!decks.data) return null;
  if (decks.data.length === 0) return <p className="muted">Card data hasn't been imported yet, so there are no decks to play with.</p>;
  const chosen = deckId ?? decks.data[0]!.id;
  return (
    <p className="row">
      <DeckPicker value={chosen} onChange={setDeckId} />
      <button onClick={() => create.mutate(chosen)} disabled={create.isPending}>Create challenge</button>
      {create.isError && <span className="error">{errorText(create.error)}</span>}
    </p>
  );
}

export function DeckPicker({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const decks = useDecks();
  return (
    <>
      <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        {decks.data?.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      {value !== null && <Link to={`/decks/${value}`}>See cards</Link>}
    </>
  );
}
