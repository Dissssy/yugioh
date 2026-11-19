// Pointer helpers: which drop target is under the pointer, and the arrows drawn for aimed attacks and effect targets.

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

/** A curved arrow between two points, bent sideways a little in proportion to its length. */
function curve(from: Point, to: Point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bend = { x: (from.x + to.x) / 2 - dy * 0.15, y: (from.y + to.y) / 2 + dx * 0.15 };
  return `M${from.x},${from.y} Q${bend.x},${bend.y} ${to.x},${to.y}`;
}

/**
 * Arrows drawn over the board: the one you aim an attack with (`kind` 'aim'), and the lines from an activated effect
 * to its targets ('target').
 */
export function Arrows({ arrows, kind }: { arrows: { from: Point; to: Point }[]; kind: 'aim' | 'target' }) {
  const head = `arrow-head-${kind}`;
  return (
    <svg className={`arrows ${kind}`} aria-hidden="true">
      <defs>
        <marker id={head} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" />
        </marker>
      </defs>
      {arrows.map(({ from, to }, i) => (
        <path key={i} d={curve(from, to)} markerEnd={`url(#${head})`} />
      ))}
    </svg>
  );
}

/** The centre of a card on the board, by its ID. */
export function cardCentre(id: string): Point | null {
  const el = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
