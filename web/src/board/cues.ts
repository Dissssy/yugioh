// How long each event is shown, and the animations that aren't simply a card moving between zones.
// Cards that keep their ID glide between zones by themselves (Motion layoutId); everything here is extra:
// cards arriving from somewhere hidden, summon impacts, Sets turning over, attacks, flips and hits.

import type { LogEntry, LogEvent, PlayerView, Seat } from '@yugioh/engine';
import { animate } from 'motion';
import type { DuelSettings } from './settings.ts';
import { idOf } from './Card.tsx';

const baseMs: Record<LogEvent['type'], number> = {
  // Long enough to see both picks before the next round or the winner's choice.
  rpsShown: 1200,
  orderChosen: 600,
  turnStarted: 1000,
  phaseChanged: 250,
  drew: 450,
  tributed: 450,
  normalSummoned: 550,
  extraSummoned: 700,
  monsterSet: 400,
  spellTrapSet: 400,
  flipSummoned: 500,
  flipped: 450,
  positionChanged: 400,
  attackDeclared: 550,
  battleDamage: 650,
  destroyedByBattle: 500,
  discarded: 450,
  duelEnded: 300,
  // Card effects
  judged: 300,
  appealed: 300,
  effectActivated: 600,
  procedureUsed: 0,
  protectionUsed: 300,
  banishWhenLeaves: 0,
  targeted: 400,
  effectChosen: 0,
  moved: 450,
  specialSummoned: 550,
  tokenSummoned: 550,
  controlChanged: 550,
  destroyed: 500,
  lpChanged: 650,
  statsModified: 400,
  normalSummonGranted: 300,
  forbidden: 300,
  linked: 400,
  activationNegated: 500,
  effectsNegated: 300,
  setAgain: 0,
  countersChanged: 300,
  damageStepStarted: 0,
  replacementOffered: 0,
  replacementChosen: 300,
  taxDemanded: 0,
  pledged: 0,
  locked: 0,
  substituted: 0,
  taxAnswered: 300,
  rollbackOffered: 0,
  rollbackAnswered: 0,
  rolledBack: 600,
  linkResolved: 200,
  chatted: 0,
  asked: 0,
  escalated: 0,
};

/** Phases nobody acts in pass almost instantly. */
const quietPhase = (event: LogEvent) => event.type === 'phaseChanged' && event.phase !== 'battle' && event.phase !== 'main2';

/**
 * How long to hold an event. A burst (such as everything the opponent did before passing the turn) plays faster
 * the more steps are still waiting, so catching up never takes long.
 */
export function cueMs(event: LogEvent, waiting: number, settings: DuelSettings, reduceMotion: boolean): number {
  let ms = quietPhase(event) ? 120 : baseMs[event.type];
  if (settings.speed === 'fast') ms *= 0.5;
  if (waiting > 3) ms *= 0.5;
  else if (waiting > 0) ms *= 0.75;
  return reduceMotion ? Math.min(ms, 300) : ms;
}

const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

/** Plays the extra animation for one step, on the board's DOM. `ms` is how long the step is held. */
export function playCue(root: HTMLElement, cue: LogEntry, prev: PlayerView | null, view: PlayerView, ms: number) {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector);
  const s = (ms / 1000) * 0.85;
  const e = cue.event;

  const centre = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  /** Animates `el` from where `from` is to where it is now. */
  const flyFrom = (el: HTMLElement | null, from: HTMLElement | null, flipIn = false) => {
    if (!el || !from) return;
    const a = centre(from);
    const b = centre(el);
    void animate(
      el,
      { x: [a.x - b.x, 0], y: [a.y - b.y, 0], scale: [0.8, 1], ...(flipIn ? { rotateY: [90, 0] } : {}) },
      { duration: s * 0.8, ease: 'easeOut' },
    );
  };
  const slot = (seat: Seat, row: 'm' | 's', zone: number) => q(`[data-slot="${seat}:${row}:${zone}"]`);
  const card = (id: string | null) => (id ? q(`[data-card-id="${id}"]`) : null);
  const hand = (seat: Seat) => q(`[data-hand="${seat}"]`);
  /** A brightness pulse, which leaves no filter behind once it is over. */
  const glow = (el: HTMLElement, keyframes: Parameters<typeof animate>[1], options: Parameters<typeof animate>[2]) =>
    void animate(el, keyframes, options).then(() => (el.style.filter = ''));
  const flash = (el: HTMLElement | null) => el && glow(el, { scale: [1.15, 1], filter: ['brightness(1.8)', 'brightness(1)'] }, { duration: s * 0.6 });
  const shake = () => {
    const table = q('.table');
    if (table) void animate(table, { x: [0, -6, 6, -4, 4, 0] }, { duration: Math.min(0.35, s) });
  };

  switch (e.type) {
    case 'drew': {
      const deck = q(`[data-pile="${e.player}:deck"]`);
      const before = prev?.players[e.player].hand ?? [];
      const after = view.players[e.player].hand;
      const known = new Set(before.map(idOf));
      after.forEach((c, i) => {
        // Your cards are found by ID (you may have reordered them); the opponent's backs by position.
        const id = idOf(c);
        if (id ? !known.has(id) : i >= before.length) {
          flyFrom(id ? card(id) : q(`[data-hand-index="${e.player}:${i}"]`), deck, id !== null);
        }
      });
      return;
    }
    case 'normalSummoned':
    case 'monsterSet':
    case 'spellTrapSet': {
      const el = slot(e.player, e.type === 'spellTrapSet' ? 's' : 'm', e.zone);
      // Your own cards glide from your hand by themselves; the opponent's come from a hidden hand card.
      if (e.player !== view.you) flyFrom(el, hand(e.player));
      // A Set card turns face-down as it lands, and a Set monster turns sideways into Defense Position.
      if (e.type !== 'normalSummoned' && el) {
        void animate(el, { rotateY: [90, 0], ...(e.type === 'monsterSet' ? { rotate: [-90, 0] } : {}) }, { duration: s * 0.7, ease: 'easeOut' });
      }
      if (e.type === 'normalSummoned' && el) {
        void animate(el, { scale: [1.35, 1] }, { duration: s * 0.6, ease: 'easeIn', delay: e.player === view.you ? s * 0.3 : s * 0.5 });
        const zone = el.closest<HTMLElement>('.zone');
        zone?.classList.remove('summoned');
        void zone?.offsetWidth; // restart the CSS animation
        zone?.classList.add('summoned');
      }
      return;
    }
    case 'flipSummoned':
    case 'flipped': {
      const el = card(e.card);
      if (el) void animate(el, { rotateY: [90, 0] }, { duration: s * 0.7, ease: 'easeOut' });
      return;
    }
    case 'attackDeclared': {
      const attacker = card(e.attacker);
      const target = e.targetZone === null ? q(`[data-lp="${other(e.player)}"]`) : slot(other(e.player), 'm', e.targetZone);
      if (!attacker || !target) return;
      const a = centre(attacker);
      const b = centre(target);
      attacker.style.zIndex = '5';
      void animate(
        attacker,
        { x: [0, (b.x - a.x) * 0.6, 0], y: [0, (b.y - a.y) * 0.6, 0], scale: [1, 1.12, 1] },
        { duration: s, times: [0, 0.55, 1], ease: 'easeInOut' },
      ).then(() => (attacker.style.zIndex = ''));
      return;
    }
    case 'battleDamage':
      shake();
      return;
    case 'effectActivated': {
      const el = card(e.card) ?? (e.zone !== null ? slot(e.player, 's', e.zone) : null);
      // The opponent's card from the hand arrives from their hidden hand; a Set card turns face-up.
      if (e.zone !== null && e.player !== view.you) flyFrom(slot(e.player, 's', e.zone), hand(e.player));
      const wasSet = prev?.players[e.player].spellTraps.some((z) => z && idOf(z.card) === e.card && !z.faceUp);
      if (wasSet && el) void animate(el, { rotateY: [90, 0] }, { duration: s * 0.5, ease: 'easeOut' });
      if (el) glow(el, { filter: ['brightness(1)', 'brightness(1.9)', 'brightness(1)'], scale: [1, 1.12, 1] }, { duration: s, delay: s * 0.2 });
      return;
    }
    case 'targeted':
      for (const id of e.cards) {
        const el = card(id);
        if (el) glow(el, { scale: [1, 1.1, 1], filter: ['brightness(1)', 'brightness(1.6)', 'brightness(1)'] }, { duration: s });
      }
      return;
    case 'specialSummoned':
    case 'tokenSummoned':
    case 'extraSummoned': {
      const el = slot(e.player, 'm', e.zone);
      if (!el) return;
      void animate(el, { scale: [1.4, 1], opacity: [0, 1] }, { duration: s * 0.6, ease: 'easeIn' });
      const zone = el.closest<HTMLElement>('.zone');
      zone?.classList.remove('summoned');
      void zone?.offsetWidth; // restart the CSS animation
      zone?.classList.add('summoned');
      return;
    }
    case 'statsModified':
      flash(card(e.modifier.card));
      return;
    case 'lpChanged':
      if (e.amount < 0 && e.kind === 'damage') shake();
      return;
    case 'moved': {
      // Cards that stay visible glide by themselves; a card drawn by an effect comes off the Deck like a draw.
      if (e.from === 'deck' && e.to === 'hand' && e.card) flyFrom(card(e.card), q(`[data-pile="${e.owner}:deck"]`), true);
      const gy = e.to === 'graveyard' ? q(`[data-pile="${e.owner}:gy"]`) : null;
      if (gy) flash(gy);
      return;
    }
    case 'destroyedByBattle':
    case 'destroyed':
    case 'tributed':
    case 'discarded': {
      const seats = new Set<Seat>(e.type === 'destroyedByBattle' || e.type === 'destroyed' ? [0, 1] : [e.player]);
      for (const seat of seats) {
        const gy = q(`[data-pile="${seat}:gy"]`);
        // A discard from the opponent's hidden hand has nowhere visible to glide from.
        if (e.type === 'discarded' && seat !== view.you) flyFrom(gy, hand(seat));
        if (view.players[seat].graveyard.length !== prev?.players[seat].graveyard.length) flash(gy);
      }
      if (e.type === 'destroyedByBattle' || e.type === 'destroyed') shake();
      return;
    }
    default:
      return;
  }
}
