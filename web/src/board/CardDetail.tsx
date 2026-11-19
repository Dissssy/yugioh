import type { CardData } from '@yugioh/engine';
import { imageUrl } from './Card.tsx';

const hasEffect = (card: CardData) => card.kind !== 'monster' || !card.type.startsWith('Normal');

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
      {hasEffect(card) && <p className="muted small">Card effects can't be used yet. They arrive in the next build step.</p>}
    </div>
  );
}
