import type { CardData } from '@yugioh/engine';
import { imageUrl } from './Card.tsx';

/** The full card: big image, stats and text. */
export function CardDetail({ card }: { card: CardData }) {
  return (
    <div className="card-detail">
      <img src={imageUrl(card.code, 'full')} alt={card.name} />
      <div className="card-meta">
        <h3>{card.name}</h3>
        <p className="muted">
          {card.kind === 'monster'
            ? `${card.attribute ?? ''} · ${card.type.includes('XYZ') ? 'Rank' : 'Level'} ${card.level ?? '?'} · ${card.race} · ${card.type}`
            : `${card.race} ${card.type}`}
        </p>
        {card.kind === 'monster' && (
          <p>
            ATK {card.atk ?? '?'} / DEF {card.def ?? '?'}
          </p>
        )}
      </div>
      <p className="card-text">{card.text}</p>
    </div>
  );
}
