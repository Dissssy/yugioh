import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import type { CardData } from '@yugioh/engine';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { CardDetail } from './CardDetail.tsx';

/** How long the pointer rests on a card before its details appear, so sweeping across the board shows nothing. */
const HOVER_DELAY_MS = 250;
/** Space between the zoomed card and the card it shows, and between it and the screen edge. */
const ZOOM_GAP = 16;

interface Hover {
  card: CardData;
  el: HTMLElement;
  pinned: boolean;
}

type Bind = (card: CardData | null) => {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  /** Marks the element as showing this card (its passcode), for zooming in on whatever is under the pointer. */
  'data-zoom'?: number;
};

const TooltipContext = createContext<Bind>(() => ({}));

/** Handlers that show a card's details next to the element they're spread on. Hidden cards (null) get none. */
export const useCardHover = () => useContext(TooltipContext);

/**
 * Card details in a tooltip beside the hovered card. Right-click pins it open so long text can be
 * scrolled; Esc or a click elsewhere closes it. `suppressed` hides it while the player is choosing or dragging.
 * `pinnedFooter` adds controls under a pinned card's details.
 *
 * Holding Shift zooms instead: the card under the pointer is shown as large as fits beside it, with its text,
 * until Shift is released. Zoom is asked for on purpose, so it works while suppressed too, aiming an attack included.
 */
export function CardTooltipProvider({
  suppressed,
  pinnedFooter,
  children,
}: {
  suppressed: boolean;
  pinnedFooter?: (card: CardData) => ReactNode;
  children: ReactNode;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Every card handed to `bind`, by passcode, so the element under the pointer leads back to its card. */
  const known = useRef(new Map<number, CardData>());
  const zoomHeld = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState<{ card: CardData; el: HTMLElement } | null>(null);
  const { refs, floatingStyles } = useFloating({
    elements: { reference: hover?.el ?? null },
    placement: 'right',
    middleware: [offset(10), flip({ fallbackPlacements: ['left', 'top', 'bottom'] }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const bind = useCallback<Bind>(
    (card) => {
      if (!card) return {};
      known.current.set(card.code, card);
      if (suppressed) return { 'data-zoom': card.code };
      return {
        'data-zoom': card.code,
        onPointerEnter: (e) => {
          const el = e.currentTarget;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setHover((h) => (h?.pinned ? h : { card, el, pinned: false })), HOVER_DELAY_MS);
        },
        onPointerLeave: () => {
          clearTimeout(timer.current);
          setHover((h) => (h?.pinned ? h : null));
        },
        onContextMenu: (e) => {
          e.preventDefault();
          clearTimeout(timer.current);
          setHover({ card, el: e.currentTarget, pinned: true });
        },
      };
    },
    [suppressed],
  );

  useEffect(() => {
    if (suppressed) {
      clearTimeout(timer.current);
      setHover(null);
    }
  }, [suppressed]);

  useEffect(() => {
    /**
     * The card under the pointer, found from where the pointer is rather than from enter and leave events, which some
     * browsers don't send while a button is held (aiming an attack).
     */
    const zoomAtPointer = () => {
      const at = pointer.current;
      const el = at && document.elementsFromPoint(at.x, at.y).map((e) => e.closest<HTMLElement>('[data-zoom]')).find((e) => e);
      const card = el && known.current.get(Number(el.dataset.zoom));
      setZoom((z) => (card && el ? (z?.el === el && z.card === card ? z : { card, el }) : null));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHover(null);
      // Shift while typing (capitals in the chat or a search box) is not a request to zoom.
      if (e.key === 'Shift' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        zoomHeld.current = true;
        zoomAtPointer();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      zoomHeld.current = false;
      setZoom(null);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      if (zoomHeld.current) zoomAtPointer();
    };
    // Leaving the window while holding Shift gives no keyup.
    const onBlur = () => {
      zoomHeld.current = false;
      setZoom(null);
    };
    const onDown = (e: globalThis.PointerEvent) => {
      const floating = refs.floating.current;
      if (floating && !floating.contains(e.target as Node)) setHover((h) => (h?.pinned ? null : h));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
    };
  }, [refs]);

  return (
    <TooltipContext.Provider value={bind}>
      {children}
      {zoom && <CardZoom card={zoom.card} el={zoom.el} />}
      {hover && !zoom && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={`card-tooltip${hover.pinned ? ' pinned' : ''}`}
            role="tooltip"
          >
            <CardDetail card={hover.card} />
            {hover.pinned && pinnedFooter?.(hover.card)}
          </div>
        </FloatingPortal>
      )}
    </TooltipContext.Provider>
  );
}

/**
 * The zoomed card: as tall as the screen, with its text beside it. It sits beside the hovered card on the side with
 * more room and shrinks to fit there, so it never covers the card being pointed at.
 */
function CardZoom({ card, el }: { card: CardData; el: HTMLElement }) {
  const rect = el.getBoundingClientRect();
  const roomRight = window.innerWidth - rect.right;
  const toRight = roomRight >= rect.left;
  const style: Record<string, number | string> = {
    ...(toRight ? { left: rect.right + ZOOM_GAP } : { right: window.innerWidth - rect.left + ZOOM_GAP }),
    '--room': `${(toRight ? roomRight : rect.left) - 2 * ZOOM_GAP}px`,
  };
  return (
    <FloatingPortal>
      <div className="card-zoom" style={style as CSSProperties} role="tooltip">
        <CardDetail card={card} />
      </div>
    </FloatingPortal>
  );
}
