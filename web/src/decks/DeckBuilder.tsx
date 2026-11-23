import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  addBlocker,
  copiesIn,
  deckProblems,
  homeSection,
  SECTION_NAME,
  SECTIONS,
  type CatalogCard,
  type DeckDetail,
  type DeckList,
  type DeckSave,
  type DeckSummary,
  type Section,
} from '@yugioh/shared';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText } from '../api.ts';
import { CardFace } from '../board/Card.tsx';
import { CardDetail } from '../board/CardDetail.tsx';
import { CopyLink } from '../CopyLink.tsx';
import { Loading, Notice } from '../pages/Notice.tsx';
import { useCatalog, type Catalog } from './catalog.ts';

/** How long the deck rests unchanged before it saves. */
const SAVE_DELAY_MS = 700;
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

const KIND_ORDER = { monster: 0, spell: 1, trap: 2 } as const;
/** Decks show monsters, then Spells, then Traps, each by name, so copies sit together. */
const deckOrder = (a: CatalogCard, b: CatalogCard) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);

/** What a drag carries: a card, and the section it came from when it was in the deck. */
interface Dragged {
  code: number;
  from: Section | null;
}
const DRAG_TYPE = 'application/x-deck-card';

/** The owner's deck, editable, saving itself as it changes (docs/deck-builder.md, The page). */
export function DeckBuilder({ deck }: { deck: DeckDetail }) {
  const { catalog, isError } = useCatalog();
  if (isError) return <Notice title="Can't load the cards" tone="error">Reload the page to try again.</Notice>;
  if (!catalog) return <Loading />;
  return <Builder deck={deck} catalog={catalog} />;
}

function Builder({ deck, catalog }: { deck: DeckDetail; catalog: Catalog }) {
  const [name, setName] = useState(deck.name);
  const [shared, setShared] = useState(deck.shared);
  const [list, setList] = useState<DeckList>(() => ({
    main: deck.main.map((c) => c.code),
    extra: deck.extra.map((c) => c.code),
    side: deck.side.map((c) => c.code),
  }));
  const [shown, setShown] = useState<CatalogCard | null>(() => catalog.byCode.get(deck.main[0]?.code ?? -1) ?? null);
  const [tab, setTab] = useState<'deck' | 'search'>('deck');
  const save = useAutosave(deck.id, { name: name.trim() || 'Untitled deck', shared, ...list });
  const problems = useMemo(() => deckProblems(list, (c) => catalog.byCode.get(c)), [list, catalog]);

  const add = (code: number, section: Section) => {
    const card = catalog.byCode.get(code);
    if (!card || addBlocker(list, code, card, section)) return;
    setList((l) => ({ ...l, [section]: [...l[section], code] }));
  };
  const remove = (code: number, section: Section) =>
    setList((l) => {
      const at = l[section].lastIndexOf(code);
      return at < 0 ? l : { ...l, [section]: l[section].toSpliced(at, 1) };
    });
  const move = (code: number, from: Section, to: Section) => {
    const card = catalog.byCode.get(code);
    if (!card || from === to) return;
    // The card is already counted once, so check the destination as if it had left.
    const without = { ...list, [from]: list[from].toSpliced(list[from].lastIndexOf(code), 1) };
    if (addBlocker(without, code, card, to)) return;
    setList({ ...without, [to]: [...without[to], code] });
  };
  const drop = (to: Section) => (d: Dragged) => (d.from ? move(d.code, d.from, to) : add(d.code, to));

  return (
    <section className="builder" data-tab={tab}>
      <aside className="box builder-detail">
        {shown ? <ShownCard card={shown} list={list} onAdd={add} onRemove={remove} /> : <p className="muted">Point at a card to see it here.</p>}
      </aside>

      <div className="builder-deck">
        <div className="builder-head">
          <Link to="/decks" className="back">← Your decks</Link>
          <input className="deck-title" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Deck name" />
          <span className={`save-state ${save.state}`}>{save.state === 'saving' ? 'Saving…' : save.state === 'error' ? "Couldn't save" : 'Saved'}</span>
        </div>
        <div className="row builder-actions">
          <label className="switch">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Anyone with the link can see it
          </label>
          {shared && <CopyLink path={`/decks/${deck.id}`} />}
          <CopyDeck deck={{ name: `${name} (copy)`, shared: false, ...list }} />
          <DeleteDeck id={deck.id} />
        </div>
        {problems.length > 0 ? (
          <ul className="deck-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="deck-legal">Ready to duel</p>
        )}
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'deck'} onClick={() => setTab('deck')}>Deck</button>
          <button role="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>Add cards</button>
        </div>
        {SECTIONS.map((section) => (
          <DeckSection
            key={section}
            section={section}
            cards={list[section].flatMap((c) => catalog.byCode.get(c) ?? []).sort(deckOrder)}
            onShow={setShown}
            onRemove={(code) => remove(code, section)}
            onDrop={drop(section)}
          />
        ))}
      </div>

      <CardSearch catalog={catalog} list={list} onShow={setShown} onAdd={(c) => add(c.code, homeSection(c))} onDrop={(d) => d.from && remove(d.code, d.from)} />
    </section>
  );
}

/** Saves the deck once it has rested unchanged for a moment, and once more on leaving if a change is waiting. */
function useAutosave(id: number, deck: DeckSave) {
  const queryClient = useQueryClient();
  const body = JSON.stringify(deck);
  const saved = useRef(body);
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const put = (json: string) =>
    api<DeckSummary>(`/decks/${id}`, { method: 'PUT', body: json, keepalive: true }).then(() => {
      saved.current = json;
      void queryClient.invalidateQueries({ queryKey: ['decks'] });
    });
  useEffect(() => {
    if (body === saved.current) return;
    setState('saving');
    const timer = setTimeout(() => {
      put(body).then(
        () => setState('saved'),
        () => setState('error'),
      );
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });
  const latest = useRef(body);
  latest.current = body;
  useEffect(() => () => void (latest.current !== saved.current && put(latest.current).catch(() => {})), []);
  return { state };
}

function DeckSection({
  section,
  cards,
  onShow,
  onRemove,
  onDrop,
}: {
  section: Section;
  cards: CatalogCard[];
  onShow: (c: CatalogCard) => void;
  onRemove: (code: number) => void;
  onDrop: (d: Dragged) => void;
}) {
  const target = useDropTarget(onDrop);
  return (
    <div className={`deck-section${target.over ? ' drop-over' : ''}`} {...target.props}>
      <h2>
        {SECTION_NAME[section]} <span className="count">{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="muted small">{section === 'side' ? 'Drag cards here to keep them on the side.' : 'Click a card in the search to add it.'}</p>
      ) : (
        <div className="card-grid">
          {cards.map((card, i) => (
            <button
              key={i}
              className="plain"
              title="Click to remove"
              draggable
              onDragStart={(e) => startDrag(e, { code: card.code, from: section })}
              onMouseEnter={() => onShow(card)}
              onFocus={() => onShow(card)}
              onClick={() => onRemove(card.code)}
            >
              <CardFace card={card} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CardSearch({
  catalog,
  list,
  onShow,
  onAdd,
  onDrop,
}: {
  catalog: Catalog;
  list: DeckList;
  onShow: (c: CatalogCard) => void;
  onAdd: (c: CatalogCard) => void;
  onDrop: (d: Dragged) => void;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [shownCount, setShownCount] = useState(PAGE);
  const query = text.trim();
  const target = useDropTarget(onDrop);

  // Search order (or the chosen sort when there's no search), then cards that can be added ahead of those that can't.
  const results = useMemo(() => {
    const found = query ? catalog.search(query).flatMap((c) => catalog.byCode.get(c) ?? []) : catalog.cards.slice();
    const fits = found.filter(
      (c) => kind === 'all' || (kind === 'extra' ? c.extraDeck : c.kind === kind && !c.extraDeck),
    );
    if (!query && sort !== 'name') fits.sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
    const ranked = fits.map((card) => ({ card, blocker: addBlocker(list, card.code, card, homeSection(card)) }));
    return [...ranked.filter((r) => !r.blocker), ...ranked.filter((r) => r.blocker)];
  }, [catalog, query, kind, sort, list]);

  useEffect(() => setShownCount(PAGE), [query, kind, sort]);
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
    <div className={`box builder-search${target.over ? ' drop-over' : ''}`} {...target.props}>
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
            draggable={!blocker}
            onDragStart={(e) => startDrag(e, { code: card.code, from: null })}
            onMouseEnter={() => onShow(card)}
            onFocus={() => onShow(card)}
            onClick={() => (blocker ? onShow(card) : onAdd(card))}
            title={blocker ?? `Add ${card.name}`}
          >
            <CardFace card={card} />
            {copiesIn(list, card.code) > 0 && <span className="copies">{copiesIn(list, card.code)}</span>}
            {blocker && <span className="blocker">{blocker}</span>}
          </button>
        ))}
        {shownCount < results.length && <div ref={more} className="more" />}
      </div>
    </div>
  );
}

/** The card being looked at, with how many copies each section has and buttons to change that. */
function ShownCard({
  card,
  list,
  onAdd,
  onRemove,
}: {
  card: CatalogCard;
  list: DeckList;
  onAdd: (code: number, s: Section) => void;
  onRemove: (code: number, s: Section) => void;
}) {
  const sections: Section[] = [homeSection(card), 'side'];
  const blocked = addBlocker(list, card.code, card, homeSection(card));
  return (
    <>
      {blocked && <p className="blocker-text">{blocked}</p>}
      <div className="copy-controls">
        {sections.map((s) => {
          const n = list[s].filter((c) => c === card.code).length;
          return (
            <div key={s} className="copy-control">
              <span>{SECTION_NAME[s]}</span>
              <button onClick={() => onRemove(card.code, s)} disabled={n === 0} aria-label={`Remove one from the ${SECTION_NAME[s]}`}>−1</button>
              <span className="copy-count">{n}</span>
              <button onClick={() => onAdd(card.code, s)} disabled={addBlocker(list, card.code, card, s) !== null} aria-label={`Add one to the ${SECTION_NAME[s]}`}>+1</button>
            </div>
          );
        })}
      </div>
      <CardDetail card={card} />
      {card.archetype && <p className="muted small">Archetype: {card.archetype}</p>}
    </>
  );
}

/** Saves the deck as a new deck of the viewer's and opens it. */
export function CopyDeck({ deck, label = 'Save as copy', className }: { deck: DeckSave; label?: string; className?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useMutation({
    mutationFn: () => api<DeckSummary>('/decks', { method: 'POST', body: JSON.stringify(deck) }),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: ['decks'] });
      void navigate(`/decks/${d.id}`);
    },
  });
  return (
    <>
      <button className={className} onClick={() => copy.mutate()} disabled={copy.isPending}>{label}</button>
      {copy.isError && <span className="error small">{errorText(copy.error)}</span>}
    </>
  );
}

function DeleteDeck({ id }: { id: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sure, setSure] = useState(false);
  const del = useMutation({
    mutationFn: () => api(`/decks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['deck', String(id)] });
      void queryClient.invalidateQueries({ queryKey: ['decks'] });
      void navigate('/decks');
    },
  });
  return sure ? (
    <span className="row">
      <button className="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete it</button>
      <button className="quiet" onClick={() => setSure(false)}>Keep it</button>
    </span>
  ) : (
    <button className="quiet" onClick={() => setSure(true)}>Delete</button>
  );
}

function startDrag(e: DragEvent, d: Dragged) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d));
  e.dataTransfer.effectAllowed = 'move';
}

/** A place a dragged card can be dropped, lit while one is over it. */
function useDropTarget(onDrop: (d: Dragged) => void) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        onDrop(JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Dragged);
      },
    },
  };
}
