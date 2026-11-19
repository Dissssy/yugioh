import type { CardView } from '@yugioh/engine';
import { useEffect, useState, type ReactNode } from 'react';
import { CardFace, dataOf, idOf } from './Card.tsx';
import { useCardHover } from './CardTooltip.tsx';
import { useChoice } from './choice.tsx';

/**
 * A Graveyard, banished pile or Extra Deck opened over the board: large cards, searchable by name. While the judge
 * asks for cards, the ones you may pick glow and are picked here, the rest dim, and `bar` (the question) sits on top.
 * Otherwise a card you can act on from here (Summon it from the Extra Deck) glows, and clicking it opens its menu.
 */
export function PileViewer({
  title,
  cards,
  bar,
  onClose,
  playable,
  onCard,
}: {
  title: string;
  cards: CardView[];
  bar: ReactNode;
  onClose: () => void;
  /** Cards you can do something with from here (Summon from the Extra Deck), which glow and open their menu when clicked. */
  playable?: (id: string) => boolean;
  onCard?: (id: string, el: HTMLElement) => void;
}) {
  const [search, setSearch] = useState('');
  const hover = useCardHover();
  const choice = useChoice();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const shown = cards.filter((c) => dataOf(c)?.name.toLowerCase().includes(search.toLowerCase()) ?? search === '');

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${choice ? ' choosing' : ''}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3>
            {title} ({cards.length})
          </h3>
          {cards.length > 8 && <input placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />}
          <span className="spacer" />
          <button onClick={onClose}>{choice ? 'Back to the board' : 'Close'}</button>
        </div>
        {bar && <div className="sheet-bar">{bar}</div>}
        {cards.length === 0 ? (
          <p className="muted">Empty.</p>
        ) : (
          <div className="sheet-grid">
            {shown.map((c, i) => {
              const id = idOf(c);
              const picking = choice?.state(id) ?? null;
              return picking ? (
                <button
                  key={id ?? i}
                  className={`plain sheet-card ${picking}`}
                  aria-pressed={picking === 'picked'}
                  onClick={() => choice!.toggle(id)}
                  {...hover(dataOf(c))}
                >
                  <CardFace card={dataOf(c)} size="full" />
                </button>
              ) : id && playable?.(id) && onCard ? (
                <button key={id} className="plain sheet-card playable" onClick={(e) => onCard(id, e.currentTarget)} {...hover(dataOf(c))}>
                  <CardFace card={dataOf(c)} size="full" />
                </button>
              ) : (
                <div key={id ?? i} className="sheet-card" {...hover(dataOf(c))}>
                  <CardFace card={dataOf(c)} size="full" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
