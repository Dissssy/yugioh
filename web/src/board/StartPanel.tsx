import { HANDS, type Hand, type Intent, type PlayerView, type Seat, type StartView } from '@yugioh/engine';

const icon: Record<Hand, string> = { rock: '✊', paper: '✋', scissors: '✌️' };
const label = (h: Hand) => h[0]!.toUpperCase() + h.slice(1);

/**
 * Deciding who goes first, over the empty table: both players pick rock, paper or scissors (a tie picks again), then
 * the winner chooses to go first or second. `can` says whether this player may act now.
 */
export function StartPanel({ start, view, can, send }: { start: StartView; view: PlayerView; can: boolean; send: (intent: Intent) => void }) {
  const me = view.you;
  const foe: Seat = me === 0 ? 1 : 0;
  const foeName = view.players[foe].name;
  const thrown = (hands: [Hand, Hand]) => (
    <p className="rps-thrown">
      <span>
        You <b>{icon[hands[me]]}</b>
      </span>
      <span className="muted">vs</span>
      <span>
        <b>{icon[hands[foe]]}</b> {foeName}
      </span>
    </p>
  );

  if (start.at === 'order') {
    const won = start.chooser === me;
    return (
      <div className="table-overlay start-panel" role="dialog" aria-label="Who goes first">
        {thrown(start.hands)}
        <strong>{won ? 'You win!' : `${foeName} wins`}</strong>
        {won ? (
          <div className="row">
            <button className="primary" disabled={!can} onClick={() => send({ type: 'chooseOrder', goFirst: true })}>
              Go first
            </button>
            <button disabled={!can} onClick={() => send({ type: 'chooseOrder', goFirst: false })}>
              Go second
            </button>
          </div>
        ) : (
          <span className="judging" role="status">
            <span className="dot" /> {foeName} is choosing who goes first…
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="table-overlay start-panel" role="dialog" aria-label="Rock, paper, scissors">
      <strong>Rock, paper, scissors</strong>
      <span className="muted">The winner chooses to go first or second.</span>
      {start.last && (
        <>
          {thrown(start.last)}
          <span>A tie! Pick again.</span>
        </>
      )}
      {start.yours === null ? (
        <>
          <div className="row rps-picks">
            {HANDS.map((h) => (
              <button key={h} disabled={!can} onClick={() => send({ type: 'rps', hand: h })}>
                <span className="rps-icon">{icon[h]}</span>
                {label(h)}
              </button>
            ))}
          </div>
          <span className="muted small">{start.theirsIn ? `${foeName} has picked.` : `${foeName} hasn't picked yet.`}</span>
        </>
      ) : (
        <span className="judging" role="status">
          <span className="dot" /> You picked {label(start.yours)}. Waiting for {foeName}…
        </span>
      )}
    </div>
  );
}
