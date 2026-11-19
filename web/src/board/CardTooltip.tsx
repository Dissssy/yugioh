import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import type { CardData } from '@yugioh/engine';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { CardDetail } from './CardDetail.tsx';

/** How long the pointer rests on a card before its details appear, so sweeping across the board shows nothing. */
const HOVER_DELAY_MS = 250;

interface Hover {
  card: CardData;
  el: HTMLElement;
  pinned: boolean;
}

type Bind = (card: CardData | null) => {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
};

const TooltipContext = createContext<Bind>(() => ({}));

/** Handlers that show a card's details next to the element they're spread on. Hidden cards (null) get none. */
export const useCardHover = () => useContext(TooltipContext);

/**
 * Card details in a tooltip beside the hovered card. Right-click or Shift pins it open so long text can be
 * scrolled; Esc or a click elsewhere closes it. `suppressed` hides it while the player is choosing or dragging.
 */
export function CardTooltipProvider({ suppressed, children }: { suppressed: boolean; children: ReactNode }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<{ card: CardData; el: HTMLElement } | null>(null);
  const { refs, floatingStyles } = useFloating({
    elements: { reference: hover?.el ?? null },
    placement: 'right',
    middleware: [offset(10), flip({ fallbackPlacements: ['left', 'top', 'bottom'] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const bind = useCallback<Bind>(
    (card) =>
      card
        ? {
            onPointerEnter: (e) => {
              const el = e.currentTarget;
              pending.current = { card, el };
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setHover((h) => (h?.pinned ? h : { card, el, pinned: false })), HOVER_DELAY_MS);
            },
            onPointerLeave: () => {
              pending.current = null;
              clearTimeout(timer.current);
              setHover((h) => (h?.pinned ? h : null));
            },
            onContextMenu: (e) => {
              e.preventDefault();
              clearTimeout(timer.current);
              setHover({ card, el: e.currentTarget, pinned: true });
            },
          }
        : {},
    [],
  );

  useEffect(() => {
    if (suppressed) {
      clearTimeout(timer.current);
      setHover(null);
    }
  }, [suppressed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHover(null);
      if (e.key === 'Shift' && pending.current) setHover({ ...pending.current, pinned: true });
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const floating = refs.floating.current;
      if (floating && !floating.contains(e.target as Node)) setHover((h) => (h?.pinned ? null : h));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [refs]);

  return (
    <TooltipContext.Provider value={suppressed ? () => ({}) : bind}>
      {children}
      {hover && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={`card-tooltip${hover.pinned ? ' pinned' : ''}`}
            role="tooltip"
          >
            <CardDetail card={hover.card} />
          </div>
        </FloatingPortal>
      )}
    </TooltipContext.Provider>
  );
}
