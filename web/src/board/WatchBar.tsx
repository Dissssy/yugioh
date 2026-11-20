import type { Seat } from '@yugioh/engine';

/** What someone watching a live duel sees in place of the chat box: that they're watching, and from whose side. */
export function WatchBar({ from, setFrom, names }: { from: Seat; setFrom: (from: Seat) => void; names: [string, string] }) {
  return (
    <div className="replay-bar" data-area="chat">
      <p className="watch-note" role="status">
        <span className="dot live" /> Watching live. You see only the cards both players can see.
      </p>
      <div className="replay-from" role="radiogroup" aria-label="Watch from">
        <span className="muted small">Watch from</span>
        {([0, 1] as const).map((seat) => (
          <button key={seat} role="radio" aria-checked={from === seat} className={from === seat ? 'primary' : 'quiet'} onClick={() => setFrom(seat)}>
            {names[seat]}
          </button>
        ))}
      </div>
    </div>
  );
}
