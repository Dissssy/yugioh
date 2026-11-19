import type { LogEntry, LogEvent } from '@yugioh/engine';
import { useEffect, useRef, useState } from 'react';

/** Card IDs an event names, for highlighting them on the board. */
export function cardsOf(event: LogEvent): string[] {
  const ids: (string | null)[] = [];
  if ('card' in event) ids.push(event.card);
  if ('cards' in event) ids.push(...event.cards);
  if (event.type === 'attackDeclared') ids.push(event.attacker, event.target);
  return ids.filter((id): id is string => id !== null);
}

/** Contesting a judge's ruling: whether this player still may, and sending it with an optional note. */
export interface Contest {
  can(seq: number): boolean;
  send(seq: number, note: string): void;
}

/**
 * The duel log, grouped by turn. The current turn is open; earlier turns fold away. Hovering an entry highlights
 * the cards it names. The judge's rulings stand out and can be contested; an appeal's verdict follows them.
 */
export function DuelLog({ log, onHighlight, contest }: { log: LogEntry[]; onHighlight: (ids: string[]) => void; contest: Contest }) {
  const [contesting, setContesting] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const turns = new Map<number, LogEntry[]>();
  for (const entry of log) {
    if (entry.text === null) continue;
    turns.set(entry.turn, [...(turns.get(entry.turn) ?? []), entry]);
  }
  const current = log.at(-1)?.turn ?? 0;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [log.length]);

  return (
    <div className="duel-log" aria-label="Duel log">
      {[...turns].map(([turn, entries]) => (
        <details key={turn} open={turn >= current - 1 || undefined}>
          <summary>{turn === 0 ? 'Opening hands' : entries[0]?.event.type === 'turnStarted' ? entries[0].text : `Turn ${turn}`}</summary>
          <ol>
            {entries
              .filter((e) => e.event.type !== 'turnStarted')
              .map((e) => (
                <li
                  key={e.seq}
                  className={
                    e.event.type === 'judged' ? `ruling${e.event.legal ? '' : ' refused'}` : e.event.type === 'appealed' ? 'appeal' : e.event.type === 'chatted' ? 'chat' : undefined
                  }
                  onPointerEnter={() => onHighlight(cardsOf(e.event))}
                  onPointerLeave={() => onHighlight([])}
                >
                  {e.event.type === 'judged' && 'Judge: '}
                  {e.text}
                  {e.event.type === 'judged' && contest.can(e.seq) && contesting !== e.seq && (
                    <button className="quiet" onClick={() => (setContesting(e.seq), setNote(''))}>
                      Contest
                    </button>
                  )}
                  {contesting === e.seq && (
                    <form
                      className="contest"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        contest.send(e.seq, note.trim());
                        setContesting(null);
                      }}
                    >
                      <textarea rows={2} maxLength={500} placeholder="What's wrong with this ruling? (optional)" value={note} onChange={(ev) => setNote(ev.target.value)} autoFocus />
                      <span className="row">
                        <button type="submit">Send to appeal</button>
                        <button type="button" className="quiet" onClick={() => setContesting(null)}>
                          Cancel
                        </button>
                      </span>
                    </form>
                  )}
                </li>
              ))}
          </ol>
        </details>
      ))}
      <div ref={end} />
    </div>
  );
}

/** A line to send to the duel's chat, which both players read in the duel log. */
export function ChatInput({ send, sending }: { send: (text: string) => Promise<unknown>; sending: boolean }) {
  const [text, setText] = useState('');
  return (
    <form
      className="chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void send(text.trim()).then(() => setText(''), () => {});
      }}
    >
      <input aria-label="Chat message" placeholder="Say something…" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={sending || !text.trim()}>
        Send
      </button>
    </form>
  );
}
