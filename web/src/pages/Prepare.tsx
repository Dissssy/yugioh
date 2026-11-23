import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deckProblems,
  isSideSwap,
  SECTION_NAME,
  SECTIONS,
  type Banlist,
  type DeckList,
  type DuelDeck,
  type DuelDeckSave,
  type DuelPrep,
  type DuelSummary,
} from '@yugioh/shared';
import { useMemo, useState } from 'react';
import { api, errorText, useDecks } from '../api.ts';
import { useCatalog, type Catalog } from '../decks/catalog.ts';
import { DeckProblems, SaveState, useAutosave } from '../decks/DeckBuilder.tsx';
import { DeckEditor } from '../decks/DeckEditor.tsx';
import { DownloadYdk, skippedText, UploadYdk } from '../decks/ydk.tsx';
import { DeckPicker } from './Duels.tsx';
import { Loading, Notice } from './Notice.tsx';

/**
 * The pre-duel stage (docs/deck-builder.md): the player chooses a deck, changes this duel's copy of it as the challenge
 * allows, and presses Ready. The duel starts once both players are ready.
 */
export function Prepare({ duel }: { duel: DuelSummary }) {
  const prep = useQuery({ queryKey: ['duel-deck', duel.id], queryFn: () => api<DuelPrep>(`/duels/${duel.id}/deck`) });
  const { catalog, isError } = useCatalog();
  const [choosing, setChoosing] = useState(false);
  // Each newly chosen deck starts the editor afresh; `note` says what the upload left out.
  const [chosen, setChosen] = useState({ count: 0, note: null as string | null });
  if (prep.isError || isError) return <Notice title="Can't load your deck" tone="error">Reload the page to try again.</Notice>;
  if (!prep.data || !catalog) return <Loading />;
  const { deck, banlist } = prep.data;
  if (!deck || choosing)
    return (
      <ChooseDeck
        duel={duel}
        onChosen={(note) => {
          setChoosing(false);
          setChosen((c) => ({ count: c.count + 1, note }));
        }}
        onCancel={deck ? () => setChoosing(false) : null}
      />
    );
  return (
    <EditDuelDeck key={chosen.count} duel={duel} deck={deck} banlist={banlist} catalog={catalog} note={chosen.note} onChoose={() => setChoosing(true)} />
  );
}

/** What the challenge allows, and where the opponent is. */
function Terms({ duel }: { duel: DuelSummary }) {
  return (
    <p className="muted small">
      Both decks follow the <strong>{duel.banlist}</strong> banlist.{' '}
      {duel.premadeOnly
        ? 'This challenge is for premade decks only: you can swap cards between the Side Deck and the rest, one for one.'
        : 'Any deck that follows it can play, and changes you make here are for this duel only.'}
    </p>
  );
}

function OpponentStatus({ duel }: { duel: DuelSummary }) {
  const them = duel.players[duel.yourSeat === 0 ? 1 : 0];
  if (!them) return null;
  return <span className="opponent small">{them.ready ? <strong className="ok">{them.name} is ready</strong> : `${them.name} is choosing a deck`}</span>;
}

/** Saves the duel's copy of a deck, and keeps the page's copies of it and of the duel up to date. */
function useSaveDeck(duel: DuelSummary) {
  const queryClient = useQueryClient();
  return async (save: DuelDeckSave | string) => {
    const { deck } = await api<{ deck: DuelDeck }>(`/duels/${duel.id}/deck`, { method: 'PUT', body: typeof save === 'string' ? save : JSON.stringify(save) });
    queryClient.setQueryData<DuelPrep>(['duel-deck', duel.id], (p) => p && { ...p, deck });
    // Changing the deck takes back Ready.
    void queryClient.invalidateQueries({ queryKey: ['duel', duel.id] });
    return deck;
  };
}

function ChooseDeck({ duel, onChosen, onCancel }: { duel: DuelSummary; onChosen: (note: string | null) => void; onCancel: (() => void) | null }) {
  const decks = useDecks({ duel: duel.id });
  const save = useSaveDeck(duel);
  const choose = useMutation({ mutationFn: ({ save: body }: { save: DuelDeckSave; note: string | null }) => save(body), onSuccess: (_, { note }) => onChosen(note) });
  const offered = duel.premadeOnly ? decks.data?.filter((d) => d.premade) : decks.data;
  return (
    <section className="box prep-choose">
      <div className="row">
        <h1>Choose your deck</h1>
        <OpponentStatus duel={duel} />
      </div>
      <Terms duel={duel} />
      {/* A deck that breaks the rules can still be picked here, and fixed for this duel. */}
      <DeckPicker decks={offered} value={null} onChange={(deckId) => choose.mutate({ save: { deckId }, note: null })} pickIllegal={!duel.premadeOnly} />
      {!duel.premadeOnly && (
        <div className="row">
          <button onClick={() => choose.mutate({ save: { name: 'New deck', main: [], extra: [], side: [] }, note: null })} disabled={choose.isPending}>
            Start from an empty deck
          </button>
          <UploadYdk
            disabled={choose.isPending}
            onDeck={(name, deck, unknown) => choose.mutate({ save: { name: name || 'Uploaded deck', ...deck }, note: unknown > 0 ? skippedText(unknown) : null })}
          />
        </div>
      )}
      {onCancel && (
        <div>
          <button className="quiet" onClick={onCancel}>Keep the deck I had</button>
        </div>
      )}
      {choose.isError && <p className="error">{errorText(choose.error)}</p>}
    </section>
  );
}

function EditDuelDeck({
  duel,
  deck,
  banlist,
  catalog,
  note,
  onChoose,
}: {
  duel: DuelSummary;
  deck: DuelDeck;
  banlist: Banlist;
  catalog: Catalog;
  note: string | null;
  onChoose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(deck.name);
  const [list, setList] = useState<DeckList>({ main: deck.main, extra: deck.extra, side: deck.side });
  // The copy as the server last saved it: swaps count from there.
  const [saved, setSaved] = useState(deck);
  const swapOnly = duel.premadeOnly;
  // With swaps only, a change saves once every card swapped out has a card swapped in for it.
  const balanced = !swapOnly || isSideSwap(saved, list);
  const save = useSaveDeck(duel);
  const autosave = useAutosave(JSON.stringify({ name: name.trim() || 'Untitled deck', ...(balanced ? list : { main: saved.main, extra: saved.extra, side: saved.side }) }), (body) =>
    save(body).then(setSaved),
  );
  const premade = saved.premade && isSideSwap(saved, list);
  const problems = useMemo(() => {
    if (balanced) return deckProblems(list, (c) => catalog.byCode.get(c), banlist, { premade });
    return SECTIONS.filter((s) => s !== 'side' && list[s].length !== saved[s].length).map((s) =>
      list[s].length < saved[s].length
        ? `The ${SECTION_NAME[s]} has ${list[s].length} of its ${saved[s].length} cards: swap a Side Deck card in.`
        : `The ${SECTION_NAME[s]} has ${list[s].length} of its ${saved[s].length} cards: swap one out to the Side Deck.`,
    );
  }, [list, saved, balanced, catalog, banlist, premade]);
  const ready = useMutation({
    mutationFn: (value: boolean) => api<DuelSummary>(`/duels/${duel.id}/ready`, { method: 'POST', body: JSON.stringify({ ready: value }) }),
    onSuccess: (next) => queryClient.setQueryData(['duel', duel.id], next),
  });
  const youReady = duel.players[duel.yourSeat!]?.ready ?? false;
  const [shownNote, setNote] = useState(note);
  const upload = (uploaded: string, next: DeckList, unknown: number) => {
    setName(uploaded || name);
    setList(next);
    setNote(unknown > 0 ? skippedText(unknown) : null);
  };

  return (
    <DeckEditor catalog={catalog} banlist={banlist} list={list} onChange={setList} swapOnly={swapOnly}>
      <div className="builder-head">
        <input className="deck-title" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Deck name" />
        <SaveState state={autosave.state} />
      </div>
      <Terms duel={duel} />
      <div className="row builder-actions">
        <button onClick={onChoose}>Choose another deck</button>
        {!swapOnly && <UploadYdk onDeck={upload} />}
        <DownloadYdk name={name} deck={list} />
      </div>
      {shownNote && <p className="small">{shownNote}</p>}
      <DeckProblems problems={problems} />
      <div className="prep-ready">
        {youReady ? (
          <>
            <strong className="ok">You're ready</strong>
            <button onClick={() => ready.mutate(false)} disabled={ready.isPending}>Not ready</button>
          </>
        ) : (
          <button className="primary big" onClick={() => ready.mutate(true)} disabled={ready.isPending || problems.length > 0 || autosave.dirty}>
            Ready
          </button>
        )}
        {ready.isError && <span className="error small">{errorText(ready.error)}</span>}
        <OpponentStatus duel={duel} />
      </div>
    </DeckEditor>
  );
}
