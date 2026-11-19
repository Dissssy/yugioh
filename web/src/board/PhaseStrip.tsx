import type { Phase } from '@yugioh/engine';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

const phases: { phase: Phase; short: string; name: string }[] = [
  { phase: 'draw', short: 'DP', name: 'Draw Phase' },
  { phase: 'standby', short: 'SP', name: 'Standby Phase' },
  { phase: 'main1', short: 'M1', name: 'Main Phase 1' },
  { phase: 'battle', short: 'BP', name: 'Battle Phase' },
  { phase: 'main2', short: 'M2', name: 'Main Phase 2' },
  { phase: 'end', short: 'EP', name: 'End Phase' },
];

/**
 * The strip between the two fields: whose turn it is, the phases with the current one lit, and the turn's
 * buttons. Phases you can move to now are buttons. While a choice is being made, its instruction takes the
 * phases' place.
 */
export function PhaseStrip({
  turn,
  turnLabel,
  yours,
  phase,
  goTo,
  prompt,
  endTurn,
}: {
  turn: number;
  turnLabel: string;
  yours: boolean;
  phase: Phase;
  /** Phases you may move to now, and what moving there does. */
  goTo: Partial<Record<Phase, () => void>>;
  prompt: ReactNode;
  endTurn: (() => void) | null;
}) {
  return (
    <div className={`phase-strip${yours ? ' yours' : ''}`}>
      <span className="turn-label">
        {turn > 0 && `Turn ${turn} · `}<strong>{turnLabel}</strong>
      </span>
      {prompt ?? (
        <ol className="phases" aria-label="Phases">
          {phases.map((p) => {
            const go = goTo[p.phase];
            const current = p.phase === phase;
            return (
              <li key={p.phase} className={current ? 'current' : undefined}>
                {current && <motion.span layoutId="phase-pill" className="phase-pill" />}
                {go ? (
                  <button className="phase go" onClick={go} title={p.name}>
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
      )}
      <span className="strip-actions">{endTurn && <button onClick={endTurn}>End turn</button>}</span>
    </div>
  );
}
