import type { PromptView, Seat } from '@yugioh/engine';
import { createContext, useContext, useState } from 'react';
import { dropKey } from './Field.tsx';

/** The piles a question's cards can sit in, besides the field and your hand. */
export type PileKind = 'graveyard' | 'banished' | 'extra' | 'deck';
export const pileKey = (seat: Seat, place: PileKind) => `${seat}:${place}`;

type Option = PromptView['cards'][number];

/** The slot of the card at this place in a hand the player can't see. */
export const handSlot = (seat: Seat, index: number) => `${seat}:hand:${index}`;

/**
 * Where an option shows on the board. A card on the field is found by its zone (`dropKey`), and a card in a hand the
 * player can't see by its place there, since a card they can't see has no ID; any other card by its ID.
 */
const slotOf = (o: Option) =>
  o.zone === null ? null : o.place === 'hand' ? handSlot(o.seat, o.zone) : dropKey(o.seat, o.place === 'monsters' ? 'm' : 's', o.zone);
const pileOf = (o: Option): string | null => (o.zone === null && o.place !== 'hand' && o.place !== 'materials' ? pileKey(o.seat, o.place as PileKind) : null);

/**
 * The judge's question being answered on the board: its cards glow where they are and are picked by clicking them
 * there; the rest of the board dims. Options inside a pile mark the pile, and its viewer shows them.
 */
export interface BoardChoice {
  prompt: PromptView;
  picks: string[];
  /** How the card at `slot` (on the field) or with this ID (anywhere else) stands in the question. */
  state(id: string | null, slot?: string): 'pickable' | 'picked' | null;
  /** Picks or unpicks that card, or one of the choices that aren't cards. */
  toggle(id: string | null, slot?: string): void;
  /** The options inside a pile (`pileKey`). */
  inPile(key: string): Option[];
  /** The one pile holding every option, which opens by itself; null when any option is elsewhere. */
  onlyPile: string | null;
  /** Whether the picks are a whole answer. */
  complete: boolean;
  clear(): void;
}

/** The answer in progress to `prompt`, which starts over with each new question. */
export function useBoardChoice(prompt: PromptView | null): BoardChoice | null {
  const [state, setState] = useState<{ id: string; picks: string[] } | null>(null);
  if (!prompt) return null;
  const picks = state?.id === prompt.id ? state.picks : [];
  const setPicks = (next: string[]) => setState({ id: prompt.id, picks: next });

  const find = (id: string | null, slot?: string) =>
    prompt.cards.find((o) => (slot !== undefined && slotOf(o) !== null ? slotOf(o) === slot : o.zone === null && o.pick === id));
  const piles = prompt.cards.map(pileOf);
  const onlyPile = piles.length > 0 && piles.every((p) => p !== null && p === piles[0]) ? piles[0]! : null;

  return {
    prompt,
    picks,
    state: (id, slot) => {
      const o = find(id, slot);
      return o ? (picks.includes(o.pick) ? 'picked' : 'pickable') : null;
    },
    toggle: (id, slot) => {
      const pick = find(id, slot)?.pick ?? (id !== null && prompt.choices.includes(id) ? id : null);
      if (pick !== null) setPicks(togglePick(picks, pick, prompt.max));
    },
    inPile: (key) => prompt.cards.filter((o) => pileOf(o) === key),
    onlyPile,
    complete: picks.length >= prompt.min && picks.length <= prompt.max,
    clear: () => setPicks([]),
  };
}

/** Picking toggles; with one to choose a new pick replaces the old, otherwise picks stop at the most allowed. */
function togglePick(picks: string[], pick: string, max: number) {
  if (picks.includes(pick)) return picks.filter((p) => p !== pick);
  if (max === 1) return [pick];
  return picks.length < max ? [...picks, pick] : picks;
}

const ChoiceContext = createContext<BoardChoice | null>(null);
export const ChoiceProvider = ChoiceContext.Provider;
export const useChoice = () => useContext(ChoiceContext);

/**
 * The question's instruction, in the middle strip and atop an open pile: what to choose, how many are picked, the
 * choices that aren't cards, and Confirm (a question of which zone is answered by clicking the zone). The duel waits for the answer, so there is no Cancel; Clear takes back
 * the picks.
 */
export function ChoiceBar({ choice, onConfirm, pending, error }: { choice: BoardChoice; onConfirm: () => void; pending: boolean; error: string | null }) {
  const { prompt, picks } = choice;
  const count = prompt.min === prompt.max ? `${prompt.max}` : prompt.min === 0 ? `up to ${prompt.max}` : `${prompt.min} to ${prompt.max}`;
  // Which zone a monster goes to: clicking one of the lit zones answers it.
  if (prompt.zones.length > 0) {
    return (
      <span className="choice-prompt judge-choice" role="group" aria-label={prompt.text}>
        <span className="choice-text">{prompt.text}</span>
        {error && <span className="error">{error}</span>}
      </span>
    );
  }
  return (
    <span className="choice-prompt judge-choice" role="group" aria-label={prompt.text}>
      <span className="choice-text">
        {prompt.text}
        {prompt.cards.length > 0 && (
          <span className="muted">
            {' '}
            · {picks.length} of {count} chosen
          </span>
        )}
      </span>
      {prompt.choices.length > 0 && (
        <span className="pick-choices">
          {prompt.choices.map((c) => (
            <button key={c} className={picks.includes(c) ? 'picked' : ''} aria-pressed={picks.includes(c)} onClick={() => choice.toggle(c)}>
              {c}
            </button>
          ))}
        </span>
      )}
      {error && <span className="error">{error}</span>}
      {picks.length > 0 && prompt.cards.length > 0 && (
        <button className="quiet" onClick={choice.clear}>
          Clear
        </button>
      )}
      <button className="primary" disabled={!choice.complete || pending} onClick={onConfirm}>
        Confirm
      </button>
    </span>
  );
}
