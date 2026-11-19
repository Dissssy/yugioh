import type { Place, PromptView, Seat } from '@yugioh/engine';
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

/** Where an option is: "Your Field, zone 2" for a card on the field, else the place's name. */
function where(c: PromptView['cards'][number], you: Seat) {
  if (c.zone === null) return placeName[c.place];
  return `${c.seat === you ? 'Your' : "Opponent's"} ${c.place === 'monsters' ? 'Monster' : 'Spell & Trap'} Zone ${c.zone + 1}`;
}

/**
 * A question from the judge (`ask_player`): pick cards or choices, between `min` and `max` of them. It can be tucked
 * away to look at the board, but the duel waits for the answer.
 */
export function JudgePrompt({
  prompt,
  you,
  onAnswer,
  pending,
  error,
}: {
  prompt: PromptView;
  you: Seat;
  onAnswer: (picks: string[]) => void;
  pending: boolean;
  error: string | null;
}) {
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
            {prompt.cards.map((c) => {
              const card = 'hidden' in c.card ? null : c.card.card;
              return (
                <button
                  key={c.pick}
                  className={`pick-card${picks.includes(c.pick) ? ' picked' : ''}`}
                  aria-pressed={picks.includes(c.pick)}
                  onClick={() => toggle(c.pick)}
                  {...hover(card)}
                >
                  <CardFace card={card} size="full" />
                  <span className="pick-place">{where(c, you)}</span>
                </button>
              );
            })}
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
