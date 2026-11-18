import { useQuery } from '@tanstack/react-query';
import type { CardData } from '@yugioh/engine';
import type { DeckDetail } from '@yugioh/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../api.ts';
import { CardDetail } from '../board/CardDetail.tsx';
import { CardFace } from '../board/Card.tsx';

export function DeckPage() {
  const { id = '' } = useParams();
  const deck = useQuery({ queryKey: ['deck', id], queryFn: () => api<DeckDetail>(`/decks/${id}`) });
  const [shown, setShown] = useState<CardData | null>(null);
  if (deck.isError) return <p className="error">Couldn't load this deck.</p>;
  if (!deck.data) return <p>Loading…</p>;
  const { name, main, extra } = deck.data;
  return (
    <section className="deck-page">
      <div>
        <h1>{name}</h1>
        <h2>Main Deck ({main.length})</h2>
        <CardGrid cards={main} onShow={setShown} />
        <h2>Extra Deck ({extra.length})</h2>
        <CardGrid cards={extra} onShow={setShown} />
      </div>
      <aside>{shown ? <CardDetail card={shown} /> : <p className="muted">Hover a card to read it.</p>}</aside>
    </section>
  );
}

function CardGrid({ cards, onShow }: { cards: CardData[]; onShow: (c: CardData) => void }) {
  return (
    <div className="card-grid">
      {cards.map((card, i) => (
        <button key={i} className="plain" onMouseEnter={() => onShow(card)} onFocus={() => onShow(card)} onClick={() => onShow(card)}>
          <CardFace card={card} />
        </button>
      ))}
    </div>
  );
}
