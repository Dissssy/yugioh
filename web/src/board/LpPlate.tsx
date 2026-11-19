import type { LogEntry, Seat } from '@yugioh/engine';
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect } from 'react';

/** A player's name and Life Points. LP counts to its new value, and each change floats up as a number. */
export function LpPlate({ seat, name, lp, cue, active }: { seat: Seat; name: string; lp: number; cue: LogEntry | null; active: boolean }) {
  const value = useMotionValue(lp);
  const shown = useTransform(value, (v) => Math.round(v));
  useEffect(() => {
    const controls = animate(value, lp, { duration: 0.5, ease: 'easeOut' });
    return () => controls.stop();
  }, [lp, value]);
  const damage = cue?.event.type === 'battleDamage' && cue.event.player === seat ? cue.event.amount : null;

  return (
    <div className={`lp-plate${active ? ' active' : ''}${damage ? ' hit' : ''}`} data-lp={seat}>
      <span className="lp-name">{name}</span>
      <span className="lp">
        LP <motion.span>{shown}</motion.span>
      </span>
      <AnimatePresence>
        {damage !== null && (
          <motion.span
            key={cue!.seq}
            className="lp-delta"
            initial={{ opacity: 0, y: 0, scale: 0.8 }}
            animate={{ opacity: 1, y: -28, scale: 1.1 }}
            exit={{ opacity: 0, y: -44 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          >
            −{damage}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
