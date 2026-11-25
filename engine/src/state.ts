// Folding events into state. Every change to a duel goes through evolve, so replaying the log rebuilds any past board.

import { produce } from 'immer';
import { continuousOnField, positionsToForce } from './continuous.ts';
import { fits } from './script.ts';
import {
  EXTRA_MONSTER_ZONES,
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

/** An Extra Monster Zone as the player across the table numbers it: one player's left is the other's right. */
export const acrossTable = (zone: number) => (zone === 5 ? 6 : 5);

/** Whether a Monster Zone of `seat` is empty. An Extra Monster Zone must also be empty on the other side. */
export function monsterZoneFree(state: DuelState, seat: Seat, zone: number): boolean {
  if (state.players[seat].monsters[zone] !== null) return false;
  return zone < MONSTER_ZONES || state.players[other(seat)].monsters[acrossTable(zone)] === null;
}

/**
 * The empty zones a monster may be put in: a Main Monster Zone, or for a monster Summoned from the Extra Deck also an
 * empty Extra Monster Zone, as long as the player doesn't already have a monster in the other one (each player may
 * use only one).
 */
export function monsterZonesFor(state: DuelState, seat: Seat, fromExtraDeck: boolean): number[] {
  const main = [...Array(MONSTER_ZONES).keys()].filter((z) => monsterZoneFree(state, seat, z));
  const monsters = state.players[seat].monsters;
  if (!fromExtraDeck || EXTRA_MONSTER_ZONES.some((z) => monsters[z] !== null)) return main;
  return [...main, ...EXTRA_MONSTER_ZONES.filter((z) => monsterZoneFree(state, seat, z))];
}

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
    monsters: Array(MONSTER_ZONES + EXTRA_MONSTER_ZONES.length).fill(null),
    spellTraps: Array(SPELL_TRAP_ZONES + 1).fill(null),
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
    forbidden: [],
    granted: [],
    didThisTurn: [],
    properlySummoned: [],
    sentThisTurn: [],
    pledges: [],
    lingering: [],
    chain: [],
    step: { at: 'rps', picks: [null, null], last: null },
    happened: [],
    resolvedLinks: 0,
    attack: null,
    usedThisTurn: [],
    rulings: [],
    rollback: null,
    binding: null,
    result: null,
  };
}

export function evolve(state: DuelState, event: DuelEvent): DuelState {
  return holdPositions(fold(state, event));
}

/** Monsters a continuous effect keeps in a battle position are changed to it as soon as they aren't (Dragon Capture Jar). */
function holdPositions(state: DuelState): DuelState {
  const changes = positionsToForce(state);
  if (changes.length === 0) return state;
  return produce(state, (s) => {
    for (const { card, position } of changes) Object.assign(onField(s, card), { position, positionChangedTurn: s.turn });
  });
}

function fold(state: DuelState, event: DuelEvent): DuelState {
  return produce(state, (s) => {
    switch (event.type) {
      case 'duelStarted':
        throw new Error('duelStarted can only be the first event');
      case 'intent':
      case 'chatted':
      case 'aiDecided':
      case 'asked':
      case 'escalated':
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
        // The resolution a rollback bound is ruled again.
        if (r.stage === 'resolution' && s.binding?.card === r.card && s.binding.effect === r.effect) s.binding = null;
        // A failed call isn't a ruling, so the player may try again. A legal activation changes the board anyway.
        if (r.stage === 'activation' && !r.legal && r.error === null) {
          s.rulings.push({ player: r.player, card: r.card, effect: r.effect, legal: false, summary: r.summary });
        }
        // A trigger that couldn't be activated, for whatever reason, is set aside for this sequence.
        if (r.stage === 'activation' && !r.legal && s.step.at === 'triggers') s.step.handled.push(`${r.card}:${r.effect}`);
        return;
      }
      case 'rollbackOffered':
        s.rollback = { ...event.offer, accepted: [] };
        return;
      case 'rollbackAnswered':
        if (!s.rollback) throw new Error('No rollback offered');
        if (event.accept) s.rollback.accepted.push(event.player);
        else s.rollback = null;
        return;
      case 'rolledBack': {
        const offer = s.rollback;
        if (!offer) throw new Error('No rollback offered');
        Object.assign(s, structuredClone(event.board), { rollback: null });
        const d = offer.decision;
        // A wrongly allowed activation is refused from now on; a resolution is ruled again, bound to the appeal.
        if (d.stage === 'activation') s.rulings.push({ player: d.player, card: d.card, effect: d.effect, legal: false, summary: offer.ruling });
        else s.binding = { player: d.player, card: d.card, effect: d.effect, ruling: offer.ruling };
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
    if (event.type === 'sheetUpdated') s.sheets[event.code] = event.sheet;
    // Every other event changes the board, or (a sheet update) how a card works, so earlier rulings no longer apply.
    if (s.rulings.length > 0) s.rulings = [];
    const group = s.resolvedLinks;
    switch (event.type) {
      case 'checkpoint':
        s.step = { at: 'triggers', cause: event.cause, then: event.then, handled: [], passed: [] };
        // A phase starting is something triggers can wait for too ("During the End Phase").
        if (event.cause?.event === 'phase') s.happened.push(event.cause);
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
        // Bans for this turn and later ones ("skip the Battle Phase of your next turn") stay.
        s.forbidden = s.forbidden.filter((f) => f.turn >= event.turn);
        s.granted = [];
        s.pledges = [];
        s.didThisTurn = [];
        s.sentThisTurn = [];
        s.lingering = s.lingering.filter((l) => l.untilTurn >= event.turn);
        return;
      case 'phaseChanged':
        s.phase = event.phase;
        if (event.phase === 'battle') s.didThisTurn.push({ player: s.turnPlayer, what: 'battle_phase', card: null });
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
      case 'destroyedByBattle': {
        // Each monster destroyed was destroyed by the other one in the battle.
        const destroyers = event.cards.map((id) => {
          const by = s.attack && (id === s.attack.attacker ? s.attack.target : s.attack.attacker);
          const at = by ? locate(s, by) : null;
          return by && at ? { by, seat: at.seat } : null;
        });
        event.cards.forEach((id, i) => {
          const player = locate(s, id)!.seat;
          sendToGraveyard(s, id);
          s.happened.push({ event: 'destroyed_by_battle', card: id, player, group });
          const d = destroyers[i];
          if (d) s.happened.push({ event: 'battle_destroying', card: d.by, player: d.seat, target: id, group });
        });
        return;
      }
      case 'tributed':
      case 'discarded':
        for (const id of event.cards) sendToGraveyard(s, id);
        return;
      case 'normalSummoned':
      case 'monsterSet': {
        const p = s.players[event.player];
        take(p.hand, event.card);
        p.monsters[event.zone] = fieldCard(event.card, s.turn, event.type === 'normalSummoned');
        const extra = event.type === 'normalSummoned' ? event.extra : null;
        if (extra) s.usedThisTurn.push({ player: event.player, card: extra.card, code: s.instances[extra.card]!.code, effect: extra.effect });
        else s.normalSummons++;
        if (event.type === 'normalSummoned') {
          summoned(s, event.card, event.player, 'normal', group);
          const name = s.cards[s.instances[event.card]!.code]!.name;
          s.pledges = s.pledges.filter((pl) => pl.player !== event.player || !pl.names.includes(name));
        }
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
        s.happened.push({ event: 'flipped', card: event.card, player: event.player, group });
        return;
      }
      case 'positionChanged': {
        const card = onField(s, event.card);
        card.position = event.position;
        card.positionChangedTurn = s.turn;
        // Limit Reverse: its monster changed to Defense Position takes both cards with it.
        if (event.position === 'defense') {
          const breaking = tiedTo(s, event.card).filter((c) => tie(s, c.id)?.defenseBreaks);
          if (breaking.length > 0) for (const id of [event.card, ...breaking.map((c) => c.id)]) if (locate(s, id)) sendToGraveyard(s, id);
        }
        return;
      }
      case 'attackDeclared': {
        const attacker = onField(s, event.attacker);
        const on = event.target ? onField(s, event.target).position : null;
        attacker.attacks = { turn: s.turn, count: attacker.attacks?.turn === s.turn ? attacker.attacks.count + 1 : 1, on };
        s.attack = { attacker: event.attacker, target: event.target, replaced: {}, damageStep: false, noDamageTo: [] };
        s.didThisTurn.push({ player: event.player, what: 'declare_attack', card: event.attacker });
        s.happened.push({ event: 'attack_declared', card: event.attacker, player: event.player, target: event.target, group });
        if (event.target) s.happened.push({ event: 'attacked', card: event.target, player: other(event.player), attacker: event.attacker, group });
        return;
      }
      case 'attackEnded': {
        const attacker = s.attack && locate(s, s.attack.attacker);
        // A replay: the attack never happened, so the monster may attack again.
        if (event.replay && attacker?.zone === 'monsters') {
          const m = onField(s, s.attack!.attacker);
          m.attacks = m.attacks!.count > 1 ? { ...m.attacks!, count: m.attacks!.count - 1 } : null;
        }
        if (s.attack?.damageStep) s.happened.push({ event: 'damage_step_end', card: s.attack.attacker, player: s.turnPlayer, target: s.attack.target, group });
        s.attack = null;
        return;
      }
      case 'turnedFaceDown': {
        const card = onField(s, event.card);
        Object.assign(card, { faceUp: false, position: 'defense', positionChangedTurn: s.turn, counters: {}, effectsNegated: false });
        s.modifiers = s.modifiers.filter((m) => m.card !== event.card);
        s.granted = s.granted.filter((g) => g.card !== event.card);
        // Equip Spells and the like can't stay with a face-down monster.
        for (const c of tiedTo(s, event.card)) sendToGraveyard(s, c.id);
        return;
      }
      case 'flipped':
        onField(s, event.card).faceUp = true;
        s.happened.push({ event: 'flipped', card: event.card, player: locate(s, event.card)!.seat, group });
        return;
      case 'battleDamage': {
        const p = s.players[event.player];
        p.lp = Math.max(0, p.lp - event.amount);
        s.happened.push({ event: 'battle_damage', card: event.by, player: other(event.player), amount: event.amount, direct: s.attack?.target === null, group });
        return;
      }
      case 'effectActivated': {
        const p = s.players[event.player];
        if (event.zone !== null) {
          take(p.hand, event.card);
          p.spellTraps[event.zone] = { ...fieldCard(event.card, s.turn, true), position: 'attack', activatedTurn: s.turn };
        } else {
          const at = locate(s, event.card);
          if (at?.zone === 'spellTraps') Object.assign(onField(s, event.card), { faceUp: true, activatedTurn: s.turn });
        }
        s.chain.push({ player: event.player, card: event.card, effect: event.effect, targets: [], choice: null, paid: [], cause: event.cause, negated: false, setAgain: false, taxed: false });
        s.usedThisTurn.push({ player: event.player, card: event.card, code: s.instances[event.card]!.code, effect: event.effect });
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
      case 'revealed':
        return;
      case 'effectChosen':
        s.chain.at(-1)!.choice = event.choice;
        return;
      case 'costPaid':
        s.chain.at(-1)!.paid = event.cards;
        return;
      case 'moved': {
        if (event.to === 'graveyard') return sendToGraveyard(s, event.card);
        const banish = removeFromPlay(s, event.card);
        const owner = s.players[event.owner];
        const card = s.cards[s.instances[event.card]!.code]!;
        if (isToken(s, event.card)) return;
        // Back in the hand, Deck or Extra Deck, a monster must be properly Summoned again.
        if (!banish && event.to !== 'banished') s.properlySummoned = s.properlySummoned.filter((id) => id !== event.card);
        if (banish) owner.banished.push(event.card);
        else if (card.extraDeck && event.to !== 'banished') owner.extra.push(event.card);
        else if (event.to === 'hand') owner.hand.push(event.card);
        else if (event.to === 'deck_top') owner.deck.unshift(event.card);
        else if (event.to === 'deck_bottom' || event.to === 'deck_shuffled') owner.deck.push(event.card);
        else owner.banished.push(event.card);
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
      case 'banishWhenLeaves':
        onField(s, event.card).banishWhenLeaves = true;
        return;
      case 'controlChanged': {
        const card = onField(s, event.card);
        removeFromPlay(s, event.card, false);
        s.players[event.to].monsters[event.zone] = { ...card, returnsAtEndPhase: event.until === 'end_phase' };
        return;
      }
      case 'tokenSummoned':
        s.instances[event.card] = { code: event.token.code, owner: event.player };
        s.cards[event.token.code] = event.token;
        s.players[event.player].monsters[event.zone] = { ...fieldCard(event.card, s.turn, true), position: event.position };
        summoned(s, event.card, event.player, 'special', group);
        return;
      case 'specialSummoned': {
        removeFromPlay(s, event.card);
        s.players[event.player].monsters[event.zone] = { ...fieldCard(event.card, s.turn, true), position: event.position };
        summoned(s, event.card, event.player, 'special', group);
        return;
      }
      case 'extraSummoned': {
        // Fusion and Synchro Materials go to the GY; Xyz Materials go under the Xyz Monster.
        if (event.how !== 'xyz') for (const id of event.materials) sendToGraveyard(s, id);
        else for (const id of event.materials) removeFromPlay(s, id);
        take(s.players[event.player].extra, event.card);
        const materials = event.how === 'xyz' ? [...event.materials] : [];
        s.players[event.player].monsters[event.zone] = { ...fieldCard(event.card, s.turn, true), position: event.position, materials };
        summoned(s, event.card, event.player, event.how, group, event.materials);
        s.properlySummoned.push(event.card);
        return;
      }
      case 'destroyed':
        for (const id of event.cards) {
          const at = locate(s, id);
          if (!at || (at.zone !== 'monsters' && at.zone !== 'spellTraps')) continue;
          const faceUp = s.players[at.seat][at.zone][at.index]!.faceUp;
          sendToGraveyard(s, id);
          s.happened.push({ event: 'destroyed_by_effect', card: id, player: at.seat, by: event.by, faceUp, group });
        }
        return;
      case 'countersChanged': {
        const counters = onField(s, event.card).counters;
        counters[event.counter] = (counters[event.counter] ?? 0) + event.delta;
        return;
      }
      case 'replacementOffered':
        s.step = { at: 'replace', card: event.card, player: event.player, then: event.then };
        return;
      case 'taxDemanded':
        s.chain.at(-1)!.taxed = true;
        s.step = { at: 'tax', player: event.player, by: event.by, then: (s.step as { then: Then }).then };
        return;
      case 'taxAnswered': {
        const step = s.step;
        if (step.at !== 'tax') throw new Error('Nothing to answer');
        if (event.negated) s.chain.at(-1)!.negated = true;
        s.step = { at: 'resolve', then: step.then };
        return;
      }
      case 'replacementChosen': {
        const step = s.step;
        if (step.at !== 'replace') throw new Error('Nothing to replace');
        s.attack!.replaced[event.card] = event.materials;
        s.step = { at: 'continue', then: step.then };
        return;
      }
      case 'damageStepStarted':
        s.attack!.damageStep = true;
        s.happened.push({ event: 'damage_step_start', card: s.attack!.attacker, player: s.turnPlayer, target: s.attack!.target, group });
        return;
      case 'lpChanged': {
        const p = s.players[event.player];
        p.lp = Math.max(0, p.lp + event.amount);
        return;
      }
      case 'statsModified':
        s.modifiers.push(event.modifier);
        return;
      case 'locked': {
        const { type: _, ...lock } = event;
        s.lingering.push(lock);
        return;
      }
      case 'substituted':
        s.usedThisTurn.push({ player: event.player, card: event.card, code: s.instances[event.card]!.code, effect: event.effect });
        return;
      case 'pledged':
        s.pledges.push({ player: event.player, names: event.names, damage: event.damage });
        return;
      case 'forbidden':
        s.forbidden.push({ player: event.player, what: event.what, filter: event.filter, except: event.except, turn: s.turn });
        return;
      case 'granted':
        s.granted.push({ card: event.card, effect: event.effect });
        return;
      case 'battleDamageZeroed':
        s.attack!.noDamageTo.push(event.player);
        return;
      case 'procedureUsed':
        s.properlySummoned.push(event.card);
        s.usedThisTurn.push({ player: event.player, card: event.card, code: s.instances[event.card]!.code, effect: event.effect });
        return;
      case 'protectionUsed':
        s.usedThisTurn.push({ player: event.player, card: event.card, code: s.instances[event.card]!.code, effect: event.effect });
        return;
      case 'linked':
        onField(s, event.card).linked = event.to;
        return;
      case 'activationNegated':
        s.chain[event.link]!.negated = true;
        return;
      case 'effectsNegated':
        onField(s, event.card).effectsNegated = true;
        return;
      case 'setAgain':
        s.chain.at(-1)!.setAgain = true;
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
        // A Normal Spell/Trap that says it remains on the field (Swords of Revealing Light) stays. An Equip Spell, or a
        // Continuous Trap that works through its monster, that didn't get one has nothing to do there.
        const effects = s.sheets[card.code]?.effects ?? [];
        const remains = effects.some((e) => e.continuous?.apply === 'self_destruct');
        const needsLink = card.race === 'Equip' || effects.some((e) => e.continuous?.apply === 'tie' || (e.continuous && 'to' in e.continuous && e.continuous.to === 'linked'));
        const unlinked = at?.zone === 'spellTraps' && needsLink && !s.players[at.seat].spellTraps[at.index]!.linked;
        if (at?.zone === 'spellTraps' && link.setAgain && !link.negated) {
          Object.assign(s.players[at.seat].spellTraps[at.index]!, { faceUp: false, placedTurn: s.turn, activatedTurn: null });
        } else if (at?.zone === 'spellTraps' && (link.negated || (leaves.includes(card.race) && !remains) || unlinked)) sendToGraveyard(s, link.card);
        s.resolvedLinks++;
        // Once the whole chain has resolved, triggers from what happened during it go on a new one.
        if (s.chain.length === 0 && s.step.at === 'resolve') s.step = { at: 'triggers', cause: null, then: s.step.then, handled: [], passed: [] };
        return;
      }
      case 'duelEnded':
        s.result = event.result;
        s.rollback = null;
        return;
    }
  });
}

/** After a sequence with nothing left to do: back to the open game, or on to what comes next. */
const next = (then: Then): DuelState['step'] => (then.do === 'open' ? { at: 'open' } : { at: 'continue', then });

function summoned(s: DuelState, id: string, player: Seat, how: SummonKind, group: number, materials: string[] = []) {
  onField(s, id).summoned = { how, turn: s.turn, materials };
  if (how !== 'normal' && how !== 'flip') s.didThisTurn.push({ player, what: 'special_summon', card: id });
  s.happened.push({ event: 'summoned', card: id, player, how, group } satisfies Happening);
}

/** Whether a Summon is one of those wanted (empty for any). Synchro and Xyz Summons are Special Summons too. */
export const summonMatches = (how: SummonKind, wanted: SummonKind[]) =>
  wanted.length === 0 || wanted.includes(how) || (wanted.includes('special') && (how === 'fusion' || how === 'synchro' || how === 'xyz'));

export const summonName: Record<SummonKind, string> = { normal: 'Normal', flip: 'Flip', special: 'Special', fusion: 'Fusion', synchro: 'Synchro', xyz: 'Xyz' };

/** A card's printed Level. An Xyz Monster's number is its Rank, not a Level, so it has none. */
export const levelOf = (card: CardData): number | null => (/\bXYZ\b/i.test(card.type) ? null : card.level);

function fieldCard(id: string, turn: number, faceUp: boolean): FieldCard {
  return {
    id,
    position: faceUp ? 'attack' : 'defense',
    faceUp,
    placedTurn: turn,
    positionChangedTurn: null,
    attacks: null,
    summoned: null,
    materials: [],
    activatedTurn: null,
    linked: null,
    effectsNegated: false,
    counters: {},
    returnsAtEndPhase: false,
    banishWhenLeaves: false,
  };
}

function take(pile: string[], id: string) {
  const i = pile.indexOf(id);
  if (i < 0) throw new Error(`Card ${id} is not where the event says`);
  pile.splice(i, 1);
}

/** Where a card instance is right now. An Xyz Material's `index` is the Monster Zone of the monster it is attached to. */
export type Location =
  | { seat: Seat; zone: 'monsters' | 'spellTraps' | 'materials'; index: number }
  | { seat: Seat; zone: 'deck' | 'hand' | 'graveyard' | 'banished' | 'extra' };

export function locate(state: DuelState, id: string): Location | null {
  for (const seat of [0, 1] as const) {
    const p = state.players[seat];
    for (const zone of ['monsters', 'spellTraps'] as const) {
      const index = p[zone].findIndex((c) => c?.id === id);
      if (index >= 0) return { seat, zone, index };
    }
    const under = p.monsters.findIndex((c) => c?.materials.includes(id));
    if (under >= 0) return { seat, zone: 'materials', index: under };
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

/**
 * Takes a card out of wherever it is. A card leaving the field loses its modifiers, and its Xyz Materials go to their
 * owners' GYs; with `leaves` false (a change of control) it keeps everything.
 */
/** Takes a card out of where it is. Returns whether it must be banished instead, having left the field. */
function removeFromPlay(state: DuelState, id: string, leaves = true): boolean {
  const at = locate(state, id);
  if (!at) throw new Error(`Unknown card ${id}`);
  const p = state.players[at.seat];
  if (at.zone === 'monsters' || at.zone === 'spellTraps') {
    const card = p[at.zone][at.index]!;
    const leaving = leaves ? continuousOnField(state).filter((f) => f.source === id && f.effect.apply === 'forbid_on_leaving') : [];
    p[at.zone][at.index] = null;
    // A change of control moves the card without it leaving the field.
    if (!leaves) return false;
    // "If this face-up card leaves the field, skip the Battle Phase of your next turn" (Moulinglacia).
    const next = state.turnPlayer === at.seat ? state.turn + 2 : state.turn + 1;
    for (const f of leaving) if (f.effect.apply === 'forbid_on_leaving') state.forbidden.push({ player: at.seat, what: f.effect.what, filter: null, except: null, turn: next });
    state.modifiers = state.modifiers.filter((m) => m.card !== id);
    state.granted = state.granted.filter((g) => g.card !== id);
    for (const m of card.materials) toGraveyard(state, m);
    // Cards linked to a monster go when it goes; a card that takes its monster with it (Birthright) does so.
    for (const c of tiedTo(state, id)) sendToGraveyard(state, c.id);
    if (card.linked && tie(state, id)?.destroyLinked && locate(state, card.linked)?.zone === 'monsters') sendToGraveyard(state, card.linked);
    return card.banishWhenLeaves;
  }
  if (at.zone === 'materials') take(p.monsters[at.index]!.materials, id);
  else take(p[at.zone], id);
  return false;
}

/** The Spells and Traps on the field linked to this monster. */
function tiedTo(state: DuelState, id: string): FieldCard[] {
  return state.players.flatMap((p) => p.spellTraps.filter((c): c is FieldCard => c?.linked === id));
}

/** A card's `tie` continuous effect, if it has one. */
function tie(state: DuelState, id: string) {
  const effects = state.sheets[state.instances[id]!.code]?.effects ?? [];
  for (const e of effects) if (e.continuous?.apply === 'tie' && e.status !== 'flagged') return e.continuous;
  return null;
}

/** Cards always go to their owner's Graveyard. A Token that leaves the field is gone. */
function sendToGraveyard(state: DuelState, id: string) {
  const at = locate(state, id)!;
  const instead = (at.zone === 'monsters' || at.zone === 'spellTraps') && banishedInstead(state, id);
  const banish = removeFromPlay(state, id) || instead;
  if (isToken(state, id)) return;
  const owner = state.players[state.instances[id]!.owner];
  if (banish) return void owner.banished.push(id);
  toGraveyard(state, id);
  if (at.zone === 'monsters' || at.zone === 'spellTraps') state.happened.push({ event: 'sent_to_graveyard', card: id, player: at.seat, group: state.resolvedLinks });
}

/** Puts a card in its owner's GY, noting the turn for "except the turn it was sent there". */
function toGraveyard(state: DuelState, id: string) {
  state.players[state.instances[id]!.owner].graveyard.push(id);
  state.sentThisTurn.push(id);
}

/** Whether a continuous effect banishes this card on the field instead of letting it go to the GY (General Wayne). */
function banishedInstead(state: DuelState, id: string): boolean {
  return continuousOnField(state).some((f) => f.effect.apply === 'banish_instead' && f.source !== id && fits(state, id, f.effect.filter, f.seat));
}

/** Whether a card is a Token: made on the field by an effect, and gone once it leaves. */
export const isToken = (state: DuelState, id: string) => state.cards[state.instances[id]!.code]!.type === 'Token';
