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
    sheets: start.sheets,
    players: [player(start.players[0]), player(start.players[1])],
    turn: 0,
    turnPlayer: start.first,
    phase: 'draw',
    normalSummons: 0,
    normalSummonLimit: 1,
    modifiers: [],
    chain: [],
    usedThisTurn: [],
    rulings: [],
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
      case 'judged': {
        const r = event.record;
        // A failed call isn't a ruling, so the player may try again. A legal activation changes the board anyway.
        if (r.stage === 'activation' && !r.legal && r.error === null) {
          s.rulings.push({ player: r.player, card: r.card, effect: r.effect, legal: false, summary: r.summary });
        }
        return;
      }
      case 'appealed': {
        // An overturned refusal binds the next try on this board: the judge must rule it legal.
        const { verdict, decision: d, ruling } = event.appeal;
        if (verdict !== 'overturned' || d.stage !== 'activation' || d.legal) return;
        const standing = s.rulings.find((r) => !r.legal && r.player === d.player && r.card === d.card && r.effect === d.effect);
        if (standing) Object.assign(standing, { legal: true, summary: ruling });
        return;
      }
    }
    // Every other event changes the board, so earlier rulings no longer apply to it.
    if (s.rulings.length > 0) s.rulings = [];
    switch (event.type) {
      case 'turnStarted':
        s.turn = event.turn;
        s.turnPlayer = event.player;
        s.normalSummons = 0;
        s.normalSummonLimit = 1;
        s.usedThisTurn = [];
        s.modifiers = s.modifiers.filter((m) => m.until !== 'end_of_turn');
        return;
      case 'phaseChanged':
        s.phase = event.phase;
        s.modifiers = s.modifiers.filter(
          (m) =>
            !(m.until === 'end_of_battle_phase' && event.phase !== 'battle') &&
            !(m.until === 'next_standby_phase' && event.phase === 'standby' && m.player === s.turnPlayer && m.turn < s.turn),
        );
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
        s.normalSummons++;
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
      case 'effectActivated': {
        const p = s.players[event.player];
        if (event.zone !== null) {
          take(p.hand, event.card);
          p.spellTraps[event.zone] = { ...fieldCard(event.card, s.turn, true), position: 'attack' };
        } else {
          const at = locate(s, event.card);
          if (at?.zone === 'spellTraps') onField(s, event.card).faceUp = true;
        }
        s.chain.push({ player: event.player, card: event.card, effect: event.effect, targets: [], choice: null });
        s.usedThisTurn.push({ card: event.card, code: s.instances[event.card]!.code, effect: event.effect });
        return;
      }
      case 'targeted':
        s.chain.at(-1)!.targets = event.cards;
        return;
      case 'effectChosen':
        s.chain.at(-1)!.choice = event.choice;
        return;
      case 'moved': {
        removeFromPlay(s, event.card);
        const owner = s.players[event.owner];
        const card = s.cards[s.instances[event.card]!.code]!;
        if (card.extraDeck && event.to !== 'graveyard' && event.to !== 'banished') owner.extra.push(event.card);
        else if (event.to === 'hand') owner.hand.push(event.card);
        else if (event.to === 'deck_top') owner.deck.unshift(event.card);
        else if (event.to === 'deck_bottom' || event.to === 'deck_shuffled') owner.deck.push(event.card);
        else owner[event.to === 'graveyard' ? 'graveyard' : 'banished'].push(event.card);
        return;
      }
      case 'deckShuffled': {
        const p = s.players[event.player];
        if (event.order.length !== p.deck.length || !event.order.every((id) => p.deck.includes(id))) {
          throw new Error('A shuffle must keep the same cards');
        }
        p.deck = [...event.order];
        return;
      }
      case 'specialSummoned': {
        removeFromPlay(s, event.card);
        s.players[event.player].monsters[event.zone] = { ...fieldCard(event.card, s.turn, true), position: event.position };
        return;
      }
      case 'destroyed':
        for (const id of event.cards) sendToGraveyard(s, id);
        return;
      case 'lpChanged': {
        const p = s.players[event.player];
        p.lp = Math.max(0, p.lp + event.amount);
        return;
      }
      case 'statsModified':
        s.modifiers.push(event.modifier);
        return;
      case 'normalSummonGranted':
        s.normalSummonLimit++;
        return;
      case 'linkResolved': {
        const link = s.chain.pop();
        if (!link) throw new Error('No chain link to resolve');
        const at = locate(s, link.card);
        const card = s.cards[s.instances[link.card]!.code]!;
        const leaves = card.kind === 'spell' ? ['Normal', 'Quick-Play', 'Ritual'] : card.kind === 'trap' ? ['Normal', 'Counter'] : [];
        if (at?.zone === 'spellTraps' && leaves.includes(card.race)) sendToGraveyard(s, link.card);
        return;
      }
      case 'duelEnded':
        s.result = event.result;
        return;
    }
  });
}

/** A face-up monster's ATK, DEF and Level after modifiers. Level modifiers apply in order; a set Level overrides earlier ones. */
export function statsOf(state: DuelState, id: string): { atk: number; def: number; level: number | null } {
  const card = state.cards[state.instances[id]!.code]!;
  let atk = card.atk ?? 0;
  let def = card.def ?? 0;
  let level = card.level;
  for (const m of state.modifiers) {
    if (m.card !== id) continue;
    atk += m.atk;
    def += m.def;
    if (m.levelSet !== null) level = m.levelSet;
    if (level !== null) level = Math.max(1, level + m.levelDelta);
  }
  return { atk: Math.max(0, atk), def: Math.max(0, def), level };
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

/** Takes a card out of wherever it is. A card leaving the field loses its modifiers. */
function removeFromPlay(state: DuelState, id: string) {
  const at = locate(state, id);
  if (!at) throw new Error(`Unknown card ${id}`);
  const p = state.players[at.seat];
  if (at.zone === 'monsters' || at.zone === 'spellTraps') {
    p[at.zone][at.index] = null;
    state.modifiers = state.modifiers.filter((m) => m.card !== id);
  } else take(p[at.zone], id);
}

/** Cards always go to their owner's Graveyard. */
function sendToGraveyard(state: DuelState, id: string) {
  removeFromPlay(state, id);
  state.players[state.instances[id]!.owner].graveyard.push(id);
}
