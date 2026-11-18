import type { CardData, CardView } from '@yugioh/engine';

/** A card's small image, or its back when the viewer can't see it. */
export function CardFace({ card, faceDown = false }: { card: CardData | null; faceDown?: boolean }) {
  if (!card) return <div className="card back" aria-label="Face-down card" />;
  return (
    <img
      className={`card${faceDown ? ' set' : ''}`}
      src={`/card-images/small/${card.code}.jpg`}
      alt={card.name}
      title={card.name}
      loading="lazy"
    />
  );
}

export const dataOf = (view: CardView): CardData | null => ('card' in view ? view.card : null);
export const idOf = (view: CardView): string | null => ('id' in view ? view.id : null);
