import type { LogEntry, Seat } from '@yugioh/engine';
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect } from 'react';

/** A player's name and Life Points. LP counts to its new value, and each change floats up as a number: red for a loss, green for a gain. */
export function LpPlate({
  seat,
  name,
  lp,
  cue,
  active,
  target = null,
}: {
  seat: Seat;
  name: string;
  lp: number;
  cue: LogEntry | null;
  active: boolean;
  /** Whether an aimed direct attack may land here ('open') or is over it now ('over'). */
  target?: 'open' | 'over' | null;
}) {
  const value = useMotionValue(lp);
  const shown = useTransform(value, (v) => Math.round(v));
  useEffect(() => {
    const controls = animate(value, lp, { duration: 0.5, ease: 'easeOut' });
    return () => controls.stop();
  }, [lp, value]);
  const e = cue?.event;
  const change = e?.type === 'battleDamage' && e.player === seat ? -e.amount : e?.type === 'lpChanged' && e.player === seat ? e.amount : null;

  return (
    <div
      className={`lp-plate${active ? ' active' : ''}${change !== null && change < 0 ? ' hit' : ''}${target ? ' open' : ''}${target === 'over' ? ' over' : ''}`}
      data-lp={seat}
      data-drop={`lp:${seat}`}
      title={name}
    >
      <span className="lp-name">{name}</span>
      <span className="lp">
        <span className="lp-label">LP </span>
        <motion.span>{shown}</motion.span>
      </span>
      <AnimatePresence>
        {change !== null && (
          <motion.span
            key={cue!.seq}
            className={`lp-delta${change > 0 ? ' gain' : ''}`}
            initial={{ opacity: 0, y: 0, scale: 0.8 }}
            animate={{ opacity: 1, y: -28, scale: 1.1 }}
            exit={{ opacity: 0, y: -44 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          >
            {change > 0 ? `+${change}` : `−${-change}`}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
