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
 * The row between the two fields. On the left, whose turn it is, the phases with the current one lit, and the turn's
 * buttons; phases you can move to now are buttons. In the middle the two Extra Monster Zones, with the chain between
 * them. On the right, what the duel is waiting for: a choice to make, a question, or whom it waits on.
 */
export function PhaseStrip({
  turn,
  turnLabel,
  yours,
  phase,
  goTo,
  extraZones,
  chain,
  prompt,
  endTurn,
}: {
  turn: number;
  turnLabel: string;
  yours: boolean;
  phase: Phase;
  /** Phases you may move to now, and what moving there does. */
  goTo: Partial<Record<Phase, () => void>>;
  /** The left and right Extra Monster Zones, as the viewer sees them. */
  extraZones: [ReactNode, ReactNode];
  chain: ReactNode;
  prompt: ReactNode;
  endTurn: (() => void) | null;
}) {
  return (
    <div className={`phase-strip${yours ? ' yours' : ''}`}>
      <div className="strip-turn">
        <span className="turn-label">
          {turn > 0 && `Turn ${turn} · `}
          <strong>{turnLabel}</strong>
        </span>
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
        {endTurn && <button onClick={endTurn}>End turn</button>}
      </div>
      {extraZones[0]}
      <div className="strip-chain">{chain}</div>
      {extraZones[1]}
      <div className="strip-prompt">{prompt}</div>
    </div>
  );
}
