import type { CardData } from '@yugioh/engine';
import { CardImage, TextFace, TokenFace } from './Card.tsx';
import type { Stats } from './CardTooltip.tsx';

/** The full card: big image (drawn as text when `image` is false), stats and text. `stats` are its ATK, DEF and Level on the field now, shown when an effect changed them. */
export function CardDetail({ card, stats = null, image = true }: { card: CardData; stats?: Stats | null; image?: boolean }) {
  const changed = stats && (stats.atk !== card.atk || stats.def !== card.def);
  const tone = (now: number, was: number | null) => (was === null || now === was ? undefined : now > was ? 'up' : 'down');
  const level = stats?.level ?? null;
  const levelChanged = level !== null && level !== card.level;
  return (
    <div className="card-detail">
      {card.type === 'Token' ? (
        <TokenFace card={card} className="token-detail" />
      ) : image ? (
        <CardImage key={card.code} card={card} size="full" className="detail-image" />
      ) : (
        <TextFace card={card} className="detail-image" />
      )}
      <div className="card-meta">
        <h3>{card.name}</h3>
        <p className="muted">
          {card.kind === 'monster'
            ? `${card.attribute ?? ''} · ${card.type.includes('XYZ') ? 'Rank' : 'Level'} ${card.level ?? '?'} · ${card.race} · ${card.type}`
            : `${card.race} ${card.type}`}
        </p>
        {levelChanged && (
          <p className="stats-now">
            Level <span className={tone(level, card.level)}>{level}</span>
            <span className="muted small"> (printed {card.level ?? '?'})</span>
          </p>
        )}
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
