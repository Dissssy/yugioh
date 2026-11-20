import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import { useEffect } from 'react';

/**
 * What you can do with the card you clicked, in a small menu right next to it. `notes` are what you can't do now,
 * each opening code's reason ("Why can't I?").
 */
export function ActionMenu({
  anchor,
  items,
  notes = [],
  onClose,
}: {
  anchor: HTMLElement;
  items: { label: string; run: () => void }[];
  notes?: { label: string; reason: string }[];
  onClose: () => void;
}) {
  const { refs, floatingStyles } = useFloating({
    elements: { reference: anchor },
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    // Esc (or Left) closes the menu and gives focus back to the card it opened from.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && !(e.key === 'ArrowLeft' && refs.floating.current?.contains(e.target as Node))) return;
      e.preventDefault();
      onClose();
      anchor.focus();
    };
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

  /** Up and Down move through the items and reasons, 1 to 9 choose an item, Right chooses the focused one. */
  const menuKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const entries = [...e.currentTarget.querySelectorAll<HTMLElement>('button, summary')];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= items.length) items[digit - 1]!.run();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') entries[(at + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
    else if (e.key === 'ArrowRight') entries[at]?.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} className="action-menu" role="menu" onKeyDown={menuKeys}>
        {items.map((item, i) => (
          <button key={item.label} role="menuitem" onClick={item.run} autoFocus={i === 0}>
            {items.length > 1 && <span className="menu-number">{i + 1}</span>}
            {item.label}
          </button>
        ))}
        {notes.map((note, i) => (
          <details key={i} className="why-not">
            <summary autoFocus={items.length === 0 && i === 0}>{note.label}</summary>
            <p>{note.reason}</p>
          </details>
        ))}
      </div>
    </FloatingPortal>
  );
}
