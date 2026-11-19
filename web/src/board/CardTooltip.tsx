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
};

const TooltipContext = createContext<Bind>(() => ({}));

/** Handlers that show a card's details next to the element they're spread on. Hidden cards (null) get none. */
export const useCardHover = () => useContext(TooltipContext);

/**
 * Card details in a tooltip beside the hovered card. Right-click or Shift pins it open so long text can be
 * scrolled; Esc or a click elsewhere closes it. `suppressed` hides it while the player is choosing or dragging.
 * `pinnedFooter` adds controls under a pinned card's details.
 *
 * Holding Alt zooms instead: the card under the pointer is shown as large as fits beside it, with its text,
 * until Alt is released. Zoom is asked for on purpose, so it works while suppressed too.
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
  const pending = useRef<{ card: CardData; el: HTMLElement } | null>(null);
  const altHeld = useRef(false);
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
      const track = {
        onPointerEnter: (e: PointerEvent<HTMLElement>) => {
          pending.current = { card, el: e.currentTarget };
          if (altHeld.current) setZoom(pending.current);
        },
        onPointerLeave: () => {
          pending.current = null;
          setZoom(null);
        },
      };
      if (suppressed) return track;
      return {
        onPointerEnter: (e) => {
          track.onPointerEnter(e);
          const el = e.currentTarget;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setHover((h) => (h?.pinned ? h : { card, el, pinned: false })), HOVER_DELAY_MS);
        },
        onPointerLeave: () => {
          track.onPointerLeave();
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHover(null);
      if (e.key === 'Shift' && pending.current) setHover({ ...pending.current, pinned: true });
      if (e.key === 'Alt') {
        // Alone, Alt would focus the browser's menu bar on Windows and Linux.
        e.preventDefault();
        altHeld.current = true;
        setZoom(pending.current);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      e.preventDefault();
      altHeld.current = false;
      setZoom(null);
    };
    // Alt-Tab leaves the page without a keyup.
    const onBlur = () => {
      altHeld.current = false;
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
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', onDown);
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
