// The judge's ops, checked against the board. Each op either becomes events or is refused with a reason the
// model can act on. Nothing here decides what a card's text means; it only refuses what the board can't allow.

import { cardOf, check, endIfLpGone, Illegal, Run } from './rules.ts';
import { restriction, statsOf } from './continuous.ts';
import { specialSummonForbidden } from './script.ts';
import { locate, monsterZonesFor, other } from './state.ts';
import { type CardData, type DuelEvent, type DuelState, type Op, type Seat } from './types.ts';

export type OpResult = { ok: true; events: DuelEvent[] } | { ok: false; error: string };

export interface OpContext {
  /** The player whose effect this is. */
  player: Seat;
  /** The card whose effect this is. */
  source: string;
  /** Targets are declared while activating, not while resolving. */
  stage: 'activation' | 'resolution';
  /** [0, 1), for shuffles. */
  random: () => number;
}

export function applyOp(state: DuelState, op: Op, ctx: OpContext): OpResult {
  try {
    check(!state.result, 'The duel is over.');
    const run = new Run(state);
    const shielded = shield(run, op, ctx);
    if (shielded) apply(run, shielded, ctx);
    endIfLpGone(run);
    return { ok: true, events: run.events };
  } catch (e) {
    if (e instanceof Illegal) return { ok: false, error: e.message };
    throw e;
  }
}

/** The ops that change a card already in play, and so can't touch a card unaffected by the effect. */
const AFFECTING = ['move', 'modify_stats', 'change_position', 'take_control', 'negate_effects', 'add_counters', 'remove_counters', 'detach', 'link'];

/**
 * The op without the cards it can't touch: those unaffected by this effect (Freezing Chains of the Ice Barrier) and,
 * for `destroy`, those that can't be destroyed by it (Dai-sojo of the Ice Barrier). Null when nothing is left to do.
 * A once-per-turn protection that applies is used up.
 */
function shield(run: Run, op: Op, ctx: OpContext): Op | null {
  const state = run.state;
  const spared = (id: string, what: 'be_affected' | 'be_destroyed_by_effect') => {
    if (!locate(state, id)) return false;
    const f = restriction(state, id, what, ctx.source);
    if (f?.effect.once) run.emit({ type: 'protectionUsed', player: f.seat, card: f.source, effect: f.index });
    return f !== null;
  };
  if (op.op === 'destroy') {
    const cards = op.cards.filter((id) => !spared(id, 'be_affected') && !spared(id, 'be_destroyed_by_effect'));
    return cards.length ? { ...op, cards } : null;
  }
  return AFFECTING.includes(op.op) && 'card' in op && spared(op.card, 'be_affected') ? null : op;
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
      check(at.zone !== 'extra', 'Monsters in the Extra Deck are Summoned by their own procedures, not by this op.');
      check(!specialSummonForbidden(state, ctx.player, op.card), `An effect stops that player Special Summoning ${card.name} this turn.`);
      const free = monsterZonesFor(state, op.controller, false);
      check(free.length > 0, 'That player has no empty Main Monster Zone.');
      check(free.includes(op.zone), `Monster Zone ${op.zone + 1} isn't an empty Main Monster Zone of that player.`);
      run.emit({ type: 'specialSummoned', player: op.controller, card: op.card, zone: op.zone, position: op.position });
      if (at.zone === 'deck') shuffle(run, at.seat, ctx, null);
      return;
    }
    case 'take_control': {
      const { at, card } = onField(state, op.card);
      check(at.zone === 'monsters', 'Only monsters can change control.');
      check(at.seat !== op.controller, 'That player already controls it.');
      check(op.until === null || op.until === 'end_phase', 'until is "end_phase" or null.');
      check(monsterZonesFor(state, op.controller, false).includes(op.zone), `Monster Zone ${op.zone + 1} isn't an empty Main Monster Zone of that player.`);
      run.emit({ type: 'controlChanged', card: card.id, to: op.controller, zone: op.zone, until: op.until });
      return;
    }
    case 'summon_token': {
      const t = op.token;
      check(t.name.trim() !== '' && /token/i.test(t.name), 'A Token is named "... Token".');
      check([t.level, t.atk, t.def].every((n) => Number.isInteger(n) && n >= 0) && t.level >= 1 && t.level <= 12, 'A Token has a Level from 1 to 12 and whole ATK and DEF, 0 or more.');
      check(!specialSummonForbidden(state, ctx.player, null), 'An effect stops that player Special Summoning this turn.');
      check(monsterZonesFor(state, op.controller, false).includes(op.zone), `Monster Zone ${op.zone + 1} isn't an empty Main Monster Zone of that player.`);
      // Tokens with the same printed stats share their card data (a code below 0); each Token is a new instance.
      const data: Omit<CardData, 'code'> = { name: t.name, type: 'Token', kind: 'monster', extraDeck: false, text: '', level: t.level, atk: t.atk, def: t.def, attribute: t.attribute.toUpperCase(), race: t.race };
      const same = Object.values(state.cards).find(({ code: _, ...c }) => JSON.stringify(c) === JSON.stringify(data));
      const token: CardData = { code: same?.code ?? Math.min(0, ...Object.keys(state.cards).map(Number)) - 1, ...data };
      const id = `token${Object.keys(state.instances).filter((i) => i.startsWith('token')).length + 1}`;
      run.emit({ type: 'tokenSummoned', player: op.controller, card: id, token, zone: op.zone, position: op.position });
      return;
    }
    case 'destroy': {
      check(op.cards.length > 0, 'Name at least one card to destroy.');
      check(new Set(op.cards).size === op.cards.length, 'Each card may be named once.');
      for (const id of op.cards) onField(state, id);
      run.emit({ type: 'destroyed', cards: op.cards, by: ctx.player });
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
      check(op.atk !== 0 || op.def !== 0 || op.atk_set !== null || op.def_set !== null || op.level_delta !== 0 || op.level_set !== null, 'The op changes nothing.');
      check([op.atk_set, op.def_set].every((v) => v === null || (Number.isInteger(v) && v >= 0)), 'atk_set and def_set must be whole numbers, 0 or more.');
      check(op.level_set === null || (Number.isInteger(op.level_set) && op.level_set >= 1 && op.level_set <= 12), 'level_set must be 1 to 12.');
      check(statsOf(state, op.card).level !== null || (op.level_delta === 0 && op.level_set === null), 'That monster has no Level.');
      run.emit({
        type: 'statsModified',
        modifier: {
          card: op.card,
          player: ctx.player,
          atk: op.atk,
          def: op.def,
          atkSet: op.atk_set,
          defSet: op.def_set,
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
    case 'negate_attack':
      check(state.attack, 'No attack is being made.');
      run.emit({ type: 'attackEnded', replay: false });
      return;
    case 'link': {
      check(ctx.stage === 'resolution', 'A card is equipped or tied to its monster as it resolves.');
      const source = state.chain.at(-1)?.card;
      const at = source ? locate(state, source) : null;
      check(source && at?.zone === 'spellTraps' && state.players[at.seat].spellTraps[at.index]!.faceUp, 'Only a face-up Spell or Trap being resolved can be linked to a monster.');
      check(onField(state, op.card).at.zone === 'monsters', 'A card can only be linked to a monster.');
      run.emit({ type: 'linked', card: source, to: op.card });
      return;
    }
    case 'negate_activation': {
      // The link answered is below the one resolving (or, while activating, below the new one).
      const below = state.chain.length - 1;
      let index = -1;
      for (let i = below - 1; i >= 0; i--) if (state.chain[i]!.card === op.card) { index = i; break; }
      check(index >= 0, `${cardOf(state, op.card).name} has no activation on the chain below this effect to negate.`);
      check(!state.chain[index]!.negated, 'That activation is already negated.');
      run.emit({ type: 'activationNegated', link: index, card: op.card });
      return;
    }
    case 'negate_effects': {
      const target = onField(state, op.card);
      check(target.at.zone === 'monsters' && target.card.faceUp, 'Only a face-up monster has its effects negated this way.');
      run.emit({ type: 'effectsNegated', card: op.card });
      return;
    }
    case 'add_counters': {
      check(Number.isInteger(op.count) && op.count > 0, 'count must be a positive whole number.');
      const target = onField(state, op.card);
      check(target.card.faceUp, 'Counters go on face-up cards.');
      const now = target.card.counters[op.counter] ?? 0;
      const delta = Math.min(op.count, (op.max ?? Infinity) - now);
      check(delta > 0, `${cardOf(state, op.card).name} can't hold more of those counters.`);
      run.emit({ type: 'countersChanged', card: op.card, counter: op.counter, delta });
      return;
    }
    case 'remove_counters': {
      check(Number.isInteger(op.count) && op.count > 0, 'count must be a positive whole number.');
      const target = onField(state, op.card);
      check((target.card.counters[op.counter] ?? 0) >= op.count, `${cardOf(state, op.card).name} doesn't have ${op.count} of those counters.`);
      run.emit({ type: 'countersChanged', card: op.card, counter: op.counter, delta: -op.count });
      return;
    }
    case 'set_again': {
      check(ctx.stage === 'resolution', 'A card is Set again as it resolves.');
      const source = state.chain.at(-1)?.card;
      check(source && locate(state, source)?.zone === 'spellTraps', 'Only a Spell or Trap being resolved can be Set again.');
      run.emit({ type: 'setAgain' });
      return;
    }
    case 'forbid':
      check(op.what === 'special_summon' || op.filter === null, 'Only a Special Summon ban takes a filter.');
      run.emit({ type: 'forbidden', player: op.player, what: op.what, filter: op.filter });
      return;
    case 'detach': {
      const at = known(state, op.card);
      check(at.zone === 'materials', `${cardOf(state, op.card).name} is not an Xyz Material.`);
      run.emit({ type: 'moved', card: op.card, owner: state.instances[op.card]!.owner, from: 'materials', to: 'graveyard' });
      return;
    }
    case 'declare_targets': {
      check(ctx.stage === 'activation', 'Targets are chosen when the effect is activated, not when it resolves.');
      check(new Set(op.cards).size === op.cards.length, 'Each target may be named once.');
      for (const id of op.cards) {
        const at = known(state, id);
        check(at.zone !== 'deck' && at.zone !== 'hand' && at.zone !== 'extra' && at.zone !== 'materials', 'Only cards on the field, in a GY or banished can be targeted.');
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
