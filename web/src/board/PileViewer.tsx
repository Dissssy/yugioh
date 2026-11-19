import type { CardView } from '@yugioh/engine';
import { useEffect, useState } from 'react';
import { CardFace, dataOf } from './Card.tsx';
import { useCardHover } from './CardTooltip.tsx';

/** A Graveyard, banished pile or Extra Deck opened over the board: large cards, searchable by name. */
export function PileViewer({ title, cards, onClose }: { title: string; cards: CardView[]; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const hover = useCardHover();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const shown = cards.filter((c) => dataOf(c)?.name.toLowerCase().includes(search.toLowerCase()) ?? search === '');

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3>
            {title} ({cards.length})
          </h3>
          {cards.length > 8 && <input placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />}
          <button onClick={onClose}>Close</button>
        </div>
        {cards.length === 0 ? (
          <p className="muted">Empty.</p>
        ) : (
          <div className="sheet-grid">
            {shown.map((c, i) => (
              <div key={i} {...hover(dataOf(c))}>
                <CardFace card={dataOf(c)} size="full" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
