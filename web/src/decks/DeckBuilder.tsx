import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deckProblems, type Banlist, type BanlistSummary, type DeckDetail, type DeckList, type DeckSave, type DeckSummary } from '@yugioh/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText, useBanlist, useBanlists } from '../api.ts';
import { CopyLink } from '../CopyLink.tsx';
import { Loading, Notice } from '../pages/Notice.tsx';
import { useCatalog, type Catalog } from './catalog.ts';
import { DeckEditor } from './DeckEditor.tsx';
import { DownloadYdk } from './ydk.tsx';

/** How long the deck rests unchanged before it saves. */
const SAVE_DELAY_MS = 700;

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
  const queryClient = useQueryClient();
  const save = useAutosave(JSON.stringify({ name: name.trim() || 'Untitled deck', shared, banlistId, ...list } satisfies DeckSave), (body) =>
    api<DeckSummary>(`/decks/${deck.id}`, { method: 'PUT', body, keepalive: true }).then(() => void queryClient.invalidateQueries({ queryKey: ['decks'] })),
  );
  const problems = useMemo(() => deckProblems(list, (c) => catalog.byCode.get(c), banlist), [list, catalog, banlist]);

  return (
    <DeckEditor catalog={catalog} banlist={banlist} list={list} onChange={setList}>
      <div className="builder-head">
        <Link to="/decks" className="back">← Your decks</Link>
        <input className="deck-title" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Deck name" />
        <SaveState state={save.state} />
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
      <DeckProblems problems={problems} />
    </DeckEditor>
  );
}

/** What keeps the deck out of a duel, or that nothing does. */
export function DeckProblems({ problems }: { problems: string[] }) {
  return problems.length > 0 ? (
    <ul className="deck-problems">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  ) : (
    <p className="deck-legal">Ready to duel</p>
  );
}

export function SaveState({ state }: { state: 'saved' | 'saving' | 'error' }) {
  return <span className={`save-state ${state}`}>{state === 'saving' ? 'Saving…' : state === 'error' ? "Couldn't save" : 'Saved'}</span>;
}

/**
 * Saves `body` with `put` once it has rested unchanged for a moment, and once more on leaving if a change is waiting.
 * `body` starts out saved.
 */
export function useAutosave(body: string, put: (body: string) => Promise<unknown>) {
  const saved = useRef(body);
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const send = (json: string) =>
    put(json).then(() => {
      saved.current = json;
    });
  useEffect(() => {
    if (body === saved.current) return;
    setState('saving');
    const timer = setTimeout(() => {
      send(body).then(
        () => setState('saved'),
        () => setState('error'),
      );
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });
  const latest = useRef(body);
  latest.current = body;
  useEffect(() => () => void (latest.current !== saved.current && send(latest.current).catch(() => {})), []);
  return { state, dirty: body !== saved.current };
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
