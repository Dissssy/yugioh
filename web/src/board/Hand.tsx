import type { CardView, Seat } from '@yugioh/engine';
import { motion, Reorder } from 'motion/react';
import { useMemo, useState } from 'react';
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

/**
 * Your hand: a fan you can reorder by dragging. Hovering a card lifts it and parts its neighbours. The order is
 * yours alone, kept in this browser for the duel and never sent to the server.
 */
export function OwnHand({
  duelId,
  seat,
  cards,
  marks,
  onCard,
  onDragging,
}: {
  duelId: string;
  seat: Seat;
  cards: CardView[];
  marks: CardMarks;
  onCard: (id: string, el: HTMLElement) => void;
  onDragging: (dragging: boolean) => void;
}) {
  const { zone, imageSize } = useBoardLook();
  const hover = useCardHover();
  const [saved, setSaved] = useState(() => loadOrder(duelId));
  const [hovered, setHovered] = useState<string | null>(null);
  const byId = new Map(cards.map((c) => [idOf(c)!, c]));
  const ids = cards.map((c) => idOf(c)!);
  // Cards you've arranged keep their place; new ones join on the right.
  const order = useMemo(
    () => [...saved.filter((id) => ids.includes(id)), ...ids.filter((id) => !saved.includes(id))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, ids.join()],
  );
  const reorder = (next: string[]) => {
    setSaved(next);
    saveOrder(duelId, next);
  };
  const hoveredIndex = hovered === null ? null : order.indexOf(hovered);

  return (
    <Reorder.Group as="div" axis="x" values={order} onReorder={reorder} className="hand own" data-hand={seat}>
      {order.map((id, i) => {
        const data = dataOf(byId.get(id)!)!;
        const place = fan(i, order.length, zone, hoveredIndex);
        const lifted = hovered === id;
        const tip = hover(data);
        return (
          <Reorder.Item
            key={id}
            value={id}
            as="div"
            layoutId={id}
            className={`hand-card slot ${marks.classes(id)}`}
            style={{ marginLeft: place.marginLeft, zIndex: lifted ? 10 : undefined }}
            transition={spring}
            onPointerEnter={(e) => {
              setHovered(id);
              tip.onPointerEnter?.(e);
            }}
            onPointerLeave={() => {
              setHovered((h) => (h === id ? null : h));
              tip.onPointerLeave?.();
            }}
            onContextMenu={tip.onContextMenu}
            onDragStart={() => onDragging(true)}
            onDragEnd={() => onDragging(false)}
            onClick={(e) => onCard(id, e.currentTarget)}
            onKeyDown={(e) => e.key === 'Enter' && onCard(id, e.currentTarget)}
            aria-label={`${data.name}, in your hand`}
          >
            <motion.div
              animate={lifted ? { rotate: 0, y: -zone * 0.3, scale: 1.15 } : { rotate: place.rotate, y: place.y, scale: 1 }}
              transition={spring}
            >
              <div className="fx" data-card-id={id}>
                <CardFace card={data} size={imageSize} />
              </div>
            </motion.div>
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
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
