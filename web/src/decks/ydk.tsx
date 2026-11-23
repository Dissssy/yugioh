import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseYdk, toYdk, type DeckList, type DeckSummary } from '@yugioh/shared';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText } from '../api.ts';
import { useCatalog } from './catalog.ts';

/** Saves the deck as `<name>.ydk` on the viewer's computer. */
export function DownloadYdk({ name, deck }: { name: string; deck: DeckList }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([toYdk(deck)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'deck'}.ydk`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return <button type="button" onClick={download}>Download .ydk</button>;
}

/**
 * A button that reads a `.ydk` file the player picks. `onDeck` gets the file's name without `.ydk`, the deck, and how
 * many passcodes no card has, which are left out.
 */
export function UploadYdk({ onDeck, disabled = false, label = 'Upload .ydk' }: { onDeck: (name: string, deck: DeckList, unknown: number) => void; disabled?: boolean; label?: string }) {
  const { catalog } = useCatalog();
  const input = useRef<HTMLInputElement>(null);
  const read = async (file: File) => {
    const { unknown, ...deck } = parseYdk(await file.text(), (code) => catalog!.resolve(code));
    onDeck(file.name.replace(/\.ydk$/i, '').trim().slice(0, 60), deck, unknown.length);
  };
  return (
    <>
      <button type="button" onClick={() => input.current?.click()} disabled={!catalog || disabled}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept=".ydk,text/plain"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void read(file);
        }}
      />
    </>
  );
}

/** Says how many of an uploaded file's cards weren't recognised, if any. */
export const skippedText = (count: number) => `${count} ${count === 1 ? "card wasn't" : "cards weren't"} recognised and left out.`;

/** Makes a new deck from a `.ydk` file and opens it, unless cards were left out: the player reads that first. */
export function ImportYdk() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [skipped, setSkipped] = useState<{ id: number; count: number } | null>(null);
  const create = useMutation({
    mutationFn: ({ name, deck }: { name: string; deck: DeckList; unknown: number }) =>
      api<DeckSummary>('/decks', { method: 'POST', body: JSON.stringify({ name: name || 'Imported deck', ...deck, shared: false, banlistId: null }) }),
    onSuccess: (deck, { unknown }) => {
      void queryClient.invalidateQueries({ queryKey: ['decks'] });
      if (unknown === 0) void navigate(`/decks/${deck.id}`);
      else setSkipped({ id: deck.id, count: unknown });
    },
  });
  return (
    <>
      <UploadYdk label="Import .ydk" disabled={create.isPending} onDeck={(name, deck, unknown) => create.mutate({ name, deck, unknown })} />
      {create.isError && <span className="error small">{errorText(create.error)}</span>}
      {skipped && (
        <span className="small">
          Imported, but {skippedText(skipped.count)} <Link to={`/decks/${skipped.id}`}>Open the deck</Link>
        </span>
      )}
    </>
  );
}
