import type { DuelUpdate, JudgingView, LogEntry, LogEvent, PlayerView, Seat, SeatStep } from '@yugioh/engine';
import { useEffect, useRef, useState } from 'react';

/** What the board shows right now: the view after the current step, the one before it, and the step being played. */
export interface Shown {
  view: PlayerView;
  /** The board before the current step, so animations can tell what changed. Null right after a sync. */
  prev: PlayerView | null;
  log: LogEntry[];
  /** The event being animated, or null when the board is at rest and the player may act. */
  cue: LogEntry | null;
}

/**
 * The seat's live duel, pushed by the server. Each change arrives as steps (one per event); they are shown one
 * at a time, each held for `pace(event, stepsStillWaiting)` milliseconds. A sync (on connect and after the
 * browser reconnects by itself) replaces everything and drops any steps not yet shown. `judging` is the judge's
 * work on an effect, shown as soon as it arrives. `duelId` null turns it off. A spectator's stream, with
 * `watchFrom` the seat at the bottom, shows only what both players can see.
 */
export function useDuel(duelId: string | null, pace: (event: LogEvent, waiting: number) => number, watchFrom: Seat | null = null) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [connected, setConnected] = useState(true);
  const [judging, setJudging] = useState<JudgingView | null>(null);
  const [online, setOnline] = useState<Seat[]>([]);
  const paceRef = useRef(pace);
  paceRef.current = pace;

  useEffect(() => {
    if (duelId === null) return;
    const queue: SeatStep[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let playing = false;

    const playNext = () => {
      const step = queue.shift();
      if (!step) {
        playing = false;
        setShown((s) => s && { ...s, cue: null });
        return;
      }
      const entry = step.entry;
      // A step with no log entry (a pass) only changes what the board offers; it takes no time.
      if (!entry) {
        setShown((s) => ({ view: step.view, prev: s?.view ?? null, log: s?.log ?? [], cue: null }));
        return playNext();
      }
      // Chat changes nothing on the board, so it only joins the log, without interrupting what the player is doing.
      if (entry.event.type === 'chatted') {
        setShown((s) => s && { ...s, log: [...s.log, entry] });
        return playNext();
      }
      setShown((s) => ({ view: step.view, prev: s?.view ?? null, log: [...(s?.log ?? []), entry], cue: entry }));
      timer = setTimeout(playNext, paceRef.current(entry.event, queue.length));
    };

    const source = new EventSource(`/api/duels/${duelId}/stream${watchFrom === null ? '' : `?from=${watchFrom}`}`);
    source.onmessage = (e: MessageEvent<string>) => {
      const update = JSON.parse(e.data) as DuelUpdate;
      setConnected(true);
      if (update.type === 'sync') {
        queue.length = 0;
        clearTimeout(timer);
        playing = false;
        setShown({ view: update.view, prev: null, log: update.log, cue: null });
        setJudging(update.judging);
        return;
      }
      if (update.type === 'judging') return setJudging(update.judging);
      if (update.type === 'presence') return setOnline(update.online);
      queue.push(...update.steps);
      if (!playing) {
        playing = true;
        playNext();
      }
    };
    source.onerror = () => setConnected(false);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [duelId, watchFrom]);

  return { shown, connected, judging, online };
}
