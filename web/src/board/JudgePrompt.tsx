import type { Place, PromptView } from '@yugioh/engine';
import { useState } from 'react';
import { CardFace } from './Card.tsx';
import { useCardHover } from './CardTooltip.tsx';

const placeName: Record<Place, string> = {
  deck: 'Deck',
  hand: 'Hand',
  monsters: 'Field',
  spellTraps: 'Field',
  graveyard: 'GY',
  banished: 'Banished',
  extra: 'Extra Deck',
};

/**
 * A question from the judge (`ask_player`): pick cards or choices, between `min` and `max` of them. It can be tucked
 * away to look at the board, but the duel waits for the answer.
 */
export function JudgePrompt({ prompt, onAnswer, pending, error }: { prompt: PromptView; onAnswer: (picks: string[]) => void; pending: boolean; error: string | null }) {
  const [picks, setPicks] = useState<string[]>([]);
  const [tucked, setTucked] = useState(false);
  const hover = useCardHover();
  const toggle = (id: string) =>
    setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : prompt.max === 1 ? [id] : p.length < prompt.max ? [...p, id] : p));
  const ok = picks.length >= prompt.min && picks.length <= prompt.max;
  const count = prompt.min === prompt.max ? `${prompt.min}` : `${prompt.min} to ${prompt.max}`;

  if (tucked) {
    return (
      <button className="prompt-tab" onClick={() => setTucked(false)}>
        The judge is asking you something: answer
      </button>
    );
  }
  return (
    <div className="sheet-backdrop">
      <div className="sheet judge-prompt" role="dialog" aria-label={prompt.text}>
        <div className="row">
          <h3>{prompt.text}</h3>
          <span className="muted">Choose {count}</span>
          <span className="spacer" />
          <button className="quiet" onClick={() => setTucked(true)}>
            See the board
          </button>
        </div>
        {prompt.cards.length > 0 && (
          <div className="sheet-grid">
            {prompt.cards.map((c) => (
              <button
                key={c.id}
                className={`pick-card${picks.includes(c.id) ? ' picked' : ''}`}
                aria-pressed={picks.includes(c.id)}
                onClick={() => toggle(c.id)}
                {...hover(c.card)}
              >
                <CardFace card={c.card} size="full" />
                <span className="pick-place">{placeName[c.place]}</span>
              </button>
            ))}
          </div>
        )}
        {prompt.choices.length > 0 && (
          <div className="pick-choices">
            {prompt.choices.map((c) => (
              <button key={c} className={picks.includes(c) ? 'picked' : ''} aria-pressed={picks.includes(c)} onClick={() => toggle(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="row">
          {error && <p className="error">{error}</p>}
          <span className="spacer" />
          <button disabled={!ok || pending} onClick={() => onAnswer(picks)}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
