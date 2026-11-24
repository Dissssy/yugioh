import type { GamePreview, PreviewCard, PreviewSide } from '@yugioh/shared';
import { imageUrl } from './board/Card.tsx';

/**
 * A duel being played, small, for the open games (docs/discord.md): both fields as a spectator sees them, the first
 * player at the bottom, with LP and hand sizes. Face-down cards show their backs; defense position lies sideways.
 */
export function MiniBoard({ preview }: { preview: GamePreview }) {
  const [bottom, top] = preview.players;
  // Across the table, the top player's zones run the other way, as on the full board.
  const across = <T,>(zones: T[]) => [...zones].reverse();
  // The Extra Monster Zones are shared: whoever controls a card there, it sits between the two fields.
  const extra = [bottom.monsters[5] ?? top.monsters[6] ?? null, bottom.monsters[6] ?? top.monsters[5] ?? null];
  return (
    <div className="mini-board" aria-label={`${top.name} ${top.lp} LP, ${bottom.name} ${bottom.lp} LP, turn ${preview.turn}`}>
      <Score side={top} active={preview.turnPlayer === 1} />
      <div className="mini-field">
        <Row cards={[null, ...across(top.spellTraps.slice(0, 5)), top.spellTraps[5] ?? null]} />
        <Row cards={[null, ...across(top.monsters.slice(0, 5)), null]} />
        <Row cards={[null, null, extra[0] ?? null, null, extra[1] ?? null, null, null]} extra />
        <Row cards={[null, ...bottom.monsters.slice(0, 5), null]} />
        <Row cards={[bottom.spellTraps[5] ?? null, ...bottom.spellTraps.slice(0, 5), null]} />
      </div>
      <Score side={bottom} active={preview.turnPlayer === 0} />
    </div>
  );
}

function Score({ side, active }: { side: PreviewSide; active: boolean }) {
  return (
    <p className={`mini-score small${active ? ' active' : ''}`}>
      <span className="mini-name">{side.name}</span> <strong>{side.lp}</strong> <span className="muted">· {side.hand} in hand</span>
    </p>
  );
}

function Row({ cards, extra = false }: { cards: (PreviewCard | null)[]; extra?: boolean }) {
  return (
    <div className={`mini-row${extra ? ' extra' : ''}`}>
      {cards.map((c, i) => (
        <span key={i} className={`mini-zone${c?.defense ? ' defense' : ''}`}>
          {c && (c.code === null ? <span className="card back" /> : <img src={imageUrl(c.code, 'small')} alt="" loading="lazy" />)}
        </span>
      ))}
    </div>
  );
}
