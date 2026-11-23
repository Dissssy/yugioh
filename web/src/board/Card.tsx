import { useState } from 'react';
import type { CardData, CardView } from '@yugioh/engine';

export type ImageSize = 'small' | 'full';

export const imageUrl = (code: number, size: ImageSize) =>
  size === 'full' ? `/card-images/${code}.jpg` : `/card-images/small/${code}.jpg`;

/** A Token has no card image, so it is drawn: its name, Level and stats. */
export function TokenFace({ card, className = 'card' }: { card: CardData; className?: string }) {
  return (
    <div className={`${className} token`} role="img" aria-label={card.name}>
      <span className="token-name">{card.name}</span>
      <span className="token-level">{'★'.repeat(card.level ?? 0)}</span>
      <span className="token-stats">
        {card.atk} / {card.def}
      </span>
    </div>
  );
}

/**
 * A card drawn as text: a Token, or a card whose image we don't have. Only cards in the pool have downloaded images
 * (docs/card-pool.md), and the deck builder shows every card.
 */
export function TextFace({ card, className = 'card' }: { card: CardData; className?: string }) {
  return (
    <div className={`${className} text-face ${card.kind}`} role="img" aria-label={card.name}>
      <span className="token-name">{card.name}</span>
      <span className="token-stats">{card.kind === 'monster' ? `${card.atk ?? '?'} / ${card.def ?? '?'}` : `${card.race} ${card.kind}`}</span>
    </div>
  );
}

/** A card's image, drawn as text when the image is missing. */
export function CardImage({ card, size, className }: { card: CardData; size: ImageSize; className: string }) {
  const [missing, setMissing] = useState(false);
  if (card.type === 'Token') return <TokenFace card={card} className={className} />;
  if (missing) return <TextFace card={card} className={className} />;
  return <img className={className} src={imageUrl(card.code, size)} alt={card.name} draggable={false} loading="lazy" onError={() => setMissing(true)} />;
}

/** A card's image, or its back when the viewer can't see it. */
export function CardFace({ card, faceDown = false, size = 'small' }: { card: CardData | null; faceDown?: boolean; size?: ImageSize }) {
  if (!card) return <div className="card back" aria-label="Face-down card" />;
  return <CardImage card={card} size={size} className={`card${faceDown ? ' set' : ''}`} />;
}

/** Loads images ahead of time; resolves when all have loaded or failed. */
export function preloadImages(urls: string[]): Promise<void> {
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = url;
        }),
    ),
  ).then(() => undefined);
}

export const dataOf = (view: CardView): CardData | null => ('card' in view ? view.card : null);
export const idOf = (view: CardView): string | null => ('id' in view ? view.id : null);
