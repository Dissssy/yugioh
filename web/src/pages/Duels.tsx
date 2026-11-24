import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeckSummary, DuelStatus, DuelSummary } from '@yugioh/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useBanlists, useDecks, useDuels } from '../api.ts';
import { DuelCard } from '../DuelCard.tsx';

const statusOrder: Record<DuelStatus, number> = { active: 0, preparing: 1, waiting: 2, finished: 3 };

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

const DECK_RULES: [boolean, string, string][] = [
  [false, 'Any legal deck', 'Your own decks, uploads or premade ones'],
  [true, 'Premade decks only', 'Changed only by Side Deck swaps'],
];

export function NewChallenge() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const banlists = useBanlists();
  const [banlistId, setBanlistId] = useState<number | null>(null);
  const [premadeOnly, setPremadeOnly] = useState(false);
  const banlist = banlistId ?? banlists.data?.find((b) => b.isDefault)?.id;
  const create = useMutation({
    mutationFn: () => api<DuelSummary>('/duels', { method: 'POST', body: JSON.stringify({ banlistId: banlist, premadeOnly }) }),
    onSuccess: (duel) => {
      void queryClient.invalidateQueries({ queryKey: ['duels'] });
      void navigate(`/duel/${duel.id}`);
    },
  });
  return (
    <section className="box">
      <h2>New challenge</h2>
      <p className="muted small">
        Send the challenge link to your opponent. Once they accept, you both choose your decks. <Link to="/decks">Build a deck</Link>
      </p>
      <label className="field">
        <span className="small">Banlist both decks follow</span>
        <select value={banlist ?? ''} onChange={(e) => setBanlistId(Number(e.target.value))}>
          {banlists.data?.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="small">Decks</span>
        <div className="options" role="radiogroup" aria-label="Decks">
          {DECK_RULES.map(([premade, title, detail]) => (
            <button key={title} role="radio" aria-checked={premadeOnly === premade} className={`option${premadeOnly === premade ? ' on' : ''}`} onClick={() => setPremadeOnly(premade)}>
              <strong>{title}</strong>
              <span className="small muted">{detail}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button className="primary" onClick={() => create.mutate()} disabled={create.isPending || banlist === undefined}>
          Create challenge
        </button>
        {create.isError && <span className="error">{errorText(create.error)}</span>}
      </div>
    </section>
  );
}

/** The admin's duel against Claude (docs/ai-opponent.md): their deck and Claude's, and it starts at once. */
export function PlayClaude() {
  const banlists = useBanlists();
  // Duels against Claude follow no banlist.
  const decks = useDecks({ banlist: banlists.data?.find((b) => b.slug === 'none')?.id });
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
      <DeckPicker decks={decks.data} name="deck-you" value={mine} onChange={setDeckId} />
      <h3 className="small">Claude's deck</h3>
      <DeckPicker decks={decks.data?.filter((d) => d.premade)} name="deck-claude" value={claude} onChange={setAiDeckId} />
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
 * The decks as a set of tiles; the chosen one is lit. A deck that breaks the rules says why, and can't be picked unless
 * `pickIllegal`. `name` groups the radio buttons when a page has two pickers.
 */
export function DeckPicker({
  decks,
  value,
  onChange,
  name = 'deck',
  pickIllegal = false,
}: {
  decks: DeckSummary[] | undefined;
  value: number | null;
  onChange: (id: number) => void;
  name?: string;
  pickIllegal?: boolean;
}) {
  return (
    <div className="deck-picker" role="radiogroup" aria-label="Deck">
      {decks?.map((d) => {
          const illegal = d.problems.length > 0;
          return (
            <label key={d.id} className={`deck-choice${d.id === value ? ' chosen' : ''}${illegal ? ' illegal' : ''}`}>
              <input type="radio" name={name} checked={d.id === value} disabled={illegal && !pickIllegal} onChange={() => onChange(d.id)} />
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
