import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  addBlocker,
  allowed,
  copiesIn,
  LIMIT_NAME,
  MAX_COPIES,
  deckProblems,
  homeSection,
  SECTION_NAME,
  SECTIONS,
  type Banlist,
  type BanlistSummary,
  type CatalogCard,
  type DeckDetail,
  type DeckList,
  type DeckSave,
  type DeckSummary,
  type Section,
} from '@yugioh/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useBanlist, useBanlists } from '../api.ts';
import { CardDetail } from '../board/CardDetail.tsx';
import { CopyLink } from '../CopyLink.tsx';
import { Loading, Notice } from '../pages/Notice.tsx';
import { useCatalog, type Catalog } from './catalog.ts';
import { CardSearch, PoolFace } from './CardSearch.tsx';
import { DownloadYdk } from './ydk.tsx';
import { clicks, startDrag, useDropTarget, type Dragged } from './interaction.ts';

/** How long the deck rests unchanged before it saves. */
const SAVE_DELAY_MS = 700;
const KIND_ORDER = { monster: 0, spell: 1, trap: 2 } as const;
/** Decks show monsters, then Spells, then Traps, each by name, so copies sit together. */
const deckOrder = (a: CatalogCard, b: CatalogCard) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);

/** The owner's deck, editable, saving itself as it changes (docs/deck-builder.md, The page). */
export function DeckBuilder({ deck }: { deck: DeckDetail }) {
  const { catalog, isError } = useCatalog();
  const banlists = useBanlists();
  const [banlistId, setBanlistId] = useState(deck.banlistId);
  // A deck without a banlist of its own is built for the default list, the first one.
  const banlist = useBanlist(banlistId ?? banlists.data?.find((b) => b.isDefault)?.id ?? null);
  if (isError || banlists.isError || banlist.isError) return <Notice title="Can't load the cards" tone="error">Reload the page to try again.</Notice>;
  if (!catalog || !banlists.data || !banlist.data) return <Loading />;
  return <Builder deck={deck} catalog={catalog} banlists={banlists.data} banlist={banlist.data} banlistId={banlistId} onBanlist={setBanlistId} />;
}

function Builder({
  deck,
  catalog,
  banlists,
  banlist,
  banlistId,
  onBanlist,
}: {
  deck: DeckDetail;
  catalog: Catalog;
  banlists: BanlistSummary[];
  banlist: Banlist;
  banlistId: number | null;
  onBanlist: (id: number | null) => void;
}) {
  const [name, setName] = useState(deck.name);
  const [shared, setShared] = useState(deck.shared);
  const [list, setList] = useState<DeckList>(() => ({
    main: deck.main.map((c) => c.code),
    extra: deck.extra.map((c) => c.code),
    side: deck.side.map((c) => c.code),
  }));
  const [shown, setShown] = useState<CatalogCard | null>(() => catalog.byCode.get(deck.main[0]?.code ?? -1) ?? null);
  const [tab, setTab] = useState<'deck' | 'search'>('deck');
  const save = useAutosave(deck.id, { name: name.trim() || 'Untitled deck', shared, banlistId, ...list });
  const problems = useMemo(() => deckProblems(list, (c) => catalog.byCode.get(c), banlist), [list, catalog, banlist]);
  const blocker = useCallback((card: CatalogCard) => addBlocker(list, card.code, card, homeSection(card), banlist), [list, banlist]);

  const add = (code: number, section: Section) => {
    const card = catalog.byCode.get(code);
    if (!card || addBlocker(list, code, card, section, banlist)) return;
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
    if (addBlocker(without, code, card, to, banlist)) return;
    setList({ ...without, [to]: [...without[to], code] });
  };
  const drop = (to: Section) => (d: Dragged) => (d.from ? move(d.code, d.from, to) : add(d.code, to));

  return (
    <section className="builder" data-tab={tab}>
      <aside className="box builder-detail">
        {shown ? <ShownCard card={shown} list={list} banlist={banlist} onAdd={add} onRemove={remove} /> : <p className="muted">Point at a card to see it here.</p>}
      </aside>

      <div className="builder-deck">
        <div className="builder-head">
          <Link to="/decks" className="back">← Your decks</Link>
          <input className="deck-title" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Deck name" />
          <span className={`save-state ${save.state}`}>{save.state === 'saving' ? 'Saving…' : save.state === 'error' ? "Couldn't save" : 'Saved'}</span>
        </div>
        <div className="row builder-actions">
          <label className="switch">
            Banlist
            <select value={banlistId ?? ''} onChange={(e) => onBanlist(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">Default ({banlists.find((b) => b.isDefault)?.name})</option>
              {banlists.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label className="switch">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Anyone with the link can see it
          </label>
          {shared && <CopyLink path={`/decks/${deck.id}`} />}
          <CopyDeck deck={{ name: `${name} (copy)`, shared: false, banlistId, ...list }} />
          <DownloadYdk name={name} deck={list} />
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

      <CardSearch
        catalog={catalog}
        blocker={blocker}
        badges={(card) => <DeckBadges card={card} list={list} banlist={banlist} />}
        onShow={setShown}
        onAct={(c) => add(c.code, homeSection(c))}
        onDrop={(d) => d.from && remove(d.code, d.from)}
        actHint="Right-click to add"
      />
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
        <p className="muted small">{section === 'side' ? 'Drag cards here to keep them on the side.' : 'Right-click a card in the search to add it.'}</p>
      ) : (
        <div className="card-grid">
          {cards.map((card, i) => (
            <button
              key={i}
              className="plain"
              title="Right-click to remove"
              draggable
              onDragStart={(e) => startDrag(e, { code: card.code, from: section })}
              onMouseEnter={() => onShow(card)}
              onFocus={() => onShow(card)}
              {...clicks(() => onShow(card), () => onRemove(card.code))}
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

/** The card being looked at, with how many copies each section has and buttons to change that. */
function ShownCard({
  card,
  list,
  banlist,
  onAdd,
  onRemove,
}: {
  card: CatalogCard;
  list: DeckList;
  banlist: Banlist;
  onAdd: (code: number, s: Section) => void;
  onRemove: (code: number, s: Section) => void;
}) {
  const sections: Section[] = [homeSection(card), 'side'];
  const blocked = addBlocker(list, card.code, card, homeSection(card), banlist);
  const limit = allowed(banlist, card.code);
  return (
    <>
      {blocked && <p className="blocker-text">{blocked}</p>}
      {limit < MAX_COPIES && limit > 0 && <p className="muted small">{LIMIT_NAME[limit]} under {banlist.name}</p>}
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
      <CardDetail card={card} image={card.inPool} />
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
