import { useQuery } from '@tanstack/react-query';
import type { CardData } from '@yugioh/engine';
import type { DeckDetail, Me } from '@yugioh/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api.ts';
import { CardFace } from '../board/Card.tsx';
import { CardDetail } from '../board/CardDetail.tsx';
import { CopyLink } from '../CopyLink.tsx';
import { CopyDeck, DeckBuilder } from '../decks/DeckBuilder.tsx';
import { DownloadYdk } from '../decks/ydk.tsx';
import { Loading, Notice } from './Notice.tsx';

/** A deck: its owner builds it here; anyone else who may see it can look and copy it. */
export function DeckPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const deck = useQuery({ queryKey: ['deck', id], queryFn: () => api<DeckDetail>(`/decks/${id}`) });
  if (deck.isError)
    return (
      <Notice title="Deck not found" tone="error" action={<Link className="button" to="/">Back home</Link>}>
        This deck doesn't exist, or its owner hasn't shared it.
      </Notice>
    );
  if (!deck.data) return <Loading />;
  // Keyed so another deck's page starts afresh rather than saving one deck's cards over the other.
  if (deck.data.mine) return <DeckBuilder key={deck.data.id} deck={deck.data} />;
  return <DeckView deck={deck.data} canCopy={me.kind === 'user' && me.user.status === 'approved'} />;
}

function DeckView({ deck, canCopy }: { deck: DeckDetail; canCopy: boolean }) {
  const [hovered, setHovered] = useState<CardData | null>(null);
  const { name, main, extra, side } = deck;
  const shown = hovered ?? main[0] ?? extra[0];
  const codes = (cards: CardData[]) => cards.map((c) => c.code);
  return (
    <section className="deck-page">
      <div className="deck-cards">
        <div className="page-head">
          <Link to="/" className="back">← Home</Link>
          <h1>{name}</h1>
        </div>
        <div className="row">
          {canCopy && <CopyDeck className="primary" label="Copy to my decks" deck={{ name, main: codes(main), extra: codes(extra), side: codes(side), shared: false, banlistId: null }} />}
          {deck.shared && <CopyLink path={`/decks/${deck.id}`} />}
          <DownloadYdk name={name} deck={{ main: codes(main), extra: codes(extra), side: codes(side) }} />
        </div>
        <CardGrid title="Main Deck" cards={main} onShow={setHovered} />
        {extra.length > 0 && <CardGrid title="Extra Deck" cards={extra} onShow={setHovered} />}
        {side.length > 0 && <CardGrid title="Side Deck" cards={side} onShow={setHovered} />}
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
