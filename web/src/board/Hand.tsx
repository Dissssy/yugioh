import type { CardData, CardView, Seat } from '@yugioh/engine';
import { motion, Reorder, useMotionValue, useSpring, useTransform, useVelocity } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
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
  /** The card was released at `point`. */
  end(id: string, point: { x: number; y: number }): void;
}

/**
 * Your hand: a fan you can reorder by dragging along it, or drag a card out onto the field. Hovering a card
 * lifts it and parts its neighbours. The order is yours alone, kept in this browser for the duel and never sent
 * to the server.
 */
export function OwnHand({
  duelId,
  seat,
  cards,
  marks,
  onCard,
  drag,
}: {
  duelId: string;
  seat: Seat;
  cards: CardView[];
  marks: CardMarks;
  onCard: (id: string, el: HTMLElement) => void;
  drag: HandDrag;
}) {
  const { zone } = useBoardLook();
  const [saved, setSaved] = useState(() => loadOrder(duelId));
  const [hovered, setHovered] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  /** True while the dragged card is above the hand, where it no longer reorders it. */
  const out = useRef(false);
  const byId = new Map(cards.map((c) => [idOf(c)!, c]));
  const ids = cards.map((c) => idOf(c)!);
  // Cards you've arranged keep their place; new ones join on the right.
  const order = useMemo(
    () => [...saved.filter((id) => ids.includes(id)), ...ids.filter((id) => !saved.includes(id))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, ids.join()],
  );
  const reorder = (next: string[]) => {
    if (out.current) return;
    setSaved(next);
    saveOrder(duelId, next);
  };
  const hoveredIndex = hovered === null ? null : order.indexOf(hovered);
  const handDrag: HandDrag = {
    start: drag.start,
    move: (id, point) => {
      const top = group.current?.getBoundingClientRect().top ?? Infinity;
      out.current = point.y < top - zone * 0.15;
      drag.move(id, point);
    },
    end: (id, point) => {
      out.current = false;
      drag.end(id, point);
    },
  };

  return (
    <Reorder.Group ref={group} as="div" axis="x" values={order} onReorder={reorder} className="hand own" data-hand={seat}>
      {order.map((id, i) => (
        <HandCard
          key={id}
          id={id}
          data={dataOf(byId.get(id)!)!}
          place={fan(i, order.length, zone, hoveredIndex)}
          lifted={hovered === id}
          marks={marks}
          onHover={(on) => setHovered((h) => (on ? id : h === id ? null : h))}
          onCard={onCard}
          drag={handDrag}
        />
      ))}
    </Reorder.Group>
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
  drag,
}: {
  id: string;
  data: CardData;
  place: ReturnType<typeof fan>;
  lifted: boolean;
  marks: CardMarks;
  onHover: (on: boolean) => void;
  onCard: (id: string, el: HTMLElement) => void;
  drag: HandDrag;
}) {
  const { zone, imageSize } = useBoardLook();
  const hover = useCardHover();
  const tip = hover(data);
  // The card leans into the direction it's dragged, and settles when it slows down.
  const x = useMotionValue(0);
  const lean = useSpring(useTransform(useVelocity(x), [-2000, 2000], [-18, 18], { clamp: true }), { stiffness: 300, damping: 25 });
  return (
    <Reorder.Item
      value={id}
      as="div"
      layoutId={id}
      drag
      className={`hand-card slot ${marks.classes(id)}`}
      style={{ marginLeft: place.marginLeft, x }}
      transition={spring}
      whileDrag={{ scale: 1.08 }}
      onPointerEnter={(e) => {
        onHover(true);
        tip.onPointerEnter?.(e);
      }}
      onPointerLeave={() => {
        onHover(false);
        tip.onPointerLeave?.();
      }}
      onContextMenu={tip.onContextMenu}
      onDragStart={() => drag.start(id)}
      onDrag={(_, info) => drag.move(id, { x: info.point.x - window.scrollX, y: info.point.y - window.scrollY })}
      onDragEnd={(_, info) => drag.end(id, { x: info.point.x - window.scrollX, y: info.point.y - window.scrollY })}
      onClick={(e) => onCard(id, e.currentTarget)}
      onKeyDown={(e) => e.key === 'Enter' && onCard(id, e.currentTarget)}
      aria-label={`${data.name}, in your hand`}
    >
      <motion.div style={{ rotate: lean }}>
        <motion.div
          animate={lifted ? { rotate: 0, y: -zone * 0.3, scale: 1.15 } : { rotate: place.rotate, y: place.y, scale: 1 }}
          transition={spring}
        >
          <div className="fx" data-card-id={id}>
            <CardFace card={data} size={imageSize} />
          </div>
        </motion.div>
      </motion.div>
    </Reorder.Item>
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
