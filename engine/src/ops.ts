// The judge's ops, checked against the board. Each op either becomes events or is refused with a reason the
// model can act on. Nothing here decides what a card's text means; it only refuses what the board can't allow.

import { cardOf, check, endIfLpGone, Illegal, Run } from './rules.ts';
import { locate, other, statsOf } from './state.ts';
import { MONSTER_ZONES, type DuelEvent, type DuelState, type Op, type Seat } from './types.ts';

export type OpResult = { ok: true; events: DuelEvent[] } | { ok: false; error: string };

export interface OpContext {
  /** The player whose effect this is. */
  player: Seat;
  /** Targets are declared while activating, not while resolving. */
  stage: 'activation' | 'resolution';
  /** [0, 1), for shuffles. */
  random: () => number;
}

export function applyOp(state: DuelState, op: Op, ctx: OpContext): OpResult {
  try {
    check(!state.result, 'The duel is over.');
    const run = new Run(state);
    apply(run, op, ctx);
    endIfLpGone(run);
    return { ok: true, events: run.events };
  } catch (e) {
    if (e instanceof Illegal) return { ok: false, error: e.message };
    throw e;
  }
}

function known(state: DuelState, id: string) {
  check(state.instances[id], `There is no card ${id}.`);
  return locate(state, id)!;
}

function onField(state: DuelState, id: string) {
  const at = known(state, id);
  check(at.zone === 'monsters' || at.zone === 'spellTraps', `${cardOf(state, id).name} (${id}) is not on the field.`);
  return { at, card: state.players[at.seat][at.zone][at.index]! };
}

function apply(run: Run, op: Op, ctx: OpContext) {
  const state = run.state;
  switch (op.op) {
    case 'move': {
      const at = known(state, op.card);
      const owner = state.instances[op.card]!.owner;
      const to = op.to;
      const already =
        (to === 'hand' && at.zone === 'hand') ||
        (to === 'graveyard' && at.zone === 'graveyard') ||
        (to === 'banished' && at.zone === 'banished');
      check(!already, `${cardOf(state, op.card).name} is already there.`);
      check(!(at.zone === 'deck' && to.startsWith('deck_') && to !== 'deck_top'), 'That card is already in the Deck.');
      run.emit({ type: 'moved', card: op.card, owner, from: at.zone, to });
      // Taking a card from the Deck other than drawing it, or adding one at no fixed place, shuffles the Deck.
      const searched = at.zone === 'deck' && state.players[at.seat].deck[0] !== op.card;
      if (to === 'deck_shuffled' || searched) shuffle(run, searched ? at.seat : owner, ctx, to === 'deck_top' ? op.card : null);
      return;
    }
    case 'special_summon': {
      const at = known(state, op.card);
      const card = cardOf(state, op.card);
      check(card.kind === 'monster', `${card.name} is not a monster.`);
      check(at.zone !== 'monsters', `${card.name} is already on the field.`);
      check(at.zone !== 'spellTraps', `${card.name} is in a Spell & Trap Zone.`);
      check(!card.extraDeck, 'Extra Deck monsters are summoned by their own procedures, not by this op.');
      const zones = state.players[op.controller].monsters;
      const zone = zones.indexOf(null);
      check(zone >= 0 && zone < MONSTER_ZONES, 'That player has no empty Monster Zone.');
      run.emit({ type: 'specialSummoned', player: op.controller, card: op.card, zone, position: op.position });
      if (at.zone === 'deck') shuffle(run, at.seat, ctx, null);
      return;
    }
    case 'destroy': {
      check(op.cards.length > 0, 'Name at least one card to destroy.');
      check(new Set(op.cards).size === op.cards.length, 'Each card may be named once.');
      for (const id of op.cards) onField(state, id);
      run.emit({ type: 'destroyed', cards: op.cards });
      return;
    }
    case 'change_lp': {
      check(Number.isInteger(op.amount) && op.amount > 0, 'amount must be a positive whole number.');
      const lp = state.players[op.player].lp;
      if (op.kind === 'cost') {
        check(op.player === ctx.player, 'Only the activating player pays costs.');
        check(op.amount <= lp, `A cost of ${op.amount} LP is more than the ${lp} LP left.`);
      }
      run.emit({ type: 'lpChanged', player: op.player, amount: op.kind === 'gain' ? op.amount : -op.amount, kind: op.kind });
      return;
    }
    case 'modify_stats': {
      const { card } = onField(state, op.card);
      check(locate(state, op.card)!.zone === 'monsters' && card.faceUp, 'Only face-up monsters have stats to modify.');
      check(op.atk !== 0 || op.def !== 0 || op.level_delta !== 0 || op.level_set !== null, 'The op changes nothing.');
      check(op.level_set === null || (Number.isInteger(op.level_set) && op.level_set >= 1 && op.level_set <= 12), 'level_set must be 1 to 12.');
      check(statsOf(state, op.card).level !== null || (op.level_delta === 0 && op.level_set === null), 'That monster has no Level.');
      run.emit({
        type: 'statsModified',
        modifier: {
          card: op.card,
          player: ctx.player,
          atk: op.atk,
          def: op.def,
          levelDelta: op.level_delta,
          levelSet: op.level_set,
          until: op.until,
          turn: state.turn,
        },
      });
      return;
    }
    case 'change_position': {
      const { at, card } = onField(state, op.card);
      check(at.zone === 'monsters', 'Only monsters have a battle position.');
      check(card.position !== op.position || !card.faceUp, `It is already in ${op.position} position.`);
      run.emit({ type: 'positionChanged', player: at.seat, card: op.card, position: op.position });
      // A face-down monster changed to a position by an effect turns face-up, as when attacked.
      if (!card.faceUp) run.emit({ type: 'flippedByAttack', card: op.card });
      return;
    }
    case 'draw': {
      check(Number.isInteger(op.count) && op.count > 0 && op.count <= 10, 'count must be 1 to 10.');
      const deck = state.players[op.player].deck.length;
      if (deck < op.count) {
        if (deck > 0) run.emit({ type: 'drew', player: op.player, count: deck });
        run.emit({ type: 'duelEnded', result: { winner: other(op.player), reason: 'deckOut' } });
        return;
      }
      run.emit({ type: 'drew', player: op.player, count: op.count });
      return;
    }
    case 'extra_normal_summon':
      run.emit({ type: 'normalSummonGranted', player: op.player });
      return;
    case 'declare_targets': {
      check(ctx.stage === 'activation', 'Targets are chosen when the effect is activated, not when it resolves.');
      check(new Set(op.cards).size === op.cards.length, 'Each target may be named once.');
      for (const id of op.cards) {
        const at = known(state, id);
        check(at.zone !== 'deck' && at.zone !== 'hand' && at.zone !== 'extra', 'Only cards on the field, in a GY or banished can be targeted.');
      }
      run.emit({ type: 'targeted', cards: op.cards });
      return;
    }
    case 'choose_effect':
      check(ctx.stage === 'activation', 'The effect is chosen when the card is activated, not when it resolves.');
      check(state.chain.at(-1)!.choice === null, 'An effect was already chosen for this activation.');
      check(op.choice.trim() !== '', 'Say which effect was chosen.');
      run.emit({ type: 'effectChosen', choice: op.choice });
      return;
  }
}

/** Shuffles a player's Deck. `top`, if given, stays on top (a card placed there after searching). */
function shuffle(run: Run, player: Seat, ctx: OpContext, top: string | null) {
  const order = run.state.players[player].deck.filter((id) => id !== top);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  run.emit({ type: 'deckShuffled', player, order: top ? [top, ...order] : order });
}
