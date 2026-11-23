import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeckSummary, DuelStatus, DuelSummary } from '@yugioh/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useDecks, useDuels } from '../api.ts';
import { DuelCard } from '../DuelCard.tsx';

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
              <DuelCard duel={d} />
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
  const chosen = deckId ?? firstLegal(decks.data);
  return (
    <section className="box">
      <h2>New challenge</h2>
      {decks.data?.length === 0 ? (
        <p className="muted">Card data hasn't been imported yet, so there are no decks to play with.</p>
      ) : (
        <>
          <p className="muted small">
            Pick your deck, then send the challenge link to your opponent. <Link to="/decks">Build a deck</Link>
          </p>
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

/** The admin's duel against Claude (docs/ai-opponent.md): their deck and Claude's, and it starts at once. */
export function PlayClaude() {
  const decks = useDecks();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deckId, setDeckId] = useState<number | null>(null);
  const [aiDeckId, setAiDeckId] = useState<number | null>(null);
  const create = useMutation({
    mutationFn: (body: { deckId: number; aiDeckId: number }) => api<DuelSummary>('/admin/duels/ai', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (duel) => {
      void queryClient.invalidateQueries({ queryKey: ['duels'] });
      void navigate(`/duel/${duel.id}`);
    },
  });
  const first = firstLegal(decks.data);
  const mine = deckId ?? first;
  // Claude plays premade decks only.
  const claude = aiDeckId ?? firstLegal(decks.data?.filter((d) => d.premade));
  if (!first) return null;
  return (
    <section className="box">
      <h2>Play against Claude</h2>
      <p className="muted small">Admin only. Claude plays its seat from what that seat can see, one move at a time.</p>
      <h3 className="small">Your deck</h3>
      <DeckPicker name="deck-you" value={mine} onChange={setDeckId} />
      <h3 className="small">Claude's deck</h3>
      <DeckPicker name="deck-claude" value={claude} onChange={setAiDeckId} premadeOnly />
      <div className="actions">
        <button
          className="primary"
          onClick={() => mine !== null && claude !== null && create.mutate({ deckId: mine, aiDeckId: claude })}
          disabled={create.isPending || mine === null || claude === null}
        >
          Start the duel
        </button>
        {create.isError && <span className="error">{errorText(create.error)}</span>}
      </div>
    </section>
  );
}

export const firstLegal = (decks: DeckSummary[] | undefined) => decks?.find((d) => d.problems.length === 0)?.id ?? null;

/**
 * The decks as a set of tiles; the chosen one is lit. A deck that breaks the rules can't be picked and says why.
 * `name` groups the radio buttons when a page has two pickers.
 */
export function DeckPicker({
  value,
  onChange,
  name = 'deck',
  premadeOnly = false,
}: {
  value: number | null;
  onChange: (id: number) => void;
  name?: string;
  premadeOnly?: boolean;
}) {
  const decks = useDecks();
  return (
    <div className="deck-picker" role="radiogroup" aria-label="Deck">
      {decks.data
        ?.filter((d) => d.premade || !premadeOnly)
        .map((d) => {
          const illegal = d.problems.length > 0;
          return (
            <label key={d.id} className={`deck-choice${d.id === value ? ' chosen' : ''}${illegal ? ' illegal' : ''}`}>
              <input type="radio" name={name} checked={d.id === value} disabled={illegal} onChange={() => onChange(d.id)} />
              <span className="deck-stack" aria-hidden>
                <span className="card back" />
                <span className="card back" />
                <span className="card back" />
              </span>
              <span className="deck-name">
                <strong>{d.name}</strong>
                <span className="muted small">
                  {d.mainCount} cards · {d.extraCount} Extra{d.premade ? '' : ' · yours'}
                </span>
                {illegal && <span className="error small">{d.problems[0]}</span>}
              </span>
              <Link to={`/decks/${d.id}`} className="small">{d.premade ? 'See cards' : 'Edit'}</Link>
            </label>
          );
        })}
    </div>
  );
}
