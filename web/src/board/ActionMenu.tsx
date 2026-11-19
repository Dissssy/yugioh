import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import { useEffect } from 'react';

/** What you can do with the card you clicked, in a small menu right next to it. */
export function ActionMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: HTMLElement;
  items: { label: string; run: () => void }[];
  onClose: () => void;
}) {
  const { refs, floatingStyles } = useFloating({
    elements: { reference: anchor },
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!refs.floating.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [anchor, onClose, refs]);

  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} className="action-menu" role="menu">
        {items.map((item, i) => (
          <button key={item.label} role="menuitem" onClick={item.run} autoFocus={i === 0}>
            {item.label}
          </button>
        ))}
      </div>
    </FloatingPortal>
  );
}
