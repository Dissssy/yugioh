import { matchesTerms, parseQuery, QUERY_FIELDS, setTerm, termValue, type CatalogCard, type QueryField } from '@yugioh/shared';
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

/** Words of card types the Card type menu offers, as `is:` terms. */
const TYPE_WORDS = ['normal', 'effect', 'tuner', 'flip', 'ritual', 'fusion', 'synchro', 'xyz', 'link', 'pendulum', 'toon', 'spirit', 'union', 'gemini'];

/**
 * The card search (docs/deck-builder.md, Search): fuzzy text, `field:value` terms, kinds and a sort over every card. `blocker` says why a
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
  const [panel, setPanel] = useState<'filters' | 'help' | null>(null);
  const [shownCount, setShownCount] = useState(PAGE);
  const parsed = useMemo(() => parseQuery(text), [text]);
  const query = parsed.words.trim();
  const target = useDropTarget(onDrop ?? (() => {}));

  // Search order (or the chosen sort when there are no words), then cards that can be used ahead of those that can't.
  const results = useMemo(() => {
    const found = query ? catalog.search(query).flatMap((c) => catalog.byCode.get(c) ?? []) : catalog.cards.slice();
    const fits = found.filter(
      (c) =>
        (kind === 'all' || (kind === 'extra' ? c.extraDeck : c.kind === kind && !c.extraDeck)) &&
        (!only || !filter || filter.test(c)) &&
        matchesTerms(c, parsed.terms),
    );
    if (!query && sort !== 'name') fits.sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
    const ranked = fits.map((card) => ({ card, blocker: blocker(card) }));
    return [...ranked.filter((r) => !r.blocker), ...ranked.filter((r) => r.blocker)];
  }, [catalog, query, parsed, kind, sort, only, filter, blocker]);

  useEffect(() => setShownCount(PAGE), [text, kind, sort, only]);
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
        placeholder="Search names and text, or terms like atk:>=1800"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Search cards"
      />
      {parsed.errors.map((e) => (
        <p key={e} className="error small">{e}</p>
      ))}
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
        <button
          className={`chip${panel === 'filters' || parsed.terms.length > 0 ? ' on' : ''}`}
          aria-expanded={panel === 'filters'}
          onClick={() => setPanel(panel === 'filters' ? null : 'filters')}
        >
          Filters{parsed.terms.length > 0 ? ` (${parsed.terms.length})` : ''}
        </button>
        <button className={`chip${panel === 'help' ? ' on' : ''}`} aria-expanded={panel === 'help'} aria-label="Search help" onClick={() => setPanel(panel === 'help' ? null : 'help')}>
          ?
        </button>
        {!query && (
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
            <option value="name">Name</option>
            <option value="atk">ATK</option>
            <option value="def">DEF</option>
            <option value="level">Level</option>
          </select>
        )}
      </div>
      {panel === 'filters' && <Filters catalog={catalog} text={text} onText={setText} />}
      {panel === 'help' && <SearchHelp onExample={(example) => setText(`${text.trim()} ${example}`.trim())} />}
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

/**
 * Menus for the common terms. Each writes its term into the search box, and shows the term the box has, so typing and
 * picking stay the same search.
 */
function Filters({ catalog, text, onText }: { catalog: Catalog; text: string; onText: (text: string) => void }) {
  const options = useMemo(() => {
    const sorted = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null && v !== ''))].sort();
    return {
      attr: sorted(catalog.cards.map((c) => c.attribute)),
      monsterTypes: sorted(catalog.cards.filter((c) => c.kind === 'monster').map((c) => c.race)),
      properties: sorted(catalog.cards.filter((c) => c.kind !== 'monster').map((c) => c.race)),
      arch: sorted(catalog.cards.map((c) => c.archetype)),
    };
  }, [catalog]);
  const value = (field: QueryField) => termValue(text, field) ?? '';
  // Typed a letter at a time, so the box keeps what was typed (spaces too) while the search gets it trimmed.
  const [arch, setArch] = useState(value('arch'));
  const set = (field: QueryField) => (v: string) => onText(setTerm(text, field, v === '' ? null : v));
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // A menu shows the term's value as the card data spells it, so `attr:dark` picks DARK.
  const pick = (field: QueryField, list: string[]) => list.find((o) => same(o, value(field))) ?? value(field);
  return (
    <div className="search-panel">
      <label className="field">
        <span className="small">Attribute</span>
        <select value={pick('attr', options.attr)} onChange={(e) => set('attr')(e.target.value)}>
          <option value="">Any</option>
          {options.attr.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="small">Type or property</span>
        <select value={pick('type', [...options.monsterTypes, ...options.properties])} onChange={(e) => set('type')(e.target.value)}>
          <option value="">Any</option>
          <optgroup label="Monster types">
            {options.monsterTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </optgroup>
          <optgroup label="Spell and Trap properties">
            {options.properties.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="field">
        <span className="small">Level or Rank</span>
        <select value={value('level')} onChange={(e) => set('level')(e.target.value)}>
          <option value="">Any</option>
          {Array.from({ length: 13 }, (_, i) => (
            <option key={i} value={String(i)}>{i}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="small">Card type</span>
        <select value={value('is').toLowerCase()} onChange={(e) => set('is')(e.target.value)}>
          <option value="">Any</option>
          {TYPE_WORDS.map((w) => (
            <option key={w} value={w}>{w[0]!.toUpperCase() + w.slice(1)}</option>
          ))}
        </select>
      </label>
      <label className="field wide">
        <span className="small">Archetype</span>
        <input
          list="archetypes"
          value={arch}
          placeholder="Any"
          onChange={(e) => {
            setArch(e.target.value);
            set('arch')(e.target.value.trim());
          }}
        />
        <datalist id="archetypes">
          {options.arch.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </label>
      {text.trim() !== '' && (
        <button
          className="quiet"
          onClick={() => {
            setArch('');
            onText('');
          }}
        >
          Clear the search
        </button>
      )}
    </div>
  );
}

/** What the search box understands, with examples that add themselves to the search. */
function SearchHelp({ onExample }: { onExample: (example: string) => void }) {
  return (
    <div className="search-panel search-help">
      <p className="small">
        Words search names and card text, forgiving typos. Add terms to narrow it down: <code>field:value</code>, with{' '}
        <code>&gt;</code>, <code>&gt;=</code>, <code>&lt;</code>, <code>&lt;=</code> or a range like <code>4-6</code> for numbers,
        quotes around values with spaces, and <code>-</code> in front to leave matches out.
      </p>
      <dl>
        {QUERY_FIELDS.map((f) => (
          <div key={f.field}>
            <dt>
              <button className="plain link" onClick={() => onExample(f.example)} title="Add to the search">
                <code>{f.example}</code>
              </button>
            </dt>
            <dd className="small muted">
              {f.help}
              {f.aliases.length > 0 && ` (also ${f.aliases.map((a) => `${a}:`).join(', ')})`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="small muted">
        For example, <code>dragon atk:&gt;=2000 -is:effect</code> finds Normal monsters about dragons with 2000 ATK or more.
      </p>
    </div>
  );
}

/** A card's image; only cards in the pool have downloaded images, so the rest are drawn as text without asking. */
export const PoolFace = ({ card }: { card: CatalogCard }) => (card.inPool ? <CardFace card={card} /> : <TextFace card={card} />);
