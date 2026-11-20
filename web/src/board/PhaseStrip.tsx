import type { Phase } from '@yugioh/engine';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

const phases: { phase: Phase; short: string; name: string }[] = [
  { phase: 'draw', short: 'DP', name: 'Draw Phase' },
  { phase: 'standby', short: 'SP', name: 'Standby Phase' },
  { phase: 'main1', short: 'M1', name: 'Main Phase 1' },
  { phase: 'battle', short: 'BP', name: 'Battle Phase' },
  { phase: 'main2', short: 'M2', name: 'Main Phase 2' },
  { phase: 'end', short: 'EP', name: 'End Phase' },
];

/** Whose turn it is. */
export function TurnLabel({ turn, label }: { turn: number; label: string }) {
  return (
    <span className="turn-label">
      {turn > 0 && `Turn ${turn} · `}
      <strong>{label}</strong>
    </span>
  );
}

/**
 * The phases as a dial: a strip that scrolls sideways to keep the current phase under the notch, its neighbours fading
 * out to either side. Phases you may move to now are buttons. Below it, Next moves on one phase, and End goes through
 * the rest of the turn's phases one at a time (`ending` while it does, when the button stops it instead).
 */
export function PhaseDial({
  phase,
  goTo,
  next,
  end,
  ending,
  readOnly = false,
}: {
  phase: Phase;
  /** Phases you may move to now, and what moving there does. */
  goTo: Partial<Record<Phase, () => void>>;
  next: (() => void) | null;
  end: (() => void) | null;
  ending: boolean;
  /** A replay: the phases only, without Next and End. */
  readOnly?: boolean;
}) {
  const strip = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = strip.current;
    const item = el?.querySelector<HTMLElement>('li.current');
    if (el && item) el.scrollTo({ left: item.offsetLeft - (el.clientWidth - item.offsetWidth) / 2, behavior: 'smooth' });
  }, [phase]);
  return (
    <div className="phase-dial">
      <div className="dial-frame">
        <ol className="dial" ref={strip} aria-label="Phases">
          {phases.map((p) => {
            const go = goTo[p.phase];
            const current = p.phase === phase;
            return (
              <li key={p.phase} className={current ? 'current' : undefined}>
                {go ? (
                  <button className="phase go" onClick={go} title={`Go to the ${p.name}`}>
                    {p.short}
                  </button>
                ) : (
                  <span className="phase" title={p.name} aria-current={current ? 'step' : undefined}>
                    {p.short}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {!readOnly && (
        <div className="dial-buttons">
          <button onClick={next ?? undefined} disabled={!next} title="Go to the next phase">
            Next
          </button>
          <button
            className={ending ? 'primary' : undefined}
            onClick={end ?? undefined}
            disabled={!end}
            title={ending ? 'Stop ending the turn' : 'Go through the rest of the phases, one at a time, and end the turn'}
          >
            {ending ? 'Stop' : 'End'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The row between the two fields: the two Extra Monster Zones with the phase dial between them, whose turn it is and
 * the chain on the left, and on the right what the duel is waiting for: a choice to make, a question, or whom it waits
 * on. A compact board shows the dial and the prompt in a bar beside it instead, where they have room, and the chain
 * takes the middle.
 */
export function PhaseStrip({
  yours,
  side,
  extraZones,
  middle,
  prompt,
}: {
  yours: boolean;
  side: ReactNode;
  /** The left and right Extra Monster Zones, as the viewer sees them. */
  extraZones: [ReactNode, ReactNode];
  middle: ReactNode;
  prompt: ReactNode;
}) {
  return (
    <div className={`phase-strip${yours ? ' yours' : ''}`}>
      <div className="strip-turn">{side}</div>
      {extraZones[0]}
      <div className="strip-middle">{middle}</div>
      {extraZones[1]}
      <div className="strip-prompt">{prompt}</div>
    </div>
  );
}
