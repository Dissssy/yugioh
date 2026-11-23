import type { CatalogCard } from '@yugioh/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CardFace, TextFace } from '../board/Card.tsx';
import type { Catalog } from './catalog.ts';
import { clicks, startDrag, useDropTarget, type Dragged } from './interaction.ts';

/** Results drawn at first, and added each time the list scrolls to its end. */
const PAGE = 120;

type Kind = 'all' | 'monster' | 'spell' | 'trap' | 'extra';
const KINDS: [Kind, string][] = [
  ['all', 'All'],
  ['monster', 'Monsters'],
  ['spell', 'Spells'],
  ['trap', 'Traps'],
  ['extra', 'Extra Deck'],
];
type Sort = 'name' | 'atk' | 'def' | 'level';

/** A filter a page adds beside the kinds, such as the banlist editor's "Listed". */
export interface ExtraFilter {
  label: string;
  test: (card: CatalogCard) => boolean;
}

/**
 * The card search (docs/deck-builder.md, Search): fuzzy text, kinds and a sort over every card. `blocker` says why a
 * card can't be used here; those cards are dimmed and listed last. Right-click (or a tap) calls `onAct`, and cards can
 * be dragged out; `onDrop` takes cards dragged back in.
 */
export function CardSearch({
  catalog,
  blocker,
  badges,
  onShow,
  onAct,
  onDrop,
  filter,
  actHint,
}: {
  catalog: Catalog;
  blocker: (card: CatalogCard) => string | null;
  badges: (card: CatalogCard) => ReactNode;
  onShow: (c: CatalogCard) => void;
  onAct: (c: CatalogCard) => void;
  onDrop?: (d: Dragged) => void;
  filter?: ExtraFilter;
  actHint: string;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [only, setOnly] = useState(false);
  const [shownCount, setShownCount] = useState(PAGE);
  const query = text.trim();
  const target = useDropTarget(onDrop ?? (() => {}));

  // Search order (or the chosen sort when there's no search), then cards that can be used ahead of those that can't.
  const results = useMemo(() => {
    const found = query ? catalog.search(query).flatMap((c) => catalog.byCode.get(c) ?? []) : catalog.cards.slice();
    const fits = found.filter(
      (c) => (kind === 'all' || (kind === 'extra' ? c.extraDeck : c.kind === kind && !c.extraDeck)) && (!only || !filter || filter.test(c)),
    );
    if (!query && sort !== 'name') fits.sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
    const ranked = fits.map((card) => ({ card, blocker: blocker(card) }));
    return [...ranked.filter((r) => !r.blocker), ...ranked.filter((r) => r.blocker)];
  }, [catalog, query, kind, sort, only, filter, blocker]);

  useEffect(() => setShownCount(PAGE), [query, kind, sort, only]);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShownCount((n) => n + PAGE);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [results, shownCount]);

  return (
    <div className={`box builder-search${target.over ? ' drop-over' : ''}`} {...(onDrop ? target.props : {})}>
      <input
        type="search"
        className="search-box"
        placeholder="Search names and card text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Search cards"
      />
      <div className="row search-filters">
        <div className="chips" role="radiogroup" aria-label="Kind">
          {KINDS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={kind === k} className={`chip${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
          {filter && (
            <button role="checkbox" aria-checked={only} className={`chip${only ? ' on' : ''}`} onClick={() => setOnly(!only)}>
              {filter.label}
            </button>
          )}
        </div>
        {!query && (
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
            <option value="name">Name</option>
            <option value="atk">ATK</option>
            <option value="def">DEF</option>
            <option value="level">Level</option>
          </select>
        )}
      </div>
      <p className="muted small">
        {results.length} {results.length === 1 ? 'card' : 'cards'}
      </p>
      <div className="search-results">
        {results.slice(0, shownCount).map(({ card, blocker }) => (
          <button
            key={card.code}
            className={`plain result${blocker ? ' blocked' : ''}`}
            draggable={!blocker && onDrop !== undefined}
            onDragStart={(e) => startDrag(e, { code: card.code, from: null })}
            onMouseEnter={() => onShow(card)}
            onFocus={() => onShow(card)}
            {...clicks(() => onShow(card), () => (blocker ? onShow(card) : onAct(card)))}
            title={blocker ?? actHint}
          >
            <PoolFace card={card} />
            {badges(card)}
            {blocker && <span className="blocker">{blocker}</span>}
          </button>
        ))}
        {shownCount < results.length && <div ref={more} className="more" />}
      </div>
    </div>
  );
}

/** A card's image; only cards in the pool have downloaded images, so the rest are drawn as text without asking. */
export const PoolFace = ({ card }: { card: CatalogCard }) => (card.inPool ? <CardFace card={card} /> : <TextFace card={card} />);
