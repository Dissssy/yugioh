import { useEffect } from 'react';

/** What a shortcut does on the board, handled by Board. */
export type Shortcut = 'pass' | 'next' | 'end' | 'confirm' | 'log' | 'chat' | 'ask' | 'help';

interface Key {
  keys: string;
  does: string;
  /** The letter that runs it, for single-key shortcuts that work anywhere outside a text field. */
  letter?: string;
  shortcut?: Shortcut;
}

/** Every key of the duel screen, in groups. This one table both runs the shortcuts and draws the help. */
export const KEYS: { group: string; keys: Key[] }[] = [
  {
    group: 'Moving around',
    keys: [
      { keys: 'Tab, Shift+Tab', does: 'Move between the board, the turn controls, the log and the chat' },
      { keys: 'Arrows', does: 'Move to the nearest card, zone or pile in that direction; while choosing, only to what you may pick' },
      { keys: 'Enter', does: "What a click does: open the card's menu, open a pile, pick or unpick" },
      { keys: 'Esc', does: 'Back one step: close a menu or pile, cancel a choice, unpin details, leave the log or chat' },
      { keys: 'I', does: "Pin the focused card's details" },
      { keys: 'Shift (hold)', does: 'Zoom in on the focused card' },
    ],
  },
  {
    group: 'In a menu',
    keys: [
      { keys: 'Up, Down', does: 'Move through the items' },
      { keys: '1 to 9', does: 'Choose that item' },
      { keys: 'Left, Right', does: 'After Move in hand: move the card along your hand; Enter or Esc when done' },
    ],
  },
  {
    group: 'Anywhere outside a text field',
    keys: [
      { keys: 'P', letter: 'p', shortcut: 'pass', does: "Pass, or don't activate an optional trigger" },
      { keys: 'N', letter: 'n', shortcut: 'next', does: 'Go to the next phase' },
      { keys: 'E', letter: 'e', shortcut: 'end', does: 'End the turn' },
      { keys: 'C', letter: 'c', shortcut: 'confirm', does: 'Confirm your answer to the judge' },
      { keys: 'L', letter: 'l', shortcut: 'log', does: 'Go to the log, on its newest entry (Enter on a ruling to contest it)' },
      { keys: 'T', letter: 't', shortcut: 'chat', does: 'Type in the chat' },
      { keys: 'Q', letter: 'q', shortcut: 'ask', does: 'Ask the judge a question' },
      { keys: '?', letter: '?', shortcut: 'help', does: 'Show these keys' },
    ],
  },
];

const byLetter = new Map(KEYS.flatMap((g) => g.keys.flatMap((k) => (k.letter && k.shortcut ? [[k.letter, k.shortcut] as const] : []))));

/** The shortcut a key press runs, if any. */
export const shortcutOf = (e: KeyboardEvent): Shortcut | null =>
  e.ctrlKey || e.metaKey || e.altKey ? null : (byLetter.get(e.key.toLowerCase()) ?? null);

export function KeyHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet key-help" role="dialog" aria-label="Keyboard controls" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3>Keyboard controls</h3>
          <span className="spacer" />
          <button onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        {KEYS.map((g) => (
          <section key={g.group}>
            <h4>{g.group}</h4>
            <dl>
              {g.keys.map((k) => (
                <div key={k.keys}>
                  <dt>
                    <kbd>{k.keys}</kbd>
                  </dt>
                  <dd>{k.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
