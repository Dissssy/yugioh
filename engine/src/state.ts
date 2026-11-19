// Folding events into state. Every change to a duel goes through evolve, so replaying the log rebuilds any past board.

import { produce } from 'immer';
import {
  MONSTER_ZONES,
  SPELL_TRAP_ZONES,
  STARTING_LP,
  type CardData,
  type DuelEvent,
  type DuelState,
  type FieldCard,
  type Happening,
  type PlayerState,
  type Seat,
  type SummonKind,
  type Then,
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
    // Set by the first turnStarted, once rock-paper-scissors has decided.
    turnPlayer: 0,
    phase: 'draw',
    normalSummons: 0,
    normalSummonLimit: 1,
    modifiers: [],
    chain: [],
    step: { at: 'rps', picks: [null, null], last: null },
    happened: [],
    resolvedLinks: 0,
    attack: null,
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
      case 'chatted':
        return;
      case 'orderChosen':
        // The opening hands are dealt next, then turn 1 starts.
        s.turnPlayer = event.first;
        s.step = { at: 'open' };
        return;
      case 'rpsPicked':
        if (s.step.at === 'rps') s.step.picks[event.player] = event.hand;
        return;
      case 'rpsShown':
        s.step = event.winner === null ? { at: 'rps', picks: [null, null], last: event.hands } : { at: 'order', chooser: event.winner, hands: event.hands };
        return;
      case 'passed': {
        // Declining changes nothing on the board, so standing rulings stay.
        const step = s.step;
        if (step.at === 'triggers') step.passed.push(event.player);
        else if (step.at === 'respond') {
          if (!step.passed) Object.assign(step, { passed: true, priority: other(step.priority) });
          // Two passes in a row: the chain resolves, or the sequence is over.
          else if (s.chain.length > 0) s.step = { at: 'resolve', then: step.then };
          else s.step = next(step.then);
        }
        return;
      }
      case 'judged': {
        const r = event.record;
        // A failed call isn't a ruling, so the player may try again. A legal activation changes the board anyway.
        if (r.stage === 'activation' && !r.legal && r.error === null) {
          s.rulings.push({ player: r.player, card: r.card, effect: r.effect, legal: false, summary: r.summary });
        }
        // A trigger that couldn't be activated, for whatever reason, is set aside for this sequence.
        if (r.stage === 'activation' && !r.legal && s.step.at === 'triggers') s.step.handled.push(`${r.card}:${r.effect}`);
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
    if (event.type === 'sheetUpdated') {
      if (event.sheet) s.sheets[event.code] = event.sheet;
      else delete s.sheets[event.code];
    }
    // Every other event changes the board, or (a sheet update) how a card works, so earlier rulings no longer apply.
    if (s.rulings.length > 0) s.rulings = [];
    const group = s.resolvedLinks;
    switch (event.type) {
      case 'checkpoint':
        s.step = { at: 'triggers', cause: event.cause, then: event.then, handled: [], passed: [] };
        return;
      case 'triggersDone': {
        const step = s.step;
        if (step.at !== 'triggers') throw new Error('No triggers to finish');
        s.happened = [];
        // A chain, or an event players may respond to, opens a response window; the turn player has priority first,
        // or the opponent of whoever activated the last link.
        if (s.chain.length > 0 || step.cause) {
          const actor = s.chain.at(-1)?.player ?? s.turnPlayer;
          s.step = { at: 'respond', cause: step.cause, then: step.then, priority: s.chain.length > 0 ? other(actor) : actor, actor, passed: false };
        } else s.step = next(step.then);
        return;
      }
      case 'turnStarted':
        s.turn = event.turn;
        s.turnPlayer = event.player;
        s.step = { at: 'open' };
        s.happened = [];
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
      case 'destroyedByBattle':
        for (const id of event.cards) {
          const player = locate(s, id)!.seat;
          sendToGraveyard(s, id);
          s.happened.push({ event: 'destroyed_by_battle', card: id, player, group });
        }
        return;
      case 'tributed':
      case 'discarded':
        for (const id of event.cards) sendToGraveyard(s, id);
        return;
      case 'normalSummoned':
      case 'monsterSet': {
        const p = s.players[event.player];
        take(p.hand, event.card);
        p.monsters[event.zone] = fieldCard(event.card, s.turn, event.type === 'normalSummoned');
        s.normalSummons++;
        if (event.type === 'normalSummoned') summoned(s, event.card, event.player, 'normal', group);
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
        summoned(s, event.card, event.player, 'flip', group);
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
        s.attack = { attacker: event.attacker, target: event.target };
        s.happened.push({ event: 'attack_declared', card: event.attacker, player: event.player, target: event.target, group });
        if (event.target) s.happened.push({ event: 'attacked', card: event.target, player: other(event.player), attacker: event.attacker, group });
        return;
      case 'attackEnded': {
        const attacker = s.attack && locate(s, s.attack.attacker);
        // A replay: the attack never happened, so the monster may attack again.
        if (event.replay && attacker?.zone === 'monsters') onField(s, s.attack!.attacker).attackedTurn = null;
        s.attack = null;
        return;
      }
      case 'flippedByAttack':
        onField(s, event.card).faceUp = true;
        return;
      case 'battleDamage': {
        const p = s.players[event.player];
        p.lp = Math.max(0, p.lp - event.amount);
        s.happened.push({ event: 'battle_damage', card: event.by, player: other(event.player), amount: event.amount, group });
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
        s.chain.push({ player: event.player, card: event.card, effect: event.effect, targets: [], choice: null, cause: event.cause });
        s.usedThisTurn.push({ card: event.card, code: s.instances[event.card]!.code, effect: event.effect });
        const step = s.step;
        // A trigger joins the chain with the others; any other activation hands the opponent priority.
        if (step.at === 'triggers') step.handled.push(`${event.card}:${event.effect}`);
        else if (step.at === 'respond') Object.assign(step, { priority: other(event.player), actor: event.player, passed: false });
        else s.step = { at: 'respond', cause: null, then: { do: 'open' }, priority: other(event.player), actor: event.player, passed: false };
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
        summoned(s, event.card, event.player, 'special', group);
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
        s.resolvedLinks++;
        // Once the whole chain has resolved, triggers from what happened during it go on a new one.
        if (s.chain.length === 0 && s.step.at === 'resolve') s.step = { at: 'triggers', cause: null, then: s.step.then, handled: [], passed: [] };
        return;
      }
      case 'duelEnded':
        s.result = event.result;
        return;
    }
  });
}

/** After a sequence with nothing left to do: back to the open game, or on to what comes next. */
const next = (then: Then): DuelState['step'] => (then.do === 'open' ? { at: 'open' } : { at: 'continue', then });

function summoned(s: DuelState, id: string, player: Seat, how: SummonKind, group: number) {
  onField(s, id).summoned = { how, turn: s.turn };
  s.happened.push({ event: 'summoned', card: id, player, how, group } satisfies Happening);
}

/** A card's printed Level. An Xyz Monster's number is its Rank, not a Level, so it has none. */
export const levelOf = (card: CardData): number | null => (/\bXYZ\b/i.test(card.type) ? null : card.level);

/** A face-up monster's ATK, DEF and Level after modifiers. Level modifiers apply in order; a set Level overrides earlier ones. */
export function statsOf(state: DuelState, id: string): { atk: number; def: number; level: number | null } {
  const card = state.cards[state.instances[id]!.code]!;
  // "Becomes" sets the base (the latest wins); every gain and loss is added on top, whenever it was applied.
  let atk = card.atk ?? 0;
  let def = card.def ?? 0;
  let atkDelta = 0;
  let defDelta = 0;
  let level = levelOf(card);
  for (const m of state.modifiers) {
    if (m.card !== id) continue;
    if (m.atkSet !== null) atk = m.atkSet;
    if (m.defSet !== null) def = m.defSet;
    atkDelta += m.atk;
    defDelta += m.def;
    if (m.levelSet !== null) level = m.levelSet;
    if (level !== null) level = Math.max(1, level + m.levelDelta);
  }
  return { atk: Math.max(0, atk + atkDelta), def: Math.max(0, def + defDelta), level };
}

function fieldCard(id: string, turn: number, faceUp: boolean): FieldCard {
  return {
    id,
    position: faceUp ? 'attack' : 'defense',
    faceUp,
    placedTurn: turn,
    positionChangedTurn: null,
    attackedTurn: null,
    summoned: null,
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
