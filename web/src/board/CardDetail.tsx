import type { CardData } from '@yugioh/engine';
import { imageUrl } from './Card.tsx';
import type { Stats } from './CardTooltip.tsx';

/** The full card: big image, stats and text. `stats` are its ATK and DEF on the field now, shown when an effect changed them. */
export function CardDetail({ card, stats = null }: { card: CardData; stats?: Stats | null }) {
  const changed = stats && (stats.atk !== card.atk || stats.def !== card.def);
  const tone = (now: number, was: number | null) => (was === null || now === was ? undefined : now > was ? 'up' : 'down');
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
        {card.kind === 'monster' &&
          (changed ? (
            <p className="stats-now">
              ATK <span className={tone(stats.atk, card.atk)}>{stats.atk}</span> / DEF <span className={tone(stats.def, card.def)}>{stats.def}</span>
              <span className="muted small"> (printed {card.atk ?? '?'} / {card.def ?? '?'})</span>
            </p>
          ) : (
            <p>
              ATK {card.atk ?? '?'} / DEF {card.def ?? '?'}
            </p>
          ))}
      </div>
      <p className="card-text">{card.text}</p>
    </div>
  );
}
