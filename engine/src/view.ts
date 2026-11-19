// What each player is allowed to see. Hidden cards are sent without an ID or card data, so nothing leaks to the browser.

import { legalActions } from './rules.ts';
import { evolve, locate, replay } from './state.ts';
import type { CardView, DuelEvent, DuelState, FieldCard, FieldCardView, LogEntry, LogEvent, Phase, PlayerView, Seat } from './types.ts';

export function viewFor(state: DuelState, seat: Seat): PlayerView {
  const shown = (id: string): CardView => ({ id, card: state.cards[state.instances[id]!.code]! });
  const hidden: CardView = { hidden: true };
  const field = (owner: Seat) => (c: FieldCard | null): FieldCardView | null =>
    c && {
      card: c.faceUp || owner === seat ? shown(c.id) : hidden,
      position: c.position,
      faceUp: c.faceUp,
    };
  const deckList = [
    ...new Set(Object.values(state.instances).filter((i) => i.owner === seat).map((i) => i.code)),
  ].sort((a, b) => a - b);

  return {
    you: seat,
    deckList,
    turn: state.turn,
    turnPlayer: state.turnPlayer,
    phase: state.phase,
    normalSummonUsed: state.normalSummonUsed,
    result: state.result,
    players: ([0, 1] as const).map((owner) => {
      const p = state.players[owner];
      const mine = owner === seat;
      return {
        name: p.name,
        lp: p.lp,
        deckCount: p.deck.length,
        hand: p.hand.map((id) => (mine ? shown(id) : hidden)),
        monsters: p.monsters.map(field(owner)),
        spellTraps: p.spellTraps.map(field(owner)),
        graveyard: p.graveyard.map(shown),
        banished: p.banished.map(shown),
        extra: p.extra.map((id) => (mine ? shown(id) : hidden)),
      };
    }) as PlayerView['players'],
    actions: legalActions(state, seat),
  };
}

/** The whole duel log as one player sees it. */
export function logFor(events: readonly DuelEvent[], seat: Seat): LogEntry[] {
  let state = replay(events.slice(0, 1));
  return events.flatMap((event, seq) => {
    if (seq > 0) state = evolve(state, event);
    const entry = entryFor(state, event, seq, state.turn, seat);
    return entry ? [entry] : [];
  });
}

/** One event as a log entry for one player, or null for events players never see. `state` is the state right after the event. */
export function entryFor(state: DuelState, event: DuelEvent, seq: number, turn: number, seat: Seat): LogEntry | null {
  const visible = visibleEvent(state, event, seat);
  return visible && { seq, turn, event: visible, text: describe(state, visible) };
}

function visibleEvent(state: DuelState, event: DuelEvent, seat: Seat): LogEvent | null {
  switch (event.type) {
    case 'duelStarted':
    case 'intent':
      return null;
    case 'monsterSet':
    case 'spellTrapSet':
      return event.player === seat ? event : { ...event, card: null };
    case 'attackDeclared': {
      const at = event.target === null ? null : locate(state, event.target);
      return { ...event, targetZone: at?.zone === 'monsters' ? at.index : null };
    }
    default:
      return event;
  }
}

const phaseNames: Record<Phase, string> = {
  draw: 'Draw Phase',
  standby: 'Standby Phase',
  main1: 'Main Phase 1',
  battle: 'Battle Phase',
  main2: 'Main Phase 2',
  end: 'End Phase',
};

/** One line for the duel log, written so it reveals nothing hidden from either player. */
function describe(state: DuelState, event: LogEvent): string | null {
  const who = (seat: Seat) => state.players[seat].name;
  const name = (id: string) => state.cards[state.instances[id]!.code]!.name;
  const names = (ids: string[]) => ids.map(name).join(', ');
  switch (event.type) {
    case 'turnStarted':
      return `Turn ${event.turn}: ${who(event.player)}`;
    case 'phaseChanged':
      return event.phase === 'battle' || event.phase === 'main2' ? phaseNames[event.phase] : null;
    case 'drew':
      return `${who(event.player)} drew ${event.count === 1 ? 'a card' : `${event.count} cards`}`;
    case 'tributed':
      return `${who(event.player)} tributed ${names(event.cards)}`;
    case 'normalSummoned':
      return `${who(event.player)} Normal Summoned ${name(event.card)}`;
    case 'monsterSet':
      return `${who(event.player)} Set a monster`;
    case 'spellTrapSet':
      return `${who(event.player)} Set a Spell or Trap`;
    case 'flipSummoned':
      return `${who(event.player)} Flip Summoned ${name(event.card)}`;
    case 'positionChanged':
      return `${who(event.player)} changed ${name(event.card)} to ${event.position} position`;
    case 'attackDeclared':
      // A face-down target is flipped by the very next event, so naming it here reveals nothing early.
      return `${name(event.attacker)} attacked ${event.target ? name(event.target) : 'directly'}`;
    case 'battleDamage':
      return `${who(event.player)} took ${event.amount} damage`;
    case 'destroyedByBattle':
      return `${names(event.cards)} destroyed by battle`;
    case 'discarded':
      return `${who(event.player)} discarded ${names(event.cards)}`;
    case 'duelEnded': {
      const { winner, reason } = event.result;
      if (winner === null) return 'The duel ended in a draw';
      const loser = who(winner === 0 ? 1 : 0);
      const why = { lp: `${loser}'s LP reached 0`, deckOut: `${loser} couldn't draw`, surrender: `${loser} surrendered` }[reason];
      return `${who(winner)} won: ${why}`;
    }
    case 'flippedByAttack':
      return null;
  }
}
