import type { ReplayControls, ReplayFrom } from './useReplay.ts';

const SPEEDS = [0.5, 1, 2, 4];

/** The replay's controls: whose view, a seek bar marked at each turn, and play, step and jump buttons. */
export function ReplayBar({ controls: c, names }: { controls: ReplayControls; names: [string, string] }) {
  const views: [ReplayFrom, string][] = [
    [0, names[0]],
    [1, names[1]],
    ['both', 'Both'],
  ];
  const last = c.count - 1;
  const turn = c.turnStarts.filter((i) => i <= c.at).length;
  return (
    <div className="replay-bar" data-area="chat">
      <div className="replay-from" role="radiogroup" aria-label="Watch from">
        <span className="muted small">Watch from</span>
        {views.map(([from, label]) => (
          <button key={from} role="radio" aria-checked={c.from === from} className={c.from === from ? 'primary' : 'quiet'} onClick={() => c.setFrom(from)}>
            {label}
          </button>
        ))}
      </div>
      <div className="replay-seek">
        <input type="range" min={0} max={last} value={c.at} onChange={(e) => c.seek(Number(e.target.value))} aria-label="Seek" list="replay-turns" />
        <datalist id="replay-turns">
          {c.turnStarts.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
        <span className="muted small">
          {turn > 0 ? `Turn ${turn} · ` : ''}step {c.at} of {last}
        </span>
      </div>
      <div className="replay-buttons row">
        <button className="quiet" onClick={() => c.turn(-1)} disabled={c.at === 0} title="Previous turn" aria-label="Previous turn">
          ⏮
        </button>
        <button className="quiet" onClick={() => c.step(-1)} disabled={c.at === 0} title="Step back" aria-label="Step back">
          ◀
        </button>
        <button className="primary" onClick={c.toggle} aria-label={c.playing ? 'Pause' : 'Play'}>
          {c.playing ? 'Pause' : c.at === last ? 'Play again' : 'Play'}
        </button>
        <button className="quiet" onClick={() => c.step(1)} disabled={c.at === last} title="Step forward" aria-label="Step forward">
          ▶
        </button>
        <button className="quiet" onClick={() => c.turn(1)} disabled={c.at === last} title="Next turn" aria-label="Next turn">
          ⏭
        </button>
        <select value={c.speed} onChange={(e) => c.setSpeed(Number(e.target.value))} aria-label="Speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
