import type { DuelOutcome, DuelPlayer, DuelStatus, DuelSummary, GamePreview } from '@yugioh/shared';
import { Link } from 'react-router';
import { CopyLink } from './CopyLink.tsx';
import { moveText } from './duelFeed.tsx';
import { MiniBoard } from './MiniBoard.tsx';
import { formatDate } from './pages/Home.tsx';

const statusText: Record<DuelStatus, string> = { waiting: 'Waiting', preparing: 'Choosing decks', active: 'Live', finished: 'Finished' };

/**
 * One duel at a glance: both players with their decks beneath, the winner marked, and how it ended. The card opens the
 * duel (or its replay, once finished); its share button copies the link anyone can open to watch it.
 */
export function DuelCard({ duel, preview }: { duel: DuelSummary; preview?: GamePreview }) {
  const [a, b] = duel.players;
  const winner = duel.result?.winner ?? null;
  const finished = duel.status === 'finished';
  const path = finished ? `/duel/${duel.id}/replay` : `/duel/${duel.id}`;
  const challenge = duel.yourSeat === 0 ? 'Your challenge' : `${a.name}'s challenge`;
  return (
    <article className={`duel-card ${duel.status}`}>
      <div className="duel-card-players">
        <Side player={a} won={winner === 0} lost={winner === 1} you={duel.yourSeat === 0} />
        <span className="vs" aria-hidden>
          vs
        </span>
        {b ? <Side player={b} won={winner === 1} lost={winner === 0} you={duel.yourSeat === 1} /> : <OpenSeat />}
      </div>
      {preview && <MiniBoard preview={preview} />}
      <p className="duel-card-how">
        {duel.result ? (
          <strong>{outcomeText(duel.result, duel.players, duel.yourSeat)}</strong>
        ) : duel.yourMove ? (
          <span className="pill needs-you">{moveText[duel.yourMove]}</span>
        ) : (
          <span className={`pill ${duel.status}`}>{statusText[duel.status]}</span>
        )}
        <span className="muted">
          {challenge} · {formatDate(duel.finishedAt ?? duel.createdAt)}
        </span>
      </p>
      <div className="duel-card-actions">
        {(duel.status === 'active' || finished) && <CopyLink path={path} label="Share" />}
        <Link className="duel-card-open" to={path} aria-label={`${finished ? 'Watch the replay of' : 'Open'} ${a.name} vs ${b?.name ?? 'an open seat'}`}>
          {openLabel(duel)}
        </Link>
      </div>
    </article>
  );
}

function openLabel(duel: DuelSummary): string {
  if (duel.status === 'finished') return 'Replay';
  if (duel.yourSeat === null) return duel.canJoin ? 'Sit down' : 'Watch';
  return duel.status === 'active' ? 'Play' : 'Open';
}

function Side({ player, won, lost, you }: { player: DuelPlayer; won: boolean; lost: boolean; you: boolean }) {
  return (
    <div className={`duel-side${won ? ' won' : ''}${lost ? ' lost' : ''}`}>
      <strong className="duel-name">
        {player.name}
        {you && <span className="muted small"> (you)</span>}
        {won && (
          <span className="crown" title="Winner" aria-label="Winner">
            ★
          </span>
        )}
      </strong>
      <span className="duel-deck muted small">{player.deck ?? (player.ready ? 'Ready' : 'Choosing a deck')}</span>
    </div>
  );
}

function OpenSeat() {
  return (
    <div className="duel-side open">
      <strong className="duel-name muted">Open seat</strong>
      <span className="duel-deck muted small">Waiting for an opponent</span>
    </div>
  );
}

/** "You won: D-abco surrendered on turn 6", from the viewer's side when they played. */
export function outcomeText(result: DuelOutcome, players: DuelSummary['players'], yourSeat: 0 | 1 | null): string {
  // A duel can end before its first turn, during rock-paper-scissors.
  const on = result.turn === 0 ? 'before the first turn' : `on turn ${result.turn}`;
  if (result.winner === null) return `Draw: ${result.reason === 'handWin' ? 'both players held a winning hand' : "both players' LP hit 0"} ${on}`;
  const name = (seat: 0 | 1) => (seat === yourSeat ? 'you' : (players[seat]?.name ?? 'the opponent'));
  const loser = result.winner === 0 ? 1 : 0;
  const head = result.winner === yourSeat ? 'You won' : loser === yourSeat ? 'You lost' : `${name(result.winner)} won`;
  const why = {
    lp: `${loser === yourSeat ? 'your' : `${name(loser)}'s`} LP hit 0`,
    deckOut: `${name(loser)} couldn't draw`,
    surrender: `${name(loser)} surrendered`,
    rageQuit: `${name(loser)} flipped the table`,
    handWin: `${name(result.winner)} held every piece of a winning hand`,
  }[result.reason];
  return `${head}: ${why} ${on}`;
}
