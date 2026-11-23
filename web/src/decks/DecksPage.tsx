import type { DeckSummary, Me } from '@yugioh/shared';
import { Link } from 'react-router';
import { useBanlists, useDecks } from '../api.ts';
import { Notice } from '../pages/Notice.tsx';
import { CopyDeck } from './DeckBuilder.tsx';
import { ImportYdk } from './ydk.tsx';

/** The viewer's decks, with whether each can go into a duel, and the premade decks to start from. */
export function DecksPage({ me }: { me: Me }) {
  const decks = useDecks();
  const banlists = useBanlists();
  if (me.kind !== 'user' || me.user.status !== 'approved')
    return <Notice title="Decks need an account">Log in with an approved account to build decks.</Notice>;
  const mine = decks.data?.filter((d) => !d.premade) ?? [];
  const premade = decks.data?.filter((d) => d.premade) ?? [];
  return (
    <div className="decks-page">
      <div className="page-head">
        <Link to="/" className="back">← Home</Link>
        <h1>Your decks</h1>
      </div>
      <section className="box">
        <div className="row">
          <CopyDeck className="primary" label="New deck" deck={{ name: 'New deck', main: [], extra: [], side: [], shared: false, banlistId: null }} />
          <ImportYdk />
          <span className="muted small">Decks save as you build them. Only decks that follow the rules can go into a duel.</span>
        </div>
        {decks.isError && <p className="error">Couldn't load your decks.</p>}
        {decks.data && mine.length === 0 && <p className="muted">No decks yet. Start a new one, or copy a premade deck below.</p>}
        <ul className="deck-rows">
          {mine.map((d) => (
            <li key={d.id}>
              <DeckRow deck={d} />
            </li>
          ))}
        </ul>
      </section>
      <section className="box">
        <h2>Banlists</h2>
        <p className="muted small">
          Each deck is checked against the banlist you build it for, and each challenge picks the banlist both decks must
          follow. Copy a default list to make your own.
        </p>
        <ul className="deck-rows">
          {banlists.data?.map((b) => (
            <li key={b.id}>
              <Link to={`/banlists/${b.id}`} className="deck-row">
                <strong>{b.name}</strong>
                <span className="muted small">{b.isDefault ? 'Default' : 'Yours'}</span>
                <span className="muted small">{b.listed === 0 ? 'No cards limited' : `${b.listed} cards limited`}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="box">
        <h2>Premade decks</h2>
        <ul className="deck-rows">
          {premade.map((d) => (
            <li key={d.id}>
              <DeckRow deck={d} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function DeckRow({ deck }: { deck: DeckSummary }) {
  return (
    <Link to={`/decks/${deck.id}`} className="deck-row">
      <strong>{deck.name}</strong>
      <span className="muted small">
        {deck.mainCount} Main · {deck.extraCount} Extra · {deck.sideCount} Side
      </span>
      {deck.problems.length > 0 ? <span className="error small">{deck.problems[0]}</span> : <span className="ok small">Ready to duel</span>}
    </Link>
  );
}
