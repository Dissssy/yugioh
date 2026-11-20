import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { LogEvent, SeatStep } from '@yugioh/engine';
import type { Replay } from '@yugioh/shared';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { Shown } from './useDuel.ts';

export type ReplayFrom = Replay['from'];

/** Where a replay is: the step shown, and whether it is being animated (played into) or at rest (jumped to). */
interface Position {
  at: number;
  animating: boolean;
}

export interface ReplayControls {
  from: ReplayFrom;
  setFrom: (from: ReplayFrom) => void;
  at: number;
  count: number;
  /** Indices of the steps that start a turn, for the seek bar's marks and jumping by turn. */
  turnStarts: number[];
  playing: boolean;
  speed: number;
  setSpeed: (speed: number) => void;
  /** Shows step `i` at rest. */
  seek: (i: number) => void;
  /** One step on (animated) or back (at rest). */
  step: (by: 1 | -1) => void;
  /** To the start of the next turn, or of this one (or the one before, when already at its start). */
  turn: (by: 1 | -1) => void;
  toggle: () => void;
}

/**
 * A finished duel played back from its steps (docs/next-steps.md, Replays). Moving forward one step animates it
 * like the live board, held for `pace(event)` divided by the speed; seeking shows a step at rest. Switching the
 * viewpoint keeps the place in the duel. `duelId` null turns it off.
 */
export function useReplay(duelId: string | null, pace: (event: LogEvent, waiting: number) => number) {
  const [from, setFromState] = useState<ReplayFrom>(0);
  const query = useQuery({
    queryKey: ['replay', duelId, from],
    queryFn: () => api<Replay>(`/duels/${duelId}/replay?from=${from}`),
    enabled: duelId !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const steps = query.data?.from === from ? query.data.steps : null;
  const [pos, setPos] = useReducer((_: Position, next: Position) => next, { at: 0, animating: false });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const paceRef = useRef(pace);
  paceRef.current = pace;
  /** The event shown when the viewpoint changed, so the new steps open at the same place. */
  const keepSeq = useRef<number | null>(null);

  // A new viewpoint's steps open at the last step at or before the event that was shown.
  useEffect(() => {
    if (!steps || keepSeq.current === null) return;
    const seq = keepSeq.current;
    keepSeq.current = null;
    setPos({ at: Math.max(0, steps.findLastIndex((s) => (s.entry?.seq ?? 0) <= seq)), animating: false });
  }, [steps]);

  const last = (steps?.length ?? 1) - 1;
  const { at, animating } = pos;

  // Hold an animated step for its time, then play on or come to rest; playing from rest moves on at once.
  useEffect(() => {
    if (!steps) return;
    if (!animating) {
      if (!playing) return;
      if (at < last) setPos({ at: at + 1, animating: true });
      else setPlaying(false);
      return;
    }
    const entry = steps[at]?.entry;
    const ms = entry ? paceRef.current(entry.event, 0) / speed : 0;
    const timer = setTimeout(() => setPos(playing && at < last ? { at: at + 1, animating: true } : { at, animating: false }), ms);
    return () => clearTimeout(timer);
  }, [steps, at, animating, playing, speed, last]);

  const turnStarts = useMemo(() => (steps ?? []).flatMap((s, i) => (s.entry?.event.type === 'turnStarted' ? [i] : [])), [steps]);

  const shown = useMemo((): Shown | null => {
    const step = steps?.[Math.min(at, last)];
    if (!steps || !step) return null;
    return {
      view: step.view,
      prev: animating ? (steps[at - 1]?.view ?? null) : null,
      log: steps.slice(1, at + 1).map((s) => s.entry!),
      cue: animating ? step.entry : null,
    };
  }, [steps, at, last, animating]);

  const seek = (i: number) => {
    setPlaying(false);
    setPos({ at: Math.max(0, Math.min(last, i)), animating: false });
  };
  const controls: ReplayControls | null = steps && {
    from,
    setFrom: (next) => {
      if (next === from) return;
      keepSeq.current = shownSeq(steps, at);
      setPlaying(false);
      setFromState(next);
    },
    at,
    count: steps.length,
    turnStarts,
    playing,
    speed,
    setSpeed,
    seek,
    step: (by) => {
      setPlaying(false);
      if (by === 1 && at < last) setPos({ at: at + 1, animating: true });
      if (by === -1) seek(at - 1);
    },
    turn: (by) => seek(by === 1 ? (turnStarts.find((i) => i > at) ?? last) : (turnStarts.findLast((i) => i < at) ?? 0)),
    toggle: () => {
      // Playing from the end starts over.
      if (!playing && at === last) setPos({ at: 0, animating: false });
      setPlaying(!playing);
    },
  };

  return { shown, controls, error: query.error };
}

const shownSeq = (steps: SeatStep[], at: number) => steps[at]?.entry?.seq ?? 0;
