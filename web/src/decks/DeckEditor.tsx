import {
  addBlocker,
  allowed,
  copiesIn,
  homeSection,
  LIMIT_NAME,
  MAX_COPIES,
  SECTION_NAME,
  SECTIONS,
  type Banlist,
  type CatalogCard,
  type DeckList,
  type Section,
} from '@yugioh/shared';
import { useCallback, useState, type ReactNode } from 'react';
import { CardDetail } from '../board/CardDetail.tsx';
import type { Catalog } from './catalog.ts';
import { CardSearch, PoolFace } from './CardSearch.tsx';
import { clicks, peekProps, startDrag, usePeek, useDropTarget, type Dragged, type Peek } from './interaction.ts';

const KIND_ORDER = { monster: 0, spell: 1, trap: 2 } as const;
/** Decks show monsters, then Spells, then Traps, each by name, so copies sit together. */
const deckOrder = (a: CatalogCard, b: CatalogCard) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);

/**
 * A deck's cards, the card being looked at, and the search to add more (docs/deck-builder.md, The page). With
 * `swapOnly`, cards only move between the Side Deck and the rest, as in a premade-only challenge. `children` heads the
 * deck column: the deck's name, actions and problems.
 */
export function DeckEditor({
  catalog,
  banlist,
  list,
  onChange,
  swapOnly = false,
  children,
}: {
  catalog: Catalog;
  banlist: Banlist;
  list: DeckList;
  onChange: (list: DeckList) => void;
  swapOnly?: boolean;
  children: ReactNode;
}) {
  const { shown, isPinned, peek } = usePeek<CatalogCard>(catalog.byCode.get(list.main[0] ?? -1) ?? null);
  const [tab, setTab] = useState<'deck' | 'search'>('deck');
  const blocker = useCallback((card: CatalogCard) => addBlocker(list, card.code, card, homeSection(card), banlist), [list, banlist]);

  const add = (code: number, section: Section) => {
    const card = catalog.byCode.get(code);
    if (swapOnly || !card || addBlocker(list, code, card, section, banlist)) return;
    onChange({ ...list, [section]: [...list[section], code] });
  };
  const remove = (code: number, section: Section) => {
    const at = list[section].lastIndexOf(code);
    if (!swapOnly && at >= 0) onChange({ ...list, [section]: list[section].toSpliced(at, 1) });
  };
  const move = (code: number, from: Section, to: Section) => {
    const card = catalog.byCode.get(code);
    if (!card || from === to) return;
    // The card is already counted once, so check the destination as if it had left.
    const without = { ...list, [from]: list[from].toSpliced(list[from].lastIndexOf(code), 1) };
    // A swap only needs the card to fit where it goes: siding out a card the banlist Forbids is the point.
    const blocked = swapOnly ? to !== 'side' && to !== homeSection(card) : addBlocker(without, code, card, to, banlist) !== null;
    if (!blocked) onChange({ ...without, [to]: [...without[to], code] });
  };
  const drop = (to: Section) => (d: Dragged) => (d.from ? move(d.code, d.from, to) : add(d.code, to));
  // Right-click takes a card out, or with swaps only, moves it across to the other side.
  const act = (card: CatalogCard, section: Section) =>
    swapOnly ? move(card.code, section, section === 'side' ? homeSection(card) : 'side') : remove(card.code, section);

  return (
    <section className={`builder${swapOnly ? ' swap-only' : ''}`} data-tab={tab}>
      <aside className="box builder-detail">
        {shown ? (
          <ShownCard card={shown} pinned={isPinned} list={list} banlist={banlist} onAdd={add} onRemove={remove} swapOnly={swapOnly} />
        ) : (
          <p className="muted">Point at a card to see it here, or click it to keep it here.</p>
        )}
      </aside>

      <div className="builder-deck">
        {children}
        {!swapOnly && (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'deck'} onClick={() => setTab('deck')}>Deck</button>
            <button role="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>Add cards</button>
          </div>
        )}
        {SECTIONS.map((section) => (
          <DeckSection
            key={section}
            section={section}
            cards={list[section].flatMap((c) => catalog.byCode.get(c) ?? []).sort(deckOrder)}
            hint={swapOnly ? (section === 'side' ? 'Right-click to swap in' : 'Right-click to swap out') : 'Right-click to remove'}
            peek={peek}
            onAct={(card) => act(card, section)}
            onDrop={drop(section)}
          />
        ))}
      </div>

      {!swapOnly && (
        <CardSearch
          catalog={catalog}
          blocker={blocker}
          badges={(card) => <DeckBadges card={card} list={list} banlist={banlist} />}
          peek={peek}
          onAct={(c) => add(c.code, homeSection(c))}
          onDrop={(d) => d.from && remove(d.code, d.from)}
          actHint="Right-click to add"
        />
      )}
    </section>
  );
}

function DeckSection({
  section,
  cards,
  hint,
  peek,
  onAct,
  onDrop,
}: {
  section: Section;
  cards: CatalogCard[];
  hint: string;
  peek: Peek<CatalogCard>;
  onAct: (c: CatalogCard) => void;
  onDrop: (d: Dragged) => void;
}) {
  const target = useDropTarget(onDrop);
  return (
    <div className={`deck-section${target.over ? ' drop-over' : ''}`} {...target.props}>
      <h2>
        {SECTION_NAME[section]} <span className="count">{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="muted small">{section === 'side' ? 'Drag cards here to keep them on the side.' : 'Right-click a card in the search to add it.'}</p>
      ) : (
        <div className="card-grid">
          {cards.map((card, i) => (
            <button
              key={i}
              className="plain"
              title={hint}
              draggable
              onDragStart={(e) => startDrag(e, { code: card.code, from: section })}
              {...peekProps(peek, card)}
              {...clicks(() => peek.pin(card), () => onAct(card))}
            >
              <PoolFace card={card} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A search result's corner marks: copies in the deck, and the banlist's limit when it has one. */
function DeckBadges({ card, list, banlist }: { card: CatalogCard; list: DeckList; banlist: Banlist }) {
  const copies = copiesIn(list, card.code);
  return (
    <>
      {copies > 0 && <span className="copies">{copies}</span>}
      <LimitBadge limit={allowed(banlist, card.code)} />
    </>
  );
}

/** A banlist limit as a mark in the card's corner, as the game shows it; nothing for 3. */
export function LimitBadge({ limit }: { limit: number }) {
  if (limit >= MAX_COPIES) return null;
  return (
    <span className={`limit-badge l${limit}`} title={LIMIT_NAME[limit]}>
      {limit === 0 ? '✕' : limit}
    </span>
  );
}

/** The card being looked at, with how many copies each section has and, unless swapping, buttons to change that. */
function ShownCard({
  card,
  pinned,
  list,
  banlist,
  onAdd,
  onRemove,
  swapOnly,
}: {
  card: CatalogCard;
  pinned: boolean;
  list: DeckList;
  banlist: Banlist;
  onAdd: (code: number, s: Section) => void;
  onRemove: (code: number, s: Section) => void;
  swapOnly: boolean;
}) {
  const sections: Section[] = [homeSection(card), 'side'];
  const blocked = addBlocker(list, card.code, card, homeSection(card), banlist);
  const limit = allowed(banlist, card.code);
  return (
    <>
      {!swapOnly && blocked && <p className="blocker-text">{blocked}</p>}
      {limit < MAX_COPIES && <p className={limit === 0 ? 'blocker-text' : 'muted small'}>{LIMIT_NAME[limit]} under {banlist.name}</p>}
      {!swapOnly && (
        <div className="copy-controls">
          {sections.map((s) => {
            const n = list[s].filter((c) => c === card.code).length;
            return (
              <div key={s} className="copy-control">
                <span>{SECTION_NAME[s]}</span>
                <button onClick={() => onRemove(card.code, s)} disabled={n === 0} aria-label={`Remove one from the ${SECTION_NAME[s]}`}>−1</button>
                <span className="copy-count">{n}</span>
                <button onClick={() => onAdd(card.code, s)} disabled={addBlocker(list, card.code, card, s, banlist) !== null} aria-label={`Add one to the ${SECTION_NAME[s]}`}>+1</button>
              </div>
            );
          })}
        </div>
      )}
      <CardDetail card={card} image={card.inPool} />
      {pinned && <p className="muted small">Pinned. Point at another card to compare.</p>}
      {card.archetype && <p className="muted small">Archetype: {card.archetype}</p>}
    </>
  );
}
