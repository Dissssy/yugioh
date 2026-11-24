import { useState, type ReactNode } from 'react';

/**
 * A question the duel waits on this player to answer (the judge's question, a response window they can respond in,
 * a rewind offer, a detach or discard choice), over the field on one side of the middle strip so it is hard to miss
 * and has room for its whole text. The board stays usable: cards to pick are clicked where they are, `over` keeps it
 * off the side they're on, and Hide folds it to a tab while the player looks underneath. Waiting with nothing to
 * decide stays in the strip.
 */
export function DecisionPopup({ id, over, children }: { id: string; over: 'foe' | 'mine'; children: ReactNode }) {
  // Hidden for this question only: the next one shows again.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (hiddenFor === id) {
    return (
      <button className={`decision-tab over-${over}`} onClick={() => setHiddenFor(null)}>
        Show the question
      </button>
    );
  }
  return (
    <div className={`decision over-${over}`} role="dialog" aria-label="Your decision">
      <div className="decision-body">{children}</div>
      <button className="quiet decision-hide" onClick={() => setHiddenFor(id)} aria-label="Hide the question to see the board">
        Hide
      </button>
    </div>
  );
}
