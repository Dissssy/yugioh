// Keyboard control of the duel screen (docs/keyboard.md): the board, the strip, the log and the chat are areas that
// Tab moves between; arrows move inside one by what is on screen, so any layout works without a grid table.

import { useCallback, useEffect, useRef } from 'react';

export type Direction = 'up' | 'down' | 'left' | 'right';

export const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * The element nearest `from` in `direction`, by their boxes on screen. Elements ahead in that direction count, and
 * the distance across the direction weighs double, so focus keeps to its row or column when there is something there.
 */
export function nearest(from: Element, direction: Direction, candidates: Element[]): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === from || !(el instanceof HTMLElement)) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const [along, across] = direction === 'left' ? [-dx, dy] : direction === 'right' ? [dx, dy] : direction === 'up' ? [-dy, dx] : [dy, dx];
    // Ahead by at least a little, so a card beside this one isn't "below" it by a pixel.
    if (along <= 2) continue;
    const score = along + 2 * Math.abs(across);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

type Area = 'board' | 'strip' | 'log' | 'chat';
const AREAS: Area[] = ['board', 'strip', 'log', 'chat'];

const visible = (el: Element) => el instanceof HTMLElement && el.offsetParent !== null;

/** What each area offers to focus, in document order. */
function itemsOf(root: HTMLElement, area: Area, restrict: boolean): HTMLElement[] {
  const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].filter(visible);
  switch (area) {
    case 'board':
      return all(restrict ? '[data-nav][data-pick]' : '[data-nav]');
    case 'strip':
      return all('[data-area="strip"] :is(button, select, input, a[href]):not(:disabled)').filter((el) => !el.closest('[data-nav]'));
    case 'log':
      return all('.duel-log :is(summary, li)');
    case 'chat':
      return all('[data-area="chat"] :is(input, button, select):not(:disabled)');
  }
}

/** The area an element belongs to, if it is one of an area's items. */
function areaOf(root: HTMLElement, el: Element | null, restrict: boolean): Area | null {
  if (!(el instanceof HTMLElement) || !root.contains(el)) return null;
  return AREAS.find((area) => itemsOf(root, area, restrict).includes(el)) ?? null;
}

/** Whether a key press is typing, which shortcuts must leave alone. */
export const typing = (e: KeyboardEvent) =>
  e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;

/**
 * Keyboard focus on the duel screen. `restrict` limits the board to what may be picked now (`data-pick`), during a
 * choice. Returns `focusArea`, which moves focus to an area: on the board the first pickable item while choosing, else
 * the element focused there last, else your hand; and whether the keyboard was used last.
 */
export function useKeyboardNav(root: HTMLElement | null, restrict: boolean) {
  /** The `data-nav` key (or the element, elsewhere) each area had focused last, to come back to. */
  const last = useRef(new Map<Area, string | HTMLElement>());
  const keyboard = useRef(false);

  useEffect(() => {
    const onPointer = () => (keyboard.current = false);
    const onKey = (e: KeyboardEvent) => e.key !== 'Shift' && (keyboard.current = true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const focusArea = useCallback(
    (area: Area, fresh = false) => {
      if (!root) return false;
      const items = itemsOf(root, area, restrict);
      const remembered = fresh ? undefined : last.current.get(area);
      const again =
        typeof remembered === 'string' ? items.find((el) => el.dataset.nav === remembered) : items.find((el) => el === remembered);
      const start =
        area === 'log'
          ? items.at(-1)
          : area === 'chat'
            ? (items.find((el) => el.tagName === 'INPUT') ?? items[0])
            : area === 'board' && !restrict
              ? (items.find((el) => el.closest('.hand.own')) ?? items[0])
              : items[0];
      const el = again ?? start;
      el?.focus();
      return el !== undefined;
    },
    [root, restrict],
  );

  // Remember where focus was in each area.
  useEffect(() => {
    if (!root) return;
    const onFocus = (e: FocusEvent) => {
      const area = areaOf(root, e.target as Element, false);
      const el = e.target as HTMLElement;
      if (area) last.current.set(area, el.dataset.nav ?? el);
    };
    root.addEventListener('focusin', onFocus);
    return () => root.removeEventListener('focusin', onFocus);
  }, [root]);

  // A choice starting puts focus on its first option, for a player using the keyboard.
  useEffect(() => {
    if (restrict && keyboard.current) focusArea('board', true);
  }, [restrict, focusArea]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!root || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const area = areaOf(root, target, restrict);
      if (e.key === 'Tab') {
        // Inside a form or menu Tab works as usual; from an area's item (or from nowhere) it moves between areas.
        if (!area && target !== document.body) return;
        const from = area ? AREAS.indexOf(area) : -1;
        for (let i = 1; i <= AREAS.length; i++) {
          const next = AREAS[(from + (e.shiftKey ? -i : i) + AREAS.length * 2) % AREAS.length]!;
          if (focusArea(next)) break;
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && (area === 'log' || area === 'chat' || area === 'strip')) {
        focusArea('board');
        e.preventDefault();
        return;
      }
      // Enter does what a click does. Buttons and summaries answer Enter by themselves.
      if ((e.key === 'Enter' || e.key === ' ') && area === 'board' && target.tagName !== 'BUTTON') {
        target.click();
        e.preventDefault();
        return;
      }
      // On a log entry, Enter opens what it offers: Contest on a ruling, Escalate on an answer from the judge.
      if (e.key === 'Enter' && area === 'log' && target.tagName === 'LI') {
        target.querySelector<HTMLElement>(':scope > button')?.click();
        e.preventDefault();
        return;
      }
      const direction = ARROWS[e.key];
      // Left and Right edit the text, or move the replay's seek bar.
      if (!direction || (target.tagName === 'INPUT' && (direction === 'left' || direction === 'right'))) return;
      if (!area) {
        if (target !== document.body) return;
        focusArea('board');
        e.preventDefault();
        return;
      }
      const items = itemsOf(root, area, restrict);
      let next: HTMLElement | null | undefined;
      if (area === 'log') {
        if (direction === 'left' || direction === 'right') return;
        next = items[items.indexOf(target) + (direction === 'up' ? -1 : 1)];
      } else {
        next = nearest(target, direction, items);
      }
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    },
    [root, restrict, focusArea],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return { focusArea, usingKeyboard: () => keyboard.current };
}
