import type { DuelUpdate, JudgingView, LogEntry, LogEvent, PlayerView } from '@yugioh/engine';
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

type Step = Extract<DuelUpdate, { type: 'steps' }>['steps'][number];

/**
 * The seat's live duel, pushed by the server. Each change arrives as steps (one per event); they are shown one
 * at a time, each held for `pace(event, stepsStillWaiting)` milliseconds. A sync (on connect and after the
 * browser reconnects by itself) replaces everything and drops any steps not yet shown. `judging` is the judge's
 * work on an effect, shown as soon as it arrives.
 */
export function useDuel(duelId: string, pace: (event: LogEvent, waiting: number) => number) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [connected, setConnected] = useState(true);
  const [judging, setJudging] = useState<JudgingView | null>(null);
  const paceRef = useRef(pace);
  paceRef.current = pace;

  useEffect(() => {
    const queue: Step[] = [];
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

    const source = new EventSource(`/api/duels/${duelId}/stream`);
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
  }, [duelId]);

  return { shown, connected, judging };
}
