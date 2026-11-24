import { useMutation, useQueryClient } from '@tanstack/react-query';
import { allowed, LIMIT_NAME, MAX_COPIES, type BanlistDetail, type BanlistSave, type BanlistSummary, type CatalogCard, type Me } from '@yugioh/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorText, useBanlist } from '../api.ts';
import { CardDetail } from '../board/CardDetail.tsx';
import { CopyLink } from '../CopyLink.tsx';
import { Loading, Notice } from '../pages/Notice.tsx';
import { useCatalog, type Catalog } from './catalog.ts';
import { CardSearch } from './CardSearch.tsx';
import { LimitBadge } from './DeckEditor.tsx';
import { peekProps, usePeek, type Peek } from './interaction.ts';

/** How long the list rests unchanged before it saves. */
const SAVE_DELAY_MS = 700;

/**
 * A banlist (docs/deck-builder.md, Banlists): its owner edits it here with the card search, setting each card to 0, 1,
 * 2 or 3 copies; anyone else who can see it looks at it and can copy it.
 */
export function BanlistPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const banlist = useBanlist(Number(id));
  const { catalog, isError } = useCatalog();
  if (banlist.isError)
    return (
      <Notice title="Banlist not found" tone="error" action={<Link className="button" to="/decks">Your decks</Link>}>
        This banlist doesn't exist, or its owner hasn't shared it.
      </Notice>
    );
  if (isError) return <Notice title="Can't load the cards" tone="error">Reload the page to try again.</Notice>;
  if (!banlist.data || !catalog) return <Loading />;
  return <Editor key={banlist.data.id} banlist={banlist.data} catalog={catalog} canCopy={me.kind === 'user' && me.user.status === 'approved'} />;
}

function Editor({ banlist, catalog, canCopy }: { banlist: BanlistDetail; catalog: Catalog; canCopy: boolean }) {
  const [name, setName] = useState(banlist.name);
  const [shared, setShared] = useState(banlist.shared);
  const [limits, setLimits] = useState(banlist.limits);
  const { shown, peek } = usePeek<CatalogCard>(null);
  const save = useAutosave(banlist.id, banlist.mine, { name: name.trim() || 'Untitled banlist', limits, shared });
  const current = { name, limits };
  const setLimit = (code: number, limit: number) =>
    setLimits(({ [code]: _, ...rest }) => (limit >= MAX_COPIES ? rest : { ...rest, [code]: limit }));
  // Right-click steps a card down a limit: 3, 2, 1, 0, then back to 3.
  const step = (card: CatalogCard) => setLimit(card.code, (allowed(current, card.code) + MAX_COPIES) % (MAX_COPIES + 1));
  const listed = useMemo(() => ({ label: `Listed (${Object.keys(limits).length})`, test: (c: CatalogCard) => c.code in limits }), [limits]);
  const noBlocker = useCallback(() => null, []);

  return (
    <section className="builder banlist-editor">
      <aside className="box builder-detail">
        {shown ? (
          <>
            <div className="chips limit-picker" role="radiogroup" aria-label="Copies allowed">
              {[0, 1, 2, 3].map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={allowed(current, shown.code) === n}
                  className={`chip${allowed(current, shown.code) === n ? ' on' : ''}`}
                  disabled={!banlist.mine}
                  onClick={() => setLimit(shown.code, n)}
                >
                  {LIMIT_NAME[n]}
                </button>
              ))}
            </div>
            <CardDetail card={shown} image={shown.inPool} />
          </>
        ) : (
          <p className="muted">Point at a card to see it here{banlist.mine ? ', and choose how many copies a deck may have' : ''}.</p>
        )}
      </aside>

      <div className="builder-deck">
        <div className="builder-head">
          <Link to="/decks" className="back">← Your decks</Link>
          {banlist.mine ? (
            <>
              <input className="deck-title" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Banlist name" />
              <span className={`save-state ${save}`}>{save === 'saving' ? 'Saving…' : save === 'error' ? "Couldn't save" : 'Saved'}</span>
            </>
          ) : (
            <h1>{banlist.name}</h1>
          )}
        </div>
        <div className="row builder-actions">
          {banlist.mine && (
            <label className="switch">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              Anyone with the link can see it
            </label>
          )}
          {(shared || banlist.isDefault) && <CopyLink path={`/banlists/${banlist.id}`} />}
          {canCopy && <CopyBanlist banlist={{ name: `${name} (copy)`, limits, shared: false }} />}
          {banlist.mine && <DeleteBanlist id={banlist.id} />}
        </div>
        <p className="muted small">
          {banlist.isDefault
            ? 'A default list, kept up to date from YGOPRODeck with every card import. Copy it to make your own changes.'
            : banlist.mine
              ? 'Right-click a card in the search to step it down: 3, 2, 1, Forbidden, then back to 3.'
              : 'Copy this list to make your own changes.'}
        </p>
        {[0, 1, 2].map((n) => (
          <LimitGroup key={n} limit={n} cards={Object.entries(limits).flatMap(([c, l]) => (l === n ? (catalog.byCode.get(Number(c)) ?? []) : []))} peek={peek} />
        ))}
      </div>

      <CardSearch
        catalog={catalog}
        blocker={noBlocker}
        badges={(card) => <LimitBadge limit={allowed(current, card.code)} />}
        peek={peek}
        onAct={banlist.mine ? step : peek.pin}
        filter={listed}
        actHint={banlist.mine ? 'Right-click to change its limit' : ''}
      />
    </section>
  );
}

function LimitGroup({ limit, cards, peek }: { limit: number; cards: CatalogCard[]; peek: Peek<CatalogCard> }) {
  return (
    <div className="deck-section">
      <h2>
        {LIMIT_NAME[limit]} <span className="count">{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ul className="limit-list">
          {cards
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((card) => (
              <li key={card.code}>
                <button className="plain" {...peekProps(peek, card)} onClick={() => peek.pin(card)}>
                  {card.name}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** Saves the owner's list once it has rested unchanged for a moment. Nothing for someone else's list. */
function useAutosave(id: number, mine: boolean, list: BanlistSave) {
  const queryClient = useQueryClient();
  const body = JSON.stringify(list);
  const saved = useRef(body);
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  useEffect(() => {
    if (!mine || body === saved.current) return;
    setState('saving');
    const timer = setTimeout(() => {
      api<BanlistSummary>(`/banlists/${id}`, { method: 'PUT', body, keepalive: true }).then(
        () => {
          saved.current = body;
          setState('saved');
          void queryClient.invalidateQueries({ queryKey: ['banlists'] });
          void queryClient.invalidateQueries({ queryKey: ['decks'] });
          queryClient.setQueryData<BanlistDetail>(['banlist', id], (old) => old && { ...old, ...list });
        },
        () => setState('error'),
      );
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });
  return state;
}

/** Saves the list as a new list of the viewer's and opens it. */
export function CopyBanlist({ banlist, label = 'Save as copy', className }: { banlist: BanlistSave; label?: string; className?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useMutation({
    mutationFn: () => api<BanlistSummary>('/banlists', { method: 'POST', body: JSON.stringify(banlist) }),
    onSuccess: (b) => {
      void queryClient.invalidateQueries({ queryKey: ['banlists'] });
      void navigate(`/banlists/${b.id}`);
    },
  });
  return (
    <>
      <button className={className} onClick={() => copy.mutate()} disabled={copy.isPending}>{label}</button>
      {copy.isError && <span className="error small">{errorText(copy.error)}</span>}
    </>
  );
}

function DeleteBanlist({ id }: { id: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sure, setSure] = useState(false);
  const del = useMutation({
    mutationFn: () => api(`/banlists/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['banlist', id] });
      void queryClient.invalidateQueries({ queryKey: ['banlists'] });
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
