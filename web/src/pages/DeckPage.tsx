import { useQuery } from '@tanstack/react-query';
import type { CardData } from '@yugioh/engine';
import type { DeckDetail } from '@yugioh/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { CardFace } from '../board/Card.tsx';
import { CardDetail } from '../board/CardDetail.tsx';
import { Loading, Notice } from './Notice.tsx';

export function DeckPage() {
  const { id = '' } = useParams();
  const deck = useQuery({ queryKey: ['deck', id], queryFn: () => api<DeckDetail>(`/decks/${id}`) });
  const [hovered, setHovered] = useState<CardData | null>(null);
  if (deck.isError)
    return (
      <Notice title="Deck not found" tone="error" action={<Link className="button" to="/">Back home</Link>}>
        Couldn't load this deck.
      </Notice>
    );
  if (!deck.data) return <Loading />;
  const { name, main, extra } = deck.data;
  const shown = hovered ?? main[0] ?? extra[0];
  return (
    <section className="deck-page">
      <div className="deck-cards">
        <div className="page-head">
          <Link to="/" className="back">← Home</Link>
          <h1>{name}</h1>
        </div>
        <CardGrid title="Main Deck" cards={main} onShow={setHovered} />
        {extra.length > 0 && <CardGrid title="Extra Deck" cards={extra} onShow={setHovered} />}
      </div>
      <aside className="box deck-detail">{shown && <CardDetail card={shown} />}</aside>
    </section>
  );
}

function CardGrid({ title, cards, onShow }: { title: string; cards: CardData[]; onShow: (c: CardData) => void }) {
  return (
    <>
      <h2>
        {title} <span className="count">{cards.length}</span>
      </h2>
      <div className="card-grid">
        {cards.map((card, i) => (
          <button key={i} className="plain" onMouseEnter={() => onShow(card)} onFocus={() => onShow(card)} onClick={() => onShow(card)}>
            <CardFace card={card} />
          </button>
        ))}
      </div>
    </>
  );
}
