import type { LogEntry, LogEvent } from '@yugioh/engine';
import { useEffect, useRef } from 'react';

/** Card IDs an event names, for highlighting them on the board. */
export function cardsOf(event: LogEvent): string[] {
  const ids: (string | null)[] = [];
  if ('card' in event) ids.push(event.card);
  if ('cards' in event) ids.push(...event.cards);
  if (event.type === 'attackDeclared') ids.push(event.attacker, event.target);
  return ids.filter((id): id is string => id !== null);
}

/**
 * The duel log, grouped by turn. The current turn is open; earlier turns fold away. Hovering an entry highlights
 * the cards it names.
 */
export function DuelLog({ log, onHighlight }: { log: LogEntry[]; onHighlight: (ids: string[]) => void }) {
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
                <li key={e.seq} onPointerEnter={() => onHighlight(cardsOf(e.event))} onPointerLeave={() => onHighlight([])}>
                  {e.text}
                </li>
              ))}
          </ol>
        </details>
      ))}
      <div ref={end} />
    </div>
  );
}
