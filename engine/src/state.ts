// Folding events into state. Every change to a duel goes through evolve, so replaying the log rebuilds any past board.

import { produce } from 'immer';
import {
  MONSTER_ZONES,
  SPELL_TRAP_ZONES,
  STARTING_LP,
  type DuelEvent,
  type DuelState,
  type FieldCard,
  type PlayerState,
  type Seat,
} from './types.ts';

export const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

export function replay(events: readonly DuelEvent[]): DuelState {
  const [start, ...rest] = events;
  if (start?.type !== 'duelStarted') throw new Error('A duel log must begin with duelStarted');
  return rest.reduce(evolve, initialState(start));
}

function initialState(start: Extract<DuelEvent, { type: 'duelStarted' }>): DuelState {
  const player = (p: (typeof start.players)[number]): PlayerState => ({
    name: p.name,
    lp: STARTING_LP,
    deck: [...p.deck],
    hand: [],
    monsters: Array(MONSTER_ZONES).fill(null),
    spellTraps: Array(SPELL_TRAP_ZONES).fill(null),
    graveyard: [],
    banished: [],
    extra: [...p.extra],
  });
  return {
    instances: start.instances,
    cards: start.cards,
    players: [player(start.players[0]), player(start.players[1])],
    turn: 0,
    turnPlayer: start.first,
    phase: 'draw',
    normalSummonUsed: false,
    result: null,
  };
}

export function evolve(state: DuelState, event: DuelEvent): DuelState {
  return produce(state, (s) => {
    switch (event.type) {
      case 'duelStarted':
        throw new Error('duelStarted can only be the first event');
      case 'intent':
        return;
      case 'turnStarted':
        s.turn = event.turn;
        s.turnPlayer = event.player;
        s.normalSummonUsed = false;
        return;
      case 'phaseChanged':
        s.phase = event.phase;
        return;
      case 'drew': {
        const p = s.players[event.player];
        p.hand.push(...p.deck.splice(0, event.count));
        return;
      }
      case 'tributed':
      case 'destroyedByBattle':
      case 'discarded':
        for (const id of event.cards) sendToGraveyard(s, id);
        return;
      case 'normalSummoned':
      case 'monsterSet': {
        const p = s.players[event.player];
        take(p.hand, event.card);
        p.monsters[event.zone] = fieldCard(event.card, s.turn, event.type === 'normalSummoned');
        s.normalSummonUsed = true;
        return;
      }
      case 'spellTrapSet': {
        const p = s.players[event.player];
        take(p.hand, event.card);
        p.spellTraps[event.zone] = { ...fieldCard(event.card, s.turn, false), position: 'attack' };
        return;
      }
      case 'flipSummoned': {
        const card = onField(s, event.card);
        card.faceUp = true;
        card.position = 'attack';
        card.positionChangedTurn = s.turn;
        return;
      }
      case 'positionChanged': {
        const card = onField(s, event.card);
        card.position = event.position;
        card.positionChangedTurn = s.turn;
        return;
      }
      case 'attackDeclared':
        onField(s, event.attacker).attackedTurn = s.turn;
        return;
      case 'flippedByAttack':
        onField(s, event.card).faceUp = true;
        return;
      case 'battleDamage': {
        const p = s.players[event.player];
        p.lp = Math.max(0, p.lp - event.amount);
        return;
      }
      case 'duelEnded':
        s.result = event.result;
        return;
    }
  });
}

function fieldCard(id: string, turn: number, faceUp: boolean): FieldCard {
  return {
    id,
    position: faceUp ? 'attack' : 'defense',
    faceUp,
    placedTurn: turn,
    positionChangedTurn: null,
    attackedTurn: null,
  };
}

function take(pile: string[], id: string) {
  const i = pile.indexOf(id);
  if (i < 0) throw new Error(`Card ${id} is not where the event says`);
  pile.splice(i, 1);
}

/** Where a card instance is right now. */
export type Location =
  | { seat: Seat; zone: 'monsters' | 'spellTraps'; index: number }
  | { seat: Seat; zone: 'deck' | 'hand' | 'graveyard' | 'banished' | 'extra' };

export function locate(state: DuelState, id: string): Location | null {
  for (const seat of [0, 1] as const) {
    const p = state.players[seat];
    for (const zone of ['monsters', 'spellTraps'] as const) {
      const index = p[zone].findIndex((c) => c?.id === id);
      if (index >= 0) return { seat, zone, index };
    }
    for (const zone of ['hand', 'deck', 'graveyard', 'banished', 'extra'] as const) {
      if (p[zone].includes(id)) return { seat, zone };
    }
  }
  return null;
}

export function onField(state: DuelState, id: string): FieldCard {
  const at = locate(state, id);
  if (at?.zone !== 'monsters' && at?.zone !== 'spellTraps') throw new Error(`Card ${id} is not on the field`);
  return state.players[at.seat][at.zone][at.index]!;
}

/** Cards always go to their owner's Graveyard. */
function sendToGraveyard(state: DuelState, id: string) {
  const at = locate(state, id);
  if (!at) throw new Error(`Unknown card ${id}`);
  const p = state.players[at.seat];
  if (at.zone === 'monsters' || at.zone === 'spellTraps') p[at.zone][at.index] = null;
  else take(p[at.zone], id);
  state.players[state.instances[id]!.owner].graveyard.push(id);
}
