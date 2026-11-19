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
}

const LookContext = createContext<BoardLook>({ zone: 100, imageSize: 'small' });
export const BoardLookProvider = LookContext.Provider;
export const useBoardLook = () => useContext(LookContext);

/** The small images are 168 pixels wide; past that the full ones look sharper. */
const SMALL_IMAGE_WIDTH = 168;
/** A card's height inside its zone, and its width from the card's 59 × 86 mm shape. */
export const CARD_HEIGHT_IN_ZONE = 0.92;
export const CARD_ASPECT = 59 / 86;
const MAX_ZONE = 170;

/**
 * Sizes the board to fit its container without scrolling. Vertically the table stacks: the opponent's hand
 * (half shown), four zone rows around the middle row of Extra Monster Zones, and your hand (a little over one zone); horizontally seven
 * zone columns.
 */
export function useBoardSize(el: HTMLElement | null): BoardLook {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  const GAP = 6;
  const byHeight = (size.height - 6 * GAP) / (0.5 + 5 + 1.2);
  const byWidth = (size.width - 6 * GAP) / 7;
  const zone = Math.max(48, Math.floor(Math.min(byHeight, byWidth, MAX_ZONE)));
  const cardWidth = zone * CARD_HEIGHT_IN_ZONE * CARD_ASPECT;
  const imageSize: ImageSize = cardWidth * window.devicePixelRatio > SMALL_IMAGE_WIDTH ? 'full' : 'small';
  return { zone, imageSize };
}
