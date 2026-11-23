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
 * Makes a new deck from a `.ydk` file and opens it. Passcodes no card has are left out and counted, so the deck isn't
 * opened before the player has read that.
 */
export function ImportYdk() {
  const { catalog } = useCatalog();
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [skipped, setSkipped] = useState<{ id: number; count: number } | null>(null);
  const create = useMutation({
    mutationFn: async (file: File) => {
      const parsed = parseYdk(await file.text(), (code) => catalog!.resolve(code));
      const { unknown, ...lists } = parsed;
      const name = file.name.replace(/\.ydk$/i, '').trim().slice(0, 60) || 'Imported deck';
      const deck = await api<DeckSummary>('/decks', { method: 'POST', body: JSON.stringify({ name, ...lists, shared: false, banlistId: null }) });
      return { deck, unknown: unknown.length };
    },
    onSuccess: ({ deck, unknown }) => {
      void queryClient.invalidateQueries({ queryKey: ['decks'] });
      if (unknown === 0) void navigate(`/decks/${deck.id}`);
      else setSkipped({ id: deck.id, count: unknown });
    },
  });
  return (
    <>
      <button type="button" onClick={() => input.current?.click()} disabled={!catalog || create.isPending}>
        Import .ydk
      </button>
      <input
        ref={input}
        type="file"
        accept=".ydk,text/plain"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) create.mutate(file);
        }}
      />
      {create.isError && <span className="error small">{errorText(create.error)}</span>}
      {skipped && (
        <span className="small">
          Imported, but {skipped.count} {skipped.count === 1 ? "card wasn't" : "cards weren't"} recognised and left out.{' '}
          <Link to={`/decks/${skipped.id}`}>Open the deck</Link>
        </span>
      )}
    </>
  );
}
