import { createContext, useContext, useEffect, useState } from 'react';
import type { ImageSize } from './Card.tsx';

/** How a card should look given what the player is doing: selected, playable, pickable for a choice, and so on. */
export interface CardMarks {
  classes(id: string | null): string;
}

/** Board-wide sizing: the zone edge in pixels and which image size is sharp enough at it. */
export interface BoardLook {
  zone: number;
  imageSize: ImageSize;
  /** A portrait screen: the board takes the full width, with the log below it. */
  stacked: boolean;
  /**
   * Zones too small (or a board too narrow) to fit the turn controls and prompts in the row between the fields: they
   * go in a bar beside the board instead.
   */
  compact: boolean;
  /** Zones so small that the Life Points plates shrink to a zone's width, beside the hands, and labels shrink with them. */
  tight: boolean;
}

const LookContext = createContext<BoardLook>({ zone: 100, imageSize: 'small', stacked: false, compact: false, tight: false });
export const BoardLookProvider = LookContext.Provider;
export const useBoardLook = () => useContext(LookContext);

/** The small images are 168 pixels wide; past that the full ones look sharper. */
const SMALL_IMAGE_WIDTH = 168;
/** A card's height inside its zone, and its width from the card's 59 × 86 mm shape. */
export const CARD_HEIGHT_IN_ZONE = 0.92;
export const CARD_ASPECT = 59 / 86;
const MAX_ZONE = 170;
const PORTRAIT = '(orientation: portrait)';
/** The smallest zone whose row between the fields still fits the turn's label, phases and End turn button. */
const COMPACT_BELOW_ZONE = 110;
/** The smallest zone beside which a full Life Points plate, with the player's name, still clears the hand. */
const TIGHT_BELOW_ZONE = 80;
/** On a portrait screen, the share of the screen's height the board may take; the rest is the log and chat. */
const STACKED_BOARD_SHARE = 0.62;
/** The table's vertical padding when stacked, as set in board.css. */
const STACKED_PADDING = 8;

/**
 * Sizes the board to fit without scrolling. Vertically the table stacks: the opponent's hand (half shown), four zone
 * rows around the middle row of Extra Monster Zones, and your hand (a little over one zone); horizontally seven zone
 * columns. Beside the log, the board fills its container. Stacked above the log on a portrait screen, it takes the full
 * width and its height follows from that, up to a share of the screen.
 */
export function useBoardSize(el: HTMLElement | null): BoardLook {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [stacked, setStacked] = useState(() => window.matchMedia(PORTRAIT).matches);
  useEffect(() => {
    const query = window.matchMedia(PORTRAIT);
    const onChange = () => setStacked(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const [screenHeight, setScreenHeight] = useState(window.innerHeight);
  useEffect(() => {
    const onResize = () => setScreenHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const GAP = 6;
  const height = stacked ? screenHeight * STACKED_BOARD_SHARE - STACKED_PADDING : size.height;
  const byHeight = (height - 6 * GAP) / (0.5 + 5 + 1.2);
  const byWidth = (size.width - 6 * GAP) / 7;
  const zone = Math.max(40, Math.floor(Math.min(byHeight, byWidth, MAX_ZONE)));
  const cardWidth = zone * CARD_HEIGHT_IN_ZONE * CARD_ASPECT;
  const imageSize: ImageSize = cardWidth * window.devicePixelRatio > SMALL_IMAGE_WIDTH ? 'full' : 'small';
  return { zone, imageSize, stacked, compact: stacked || zone < COMPACT_BELOW_ZONE, tight: zone < TIGHT_BELOW_ZONE };
}
