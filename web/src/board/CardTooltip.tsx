import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import type { CardData } from '@yugioh/engine';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { CardDetail } from './CardDetail.tsx';

/** How long the pointer rests on a card before its details appear, so sweeping across the board shows nothing. */
const HOVER_DELAY_MS = 250;
/** Space between the zoomed card and the card it shows, and between it and the screen edge. */
const ZOOM_GAP = 16;
/** How long a touch rests on a card before its details pin open, and how far it may wander before it's a drag instead. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;
/** How long Shift is held alone before it zooms, so Shift+Tab doesn't flash a zoom. */
const SHIFT_ALONE_MS = 150;

/** The card element a focused element shows: itself, or a card inside it (a pile's top card). */
const focusedCard = (): HTMLElement | null => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  return el.closest<HTMLElement>('[data-zoom]') ?? el.querySelector<HTMLElement>('[data-zoom]');
};

interface Hover {
  card: CardData;
  el: HTMLElement;
  pinned: boolean;
}

/** A monster's ATK, DEF and Level on the field now, which effects may have changed from the printed ones. */
export interface Stats {
  atk: number;
  def: number;
  level: number | null;
}

type Bind = (card: CardData | null, stats?: Stats | null) => {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  /** Marks the element as showing this card (its passcode), for zooming in on whatever is under the pointer. */
  'data-zoom'?: number;
  /** Its ATK, DEF and Level now, as `atk/def/level` (Level empty when it has none), read when its details show so they are always current. */
  'data-stats'?: string;
};

const statsOf = (el: HTMLElement): Stats | null => {
  const [atk, def, level] = el.dataset.stats?.split('/') ?? [];
  return atk === undefined || def === undefined ? null : { atk: Number(atk), def: Number(def), level: level ? Number(level) : null };
};

const TooltipContext = createContext<Bind>(() => ({}));

/** Handlers that show a card's details next to the element they're spread on. Hidden cards (null) get none. */
export const useCardHover = () => useContext(TooltipContext);

/**
 * Card details in a tooltip beside the hovered card. Right-click, or on a touch screen a long press, pins it open so
 * long text can be scrolled; Esc or a click elsewhere closes it. `suppressed` hides it while the player is choosing or dragging.
 * `pinnedFooter` adds controls under a pinned card's details.
 *
 * Holding Shift zooms instead: the card under the pointer is shown as large as fits beside it, with its text,
 * until Shift is released. Zoom is asked for on purpose, so it works while suppressed too, aiming an attack included.
 * When the keyboard was used last, Shift zooms the focused card instead, and I pins its details (docs/keyboard.md).
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
    (card, stats) => {
      if (!card) return {};
      known.current.set(card.code, card);
      const marks = { 'data-zoom': card.code, 'data-stats': stats ? `${stats.atk}/${stats.def}/${stats.level ?? ''}` : undefined };
      if (suppressed) return marks;
      return {
        ...marks,
        onPointerEnter: (e) => {
          // Touch has no hover; a long press pins the details instead.
          if (e.pointerType !== 'mouse') return;
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
    /** Whether the keyboard was used since the pointer last moved. */
    let keyboard = false;
    let shiftTimer: ReturnType<typeof setTimeout> | undefined;
    const zoomAtPointer = () => {
      const at = pointer.current;
      const el = keyboard
        ? focusedCard()
        : at && document.elementsFromPoint(at.x, at.y).map((e) => e.closest<HTMLElement>('[data-zoom]')).find((e) => e);
      const card = el && known.current.get(Number(el.dataset.zoom));
      setZoom((z) => (card && el ? (z?.el === el && z.card === card ? z : { card, el }) : null));
    };
    const onKey = (e: KeyboardEvent) => {
      const inText = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === 'Escape') setHover(null);
      // Shift with another key (Shift+Tab) isn't a zoom.
      if (e.key !== 'Shift') clearTimeout(shiftTimer);
      if (e.key !== 'Shift' && e.key !== 'Escape') keyboard = true;
      // Shift while typing (capitals in the chat or a search box) is not a request to zoom.
      if (e.key === 'Shift' && !e.repeat && !inText) {
        shiftTimer = setTimeout(() => {
          zoomHeld.current = true;
          zoomAtPointer();
        }, SHIFT_ALONE_MS);
      }
      if (e.key.toLowerCase() === 'i' && !inText && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLSelectElement)) {
        const el = focusedCard();
        const card = el && known.current.get(Number(el.dataset.zoom));
        if (el && card) setHover({ card, el, pinned: true });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      clearTimeout(shiftTimer);
      zoomHeld.current = false;
      setZoom(null);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      onPressMove(e);
      pointer.current = { x: e.clientX, y: e.clientY };
      keyboard = false;
      if (zoomHeld.current) zoomAtPointer();
    };
    // Leaving the window while holding Shift gives no keyup.
    const onBlur = () => {
      zoomHeld.current = false;
      setZoom(null);
    };
    let press: ReturnType<typeof setTimeout> | undefined;
    let pressAt: { x: number; y: number } | null = null;
    const cancelPress = () => {
      clearTimeout(press);
      pressAt = null;
    };
    /** The click a long press ends with isn't a tap on the card (which would open its menu). */
    const swallowClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const onDown = (e: globalThis.PointerEvent) => {
      window.removeEventListener('click', swallowClick, true);
      const floating = refs.floating.current;
      if (floating && !floating.contains(e.target as Node)) setHover((h) => (h?.pinned ? null : h));
      // A long press pins the card under the finger, while choosing or dragging too, as Shift zooms.
      const el = e.pointerType !== 'mouse' && e.target instanceof Element ? e.target.closest<HTMLElement>('[data-zoom]') : null;
      const card = el && known.current.get(Number(el.dataset.zoom));
      cancelPress();
      if (!el || !card) return;
      pressAt = { x: e.clientX, y: e.clientY };
      press = setTimeout(() => {
        pressAt = null;
        setHover({ card, el, pinned: true });
        window.addEventListener('click', swallowClick, { capture: true, once: true });
      }, LONG_PRESS_MS);
    };
    const onPressMove = (e: globalThis.PointerEvent) => {
      if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > LONG_PRESS_SLOP_PX) cancelPress();
    };
    const onUp = () => cancelPress();
    // Touch browsers open their own menu (save image, select text) on a long press; on a card, the details are it.
    const onContextMenu = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-zoom]')) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    const onFocus = () => keyboard && zoomHeld.current && zoomAtPointer();
    window.addEventListener('focusin', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      cancelPress();
      window.removeEventListener('click', swallowClick, true);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      clearTimeout(shiftTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('focusin', onFocus);
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
            <CardDetail card={hover.card} stats={statsOf(hover.el)} />
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
        <CardDetail card={card} stats={statsOf(el)} />
      </div>
    </FloatingPortal>
  );
}
