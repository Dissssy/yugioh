import type { CardData, CardView, Seat } from '@yugioh/engine';
import { animate, motion, useMotionValue, useSpring, useTransform, useVelocity } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dropCentre } from './aim.tsx';
import { CardFace, dataOf, idOf } from './Card.tsx';
import { useCardHover } from './CardTooltip.tsx';
import { CARD_ASPECT, CARD_HEIGHT_IN_ZONE, useBoardLook, type CardMarks } from './look.ts';

const spring = { type: 'spring', stiffness: 420, damping: 32 } as const;

/** Where card `i` of `n` sits in a fanned hand: its overlap with the card before, tilt and drop. */
function fan(i: number, n: number, zone: number, hovered: number | null) {
  const cardWidth = zone * CARD_HEIGHT_IN_ZONE * CARD_ASPECT;
  const room = zone * 5;
  const step = n > 1 ? Math.min(cardWidth * 0.94, (room - cardWidth) / (n - 1)) : cardWidth;
  const fromCentre = i - (n - 1) / 2;
  // Cards beside the hovered one part to show it whole.
  const part = hovered !== null && (i === hovered || i === hovered + 1) && i > 0 ? cardWidth * 0.3 : 0;
  return {
    marginLeft: i === 0 ? 0 : step - cardWidth + part,
    rotate: Math.max(-12, Math.min(12, fromCentre * 3)),
    y: fromCentre * fromCentre * zone * 0.012,
  };
}

/** A drag of a hand card, reported to the board so it can light up and resolve drop targets. */
export interface HandDrag {
  start(id: string): void;
  move(id: string, point: { x: number; y: number }): void;
  /** The card was released at `point`. True when the board took it, so it stays where it was dropped. */
  end(id: string, point: { x: number; y: number }): boolean;
}

/**
 * Your hand: a fan of cards, each dragged with one gesture. Along the hand the drag reorders it; lifted above the
 * hand it becomes a drop onto the field. Arrow keys move the focused card. Hovering a card lifts it and parts its neighbours. The order is yours
 * alone, kept in this browser for the duel and never sent to the server.
 */
export function OwnHand({
  duelId,
  seat,
  cards,
  marks,
  onCard,
  drag,
  held,
}: {
  duelId: string;
  seat: Seat;
  cards: CardView[];
  marks: CardMarks;
  onCard: (id: string, el: HTMLElement) => void;
  drag: HandDrag;
  /** A card waiting over a zone (`id`, held over the drop target `key`) while you choose how to play it. */
  held: { id: string; key: string } | null;
}) {
  const { zone } = useBoardLook();
  const [saved, setSaved] = useState(() => loadOrder(duelId));
  const [hovered, setHovered] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const byId = new Map(cards.map((c) => [idOf(c)!, c]));
  const ids = cards.map((c) => idOf(c)!);
  // Cards you've arranged keep their place; new ones join on the right.
  const order = useMemo(
    () => [...saved.filter((id) => ids.includes(id)), ...ids.filter((id) => !saved.includes(id))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, ids.join()],
  );
  const hoveredIndex = hovered === null ? null : order.indexOf(hovered);

  /** While the pointer is along the hand, move the dragged card to the slot nearest it. */
  function reorder(id: string, point: { x: number; y: number }) {
    const el = group.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    // A hovered card rises above the hand, so the hand reaches up by that much plus a little.
    if (point.y < box.top - zone * 0.45) return;
    // Slots by layout position, which ignores the drag and fan transforms, so they stay put as cards move.
    const slots = [...el.children].map((c) => {
      const card = c as HTMLElement;
      return box.left + card.offsetLeft + card.offsetWidth / 2;
    });
    const to = slots.reduce((best, x, i) => (Math.abs(x - point.x) < Math.abs(slots[best]! - point.x) ? i : best), 0);
    move(id, to);
  }

  function move(id: string, to: number) {
    if (to === order.indexOf(id) || to < 0 || to >= order.length) return;
    const next = order.filter((o) => o !== id);
    next.splice(to, 0, id);
    setSaved(next);
    saveOrder(duelId, next);
  }

  const cardDrag: HandDrag = {
    start: drag.start,
    move: (id, point) => {
      reorder(id, point);
      drag.move(id, point);
    },
    end: drag.end,
  };

  return (
    <div ref={group} className="hand own" data-hand={seat}>
      {order.map((id, i) => (
        <HandCard
          key={id}
          id={id}
          data={dataOf(byId.get(id)!)!}
          place={fan(i, order.length, zone, hoveredIndex)}
          lifted={hovered === id && held?.id !== id}
          marks={marks}
          onHover={(on) => setHovered((h) => (on ? id : h === id ? null : h))}
          onCard={onCard}
          onStep={(by) => move(id, i + by)}
          drag={cardDrag}
          heldAt={held?.id === id ? held.key : null}
        />
      ))}
    </div>
  );
}

function HandCard({
  id,
  data,
  place,
  lifted,
  marks,
  onHover,
  onCard,
  onStep,
  drag,
  heldAt,
}: {
  id: string;
  data: CardData;
  place: ReturnType<typeof fan>;
  lifted: boolean;
  marks: CardMarks;
  onHover: (on: boolean) => void;
  onCard: (id: string, el: HTMLElement) => void;
  /** Move this card along the hand by one place, from the keyboard. */
  onStep: (by: -1 | 1) => void;
  drag: HandDrag;
  heldAt: string | null;
}) {
  const { zone, imageSize } = useBoardLook();
  const hover = useCardHover();
  const tip = hover(data);
  // The card leans into the direction it's dragged, and settles when it slows down.
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const lean = useSpring(useTransform(useVelocity(x), [-2000, 2000], [-18, 18], { clamp: true }), { stiffness: 300, damping: 25 });
  // A drag ends with a click on the card; that click isn't a request for its menu.
  const dragged = useRef(false);
  const at = (point: { x: number; y: number }) => ({ x: point.x - window.scrollX, y: point.y - window.scrollY });
  const el = useRef<HTMLDivElement>(null);
  /** Glides the card by (dx, dy) from its place in the hand: home is (0, 0). */
  const glide = (dx: number, dy: number) => {
    const a = animate(x, dx, spring);
    const b = animate(y, dy, spring);
    return () => (a.stop(), b.stop());
  };
  // Held over a zone, the card centres on it; let go of, it returns to the hand.
  useEffect(() => {
    const centre = heldAt ? dropCentre(heldAt) : null;
    const r = el.current?.getBoundingClientRect();
    if (!centre || !r) return glide(0, 0);
    return glide(centre.x - (r.left + r.width / 2 - x.get()), centre.y - (r.top + r.height / 2 - y.get()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldAt]);
  return (
    <motion.div
      ref={el}
      layout
      layoutId={id}
      drag
      dragMomentum={false}
      tabIndex={0}
      className={`hand-card slot ${marks.classes(id)}${heldAt ? ' held' : ''}`}
      style={{ marginLeft: place.marginLeft, x, y }}
      animate={{ scale: heldAt ? 1.08 : 1 }}
      transition={spring}
      whileDrag={{ scale: 1.08, zIndex: 10 }}
      onPointerEnter={(e) => {
        onHover(true);
        tip.onPointerEnter?.(e);
      }}
      onPointerLeave={() => {
        onHover(false);
        tip.onPointerLeave?.();
      }}
      onContextMenu={tip.onContextMenu}
      onDragStart={() => {
        dragged.current = true;
        drag.start(id);
      }}
      onDrag={(_, info) => drag.move(id, at(info.point))}
      onDragEnd={(_, info) => {
        setTimeout(() => (dragged.current = false), 0);
        if (!drag.end(id, at(info.point))) glide(0, 0);
      }}
      onClick={(e) => !dragged.current && onCard(id, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCard(id, e.currentTarget);
        if (e.key === 'ArrowLeft') onStep(-1);
        if (e.key === 'ArrowRight') onStep(1);
      }}
      aria-label={`${data.name}, in your hand`}
    >
      <motion.div style={{ rotate: lean }}>
        <motion.div
          animate={lifted ? { rotate: 0, y: -zone * 0.3, scale: 1.15 } : heldAt ? { rotate: 0, y: 0, scale: 1 } : { rotate: place.rotate, y: place.y, scale: 1 }}
          transition={spring}
        >
          <div className="fx" data-card-id={id}>
            <CardFace card={data} size={imageSize} />
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/** The opponent's hand: card backs in a fan that only moves when a public event happens. */
export function FoeHand({ seat, count }: { seat: Seat; count: number }) {
  const { zone } = useBoardLook();
  return (
    <div className="hand foe" data-hand={seat} aria-label={`Opponent's hand, ${count} cards`}>
      {Array.from({ length: count }, (_, i) => {
        const place = fan(i, count, zone, null);
        return (
          <motion.div key={i} layout className="hand-card" style={{ marginLeft: place.marginLeft }} transition={spring}>
            <motion.div animate={{ rotate: -place.rotate, y: -place.y }} transition={spring}>
              <div className="fx" data-hand-index={`${seat}:${i}`}>
                <CardFace card={null} />
              </div>
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}

const orderKey = (duelId: string) => `hand-order:${duelId}`;

function loadOrder(duelId: string): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(orderKey(duelId)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveOrder(duelId: string, order: string[]) {
  try {
    sessionStorage.setItem(orderKey(duelId), JSON.stringify(order));
  } catch {
    // Without storage the order lasts until the page reloads.
  }
}
