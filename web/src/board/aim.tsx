// Pointer helpers for dragging: which drop target is under the pointer, and the arrow drawn while aiming an attack.

export interface Point {
  x: number;
  y: number;
}

/** The `data-drop` key of the drop target under a viewport point, if any. */
export function dropAt(point: Point): string | null {
  for (const el of document.elementsFromPoint(point.x, point.y)) {
    const target = el.closest<HTMLElement>('[data-drop]');
    if (target) return target.dataset.drop!;
  }
  return null;
}

/** The centre of the element with this drop key, for snapping the arrow to a target. */
export function dropCentre(key: string): Point | null {
  const el = document.querySelector<HTMLElement>(`[data-drop="${key}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A curved arrow from the attacking card to the pointer, snapped onto a target when over one. */
export function AimArrow({ from, to }: { from: Point; to: Point }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Bend the curve sideways a little, proportional to its length.
  const bend = { x: (from.x + to.x) / 2 - dy * 0.15, y: (from.y + to.y) / 2 + dx * 0.15 };
  return (
    <svg className="aim-arrow" aria-hidden="true">
      <defs>
        <marker id="aim-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" />
        </marker>
      </defs>
      <path d={`M${from.x},${from.y} Q${bend.x},${bend.y} ${to.x},${to.y}`} markerEnd="url(#aim-head)" />
    </svg>
  );
}
