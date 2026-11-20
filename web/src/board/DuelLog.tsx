import type { CardData, LogEntry, LogEvent } from '@yugioh/engine';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How close to its end the log counts as following along. */
const END_SLOP_PX = 24;

/** Card IDs an event names, for highlighting them on the board. */
export function cardsOf(event: LogEvent): string[] {
  const ids: (string | null)[] = [];
  if ('card' in event && event.type !== 'asked') ids.push(event.card);
  if ('cards' in event) ids.push(...event.cards);
  if (event.type === 'attackDeclared') ids.push(event.attacker, event.target);
  return ids.filter((id): id is string => id !== null);
}

/** Contesting a judge's ruling: whether this player still may, and sending it with an optional note. */
export interface Contest {
  can(seq: number): boolean;
  send(seq: number, note: string): void;
}

/** Escalating a question to the judge to the appeal: whether this player still may, and sending it. */
export interface Escalate {
  can(seq: number): boolean;
  send(seq: number, note: string): void;
}

const OUTCOMES = {
  game_right: 'The game is right',
  ruling_wrong: 'The ruling was wrong, so it is being contested for you',
  card_wrong: "The card's script was wrong: the judge rules on it from now on",
  engine_wrong: "A rule in the game's code is wrong; it's been reported",
} as const;

/**
 * The duel log, grouped by turn. The current turn is open; earlier turns fold away. Hovering an entry highlights
 * the cards it names. The judge's rulings stand out and can be contested; an appeal's verdict follows them.
 */
export function DuelLog({ log, onHighlight, contest, escalate }: { log: LogEntry[]; onHighlight: (ids: string[]) => void; contest: Contest; escalate: Escalate }) {
  const [contesting, setContesting] = useState<number | null>(null);
  const [escalating, setEscalating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const turns = new Map<number, LogEntry[]>();
  for (const entry of log) {
    if (entry.text === null) continue;
    turns.set(entry.turn, [...(turns.get(entry.turn) ?? []), entry]);
  }
  const current = log.at(-1)?.turn ?? 0;
  // New entries keep the log at its end, unless the player scrolled up to read. Only the log scrolls, never the page.
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log.length]);
  // So does the log changing size, as when the board makes way for the keyboard.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={box}
      className="duel-log"
      aria-label="Duel log"
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < END_SLOP_PX;
      }}
    >
      {[...turns].map(([turn, entries]) => (
        <details key={turn} open={turn >= current - 1 || undefined}>
          <summary>{turn === 0 ? 'Before the duel' : entries[0]?.event.type === 'turnStarted' ? entries[0].text : `Turn ${turn}`}</summary>
          <ol>
            {entries
              .filter((e) => e.event.type !== 'turnStarted')
              .map((e) => (
                <li
                  key={e.seq}
                  className={
                    e.event.type === 'judged'
                      ? `ruling${e.event.legal ? '' : ' refused'}`
                      : e.event.type === 'appealed' || e.event.type === 'escalated'
                        ? 'appeal'
                        : e.event.type === 'chatted'
                          ? 'chat'
                          : e.event.type === 'asked'
                            ? 'question'
                            : undefined
                  }
                  onPointerEnter={() => onHighlight(cardsOf(e.event))}
                  onPointerLeave={() => onHighlight([])}
                >
                  {e.event.type === 'judged' && 'Judge: '}
                  {e.event.type === 'asked' ? (
                    <>
                      <span className="muted small">Your question (only you see this)</span>
                      <q>{e.event.question}</q>
                      <span>Judge: {e.event.answer}</span>
                    </>
                  ) : e.event.type === 'escalated' ? (
                    <>
                      <strong>{OUTCOMES[e.event.outcome]}.</strong> {e.event.explanation}
                    </>
                  ) : (
                    e.text
                  )}
                  {e.event.type === 'asked' && !e.event.failed && escalate.can(e.seq) && escalating !== e.seq && (
                    <button className={e.event.verdict === 'explained' ? 'quiet' : undefined} onClick={() => (setEscalating(e.seq), setNote(''))}>
                      Escalate
                    </button>
                  )}
                  {escalating === e.seq && (
                    <form
                      className="contest"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        escalate.send(e.seq, note.trim());
                        setEscalating(null);
                      }}
                    >
                      <textarea rows={2} maxLength={500} placeholder="Why do you think the game is wrong? (optional)" value={note} onChange={(ev) => setNote(ev.target.value)} autoFocus />
                      <span className="muted small">The appeal sees the whole board and uses one of the duel's appeals.</span>
                      <span className="row">
                        <button type="submit">Send to appeal</button>
                        <button type="button" className="quiet" onClick={() => setEscalating(null)}>
                          Cancel
                        </button>
                      </span>
                    </form>
                  )}
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
    </div>
  );
}

/** A question to the judge in the making: what it's about, if a card was picked from its details. */
export interface Asking {
  about: CardData | null;
  /** Changes when the box should take focus (a card's "Ask the judge" was pressed). */
  focus: number;
}

/**
 * A line for the duel's chat, which both players read in the duel log, or a question to the judge, which only this
 * player sees (docs/ask-the-judge.md).
 */
export function ChatInput({
  send,
  ask,
  sending,
  answering,
  asking,
  onAsking,
}: {
  send: (text: string) => Promise<unknown>;
  ask: (text: string, card: number | null) => Promise<unknown>;
  sending: boolean;
  /** A question was sent and its answer hasn't arrived yet. */
  answering: boolean;
  /** Null in chat mode. */
  asking: Asking | null;
  onAsking: (asking: Asking | null) => void;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (asking?.focus) input.current?.focus();
  }, [asking?.focus]);
  return (
    <form
      className="chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const sent = asking ? ask(text.trim(), asking.about?.code ?? null) : send(text.trim());
        void sent.then(() => setText(''), () => {});
      }}
    >
      <span className="chat-mode" role="group" aria-label="Send to">
        <button type="button" className={asking ? 'quiet' : 'on'} aria-pressed={!asking} onClick={() => onAsking(null)}>
          Chat
        </button>
        <button type="button" className={asking ? 'on' : 'quiet'} aria-pressed={!!asking} onClick={() => asking || onAsking({ about: null, focus: 0 })}>
          Ask the judge
        </button>
        {asking?.about && (
          <button type="button" className="quiet about" title="Not about this card" onClick={() => onAsking({ about: null, focus: asking.focus })}>
            About {asking.about.name} ×
          </button>
        )}
        {answering && <span className="muted small">The judge is answering…</span>}
      </span>
      <input
        ref={input}
        aria-label={asking ? 'Question for the judge' : 'Chat message'}
        placeholder={asking ? 'Ask a rules question…' : 'Say something…'}
        maxLength={asking ? 500 : 300}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" disabled={sending || answering || !text.trim()}>
        {asking ? 'Ask' : 'Send'}
      </button>
    </form>
  );
}
