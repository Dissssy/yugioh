import type { Section } from '@yugioh/shared';
import { useMemo, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react';

/** What a drag carries: a card, and the section it came from when it was in the deck. */
export interface Dragged {
  code: number;
  from: Section | null;
}
const DRAG_TYPE = 'application/x-deck-card';

/**
 * A card's clicks: right-click acts on it (adds or removes it), a left click shows it. A touch has no right-click, so a
 * tap acts instead.
 */
export function clicks(show: () => void, act: () => void) {
  return {
    onPointerDown: (e: PointerEvent) => void (lastPointer = e.pointerType),
    onClick: () => (lastPointer === 'touch' ? act() : show()),
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      if (lastPointer !== 'touch') act();
    },
  };
}
/** The kind of pointer that last pressed a card. Kept outside React: showing the card re-renders between press and click. */
let lastPointer = 'mouse';

export function startDrag(e: DragEvent, d: Dragged) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d));
  e.dataTransfer.effectAllowed = 'move';
}

/** A place a dragged card can be dropped, lit while one is over it. */
export function useDropTarget(onDrop: (d: Dragged) => void) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        onDrop(JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Dragged);
      },
    },
  };
}

/** Showing cards beside the list: pointing at one shows it, clicking pins it, and the pinned card returns when the pointer leaves. */
export interface Peek<T> {
  hover: (card: T) => void;
  leave: () => void;
  pin: (card: T) => void;
}

/** The card shown, whether it is the pinned one, and the handlers that change it. */
export function usePeek<T>(initial: T | null) {
  const [pinned, setPinned] = useState(initial);
  const [hovered, setHovered] = useState<T | null>(null);
  const peek = useMemo<Peek<T>>(() => ({ hover: setHovered, leave: () => setHovered(null), pin: setPinned }), []);
  const shown = hovered ?? pinned;
  return { shown, isPinned: shown !== null && shown === pinned, peek };
}

/** A card's pointer and focus handlers for `peek`; clicks are left to `clicks`, which pins with its show. */
export const peekProps = <T>(peek: Peek<T>, card: T) => ({
  onMouseEnter: () => peek.hover(card),
  onMouseLeave: peek.leave,
  onFocus: () => peek.hover(card),
  onBlur: peek.leave,
});
