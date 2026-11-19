// Structured effects (see Script in types.ts): which cards fit a filter, and whether an activation is legal now.
// Code decides these exactly, so an activation a script rules out is never offered.

import { cardOf } from './rules.ts';
import { levelOf, locate, statsOf } from './state.ts';
import type { CardFilter, DuelState, Range, Script, Seat, Selection, Step } from './types.ts';

/** The script of a card's effect, if it has one that hasn't been flagged. */
export function scriptOf(state: DuelState, card: string, effect: number): Script | null {
  const e = state.sheets[cardOf(state, card).code]?.effects[effect];
  return e?.status === 'flagged' ? null : (e?.script ?? null);
}

const inRange = (value: number | null, range: Range | null) =>
  range === null || (value !== null && (range.min === null || value >= range.min) && (range.max === null || value <= range.max));

/** Whether a card fits a filter, for the effect of player `seat`. A face-down card shows only whether it is a monster or a Spell/Trap. */
export function fits(state: DuelState, id: string, filter: CardFilter, seat: Seat): boolean {
  const at = locate(state, id);
  if (!at) return false;
  if (filter.side !== 'either' && (filter.side === 'you') !== (at.seat === seat)) return false;
  const onField = at.zone === 'monsters' || at.zone === 'spellTraps';
  if (filter.place === 'field' ? !onField : filter.place !== at.zone) return false;
  const field = onField ? state.players[at.seat][at.zone][at.index]! : null;
  if (filter.faceUp !== null && (!field || field.faceUp !== filter.faceUp)) return false;
  if (filter.position !== null && (at.zone !== 'monsters' || field!.position !== filter.position)) return false;
  if (field && !field.faceUp) {
    const identity = filter.types.length + filter.races.length + filter.attributes.length > 0 || filter.level || filter.atk || filter.def;
    if (identity) return false;
    if (filter.kinds.length === 0) return true;
    return at.zone === 'monsters' ? filter.kinds.includes('monster') : filter.kinds.includes('spell') && filter.kinds.includes('trap');
  }
  const card = cardOf(state, id);
  if (filter.kinds.length && !filter.kinds.includes(card.kind)) return false;
  const words = card.type.toLowerCase().split(/\s+/);
  if (!filter.types.every((t) => words.includes(t.toLowerCase()))) return false;
  if (filter.races.length && !filter.races.some((r) => r.toLowerCase() === card.race.toLowerCase())) return false;
  if (filter.attributes.length && !filter.attributes.some((a) => a.toUpperCase() === card.attribute)) return false;
  const stats = at.zone === 'monsters' ? statsOf(state, id) : { atk: card.atk, def: card.def, level: levelOf(card) };
  return inRange(stats.level, filter.level) && inRange(stats.atk, filter.atk) && inRange(stats.def, filter.def);
}

/** Every card that fits, except `except` (the card being activated). */
export function cardsFitting(state: DuelState, filter: CardFilter, seat: Seat, except: string): string[] {
  return Object.keys(state.instances).filter((id) => id !== except && fits(state, id, filter, seat));
}

/** The cards a `choose` selection may pick from: those that fit, narrowed to the ones tied for its rank. */
export function chooseFrom(state: DuelState, selection: Extract<Selection, { from: 'choose' }>, seat: Seat, except: string): string[] {
  const all = cardsFitting(state, selection.filter, seat, except);
  const rank = selection.rank;
  if (!rank || all.length === 0) return all;
  const value = (id: string) => statsOf(state, id)[rank.stat] ?? 0;
  const best = (rank.order === 'lowest' ? Math.min : Math.max)(...all.map(value));
  return all.filter((id) => value(id) === best);
}

/** "face-up Warrior monster your opponent controls". */
export function describeFilter(f: CardFilter): string {
  const words: string[] = [];
  if (f.faceUp !== null) words.push(f.faceUp ? 'face-up' : 'face-down');
  if (f.position) words.push(`${f.position === 'attack' ? 'Attack' : 'Defense'} Position`);
  if (f.attributes.length) words.push(f.attributes.join(' or '));
  if (f.races.length) words.push(f.races.join(' or '));
  words.push(...f.types);
  const kinds = [...f.kinds].sort();
  words.push(
    kinds.length === 0 ? 'card' : kinds.join() === 'spell,trap' ? 'Spell/Trap' : kinds.map((k) => (k === 'monster' ? 'monster' : k === 'spell' ? 'Spell' : 'Trap')).join(' or '),
  );
  const range = (name: string, r: Range | null) =>
    !r ? [] : r.min !== null && r.max !== null ? (r.min === r.max ? [`${name} ${r.min}`] : [`${name} ${r.min} to ${r.max}`]) : r.max !== null ? [`${name} ${r.max} or less`] : r.min !== null ? [`${name} ${r.min} or more`] : [];
  const stats = [...range('Level', f.level), ...range('ATK', f.atk), ...range('DEF', f.def)];
  if (stats.length) words.push(`with ${stats.join(' and ')}`);
  const pile = { hand: 'hand', deck: 'Deck', graveyard: 'GY', banished: 'banished cards' }[f.place as 'hand'];
  const field = { field: 'on the field', monsters: 'in a Monster Zone', spellTraps: 'in a Spell & Trap Zone' }[f.place as 'field'];
  if (field) words.push(f.side === 'you' ? 'you control' : f.side === 'opponent' ? 'your opponent controls' : field);
  else words.push(f.side === 'you' ? `in your ${pile}` : f.side === 'opponent' ? `in your opponent's ${pile}` : `in either player's ${pile}`);
  return words.join(' ');
}

const freeMonsterZones = (state: DuelState, seat: Seat) => state.players[seat].monsters.filter((z) => z === null).length;

/** Why a step couldn't do what it must on this board, or null. A `choose` with min 0 ("you can") and steps on targets need nothing here. */
function stepProblem(state: DuelState, step: Step, seat: Seat, card: string): string | null {
  if (!('cards' in step)) return null;
  const sel = step.cards;
  if (step.do === 'special_summon' && freeMonsterZones(state, seat) === 0) return 'You have no free Monster Zone to Special Summon into.';
  if (sel.from === 'all' && cardsFitting(state, sel.filter, seat, card).length === 0) return `There is no ${describeFilter(sel.filter)}.`;
  if (sel.from === 'choose' && chooseFrom(state, sel, seat, card).length < sel.min) {
    return sel.min === 1 ? `There is no ${describeFilter(sel.filter)}.` : `There are fewer than ${sel.min} of: ${describeFilter(sel.filter)}.`;
  }
  return null;
}

/** The options of a script whose steps can all do what they must now, by index. */
export function feasibleOptions(state: DuelState, script: Script, seat: Seat, card: string): number[] {
  return script.options.flatMap((o, i) => (o.steps.every((s) => !stepProblem(state, s, seat, card)) ? [i] : []));
}

/**
 * Why a scripted activation is illegal on this board, or null if it is legal (or the effect has no script). Judged
 * before the cost is paid: a card the cost will use can't also be one of its targets.
 */
export function scriptProblem(state: DuelState, seat: Seat, card: string, effect: number): string | null {
  const script = scriptOf(state, card, effect);
  if (!script) return null;
  for (const c of script.conditions) {
    if (c.if === 'before_battle_phase' && state.turnPlayer === seat && (state.phase === 'battle' || state.phase === 'main2' || state.phase === 'end')) {
      return 'It can only be activated before you conduct your Battle Phase.';
    }
    if (c.if === 'count' && cardsFitting(state, c.filter, seat, card).length < c.min) {
      return `It needs ${c.min === 1 ? 'a' : `at least ${c.min} of:`} ${describeFilter(c.filter)}.`;
    }
  }
  const costCards = new Set<string>();
  let costCount = 0;
  for (const step of script.cost) {
    if (step.do === 'change_lp' && step.kind === 'cost' && state.players[seat].lp < step.amount) return `You can't pay ${step.amount} LP.`;
    const problem = stepProblem(state, step, seat, card);
    if (problem) return `The cost can't be paid: ${problem}`;
    if ('cards' in step && step.cards.from === 'choose') {
      for (const id of chooseFrom(state, step.cards, seat, card)) costCards.add(id);
      costCount += step.cards.min;
    }
  }
  if (script.targets) {
    const targets = cardsFitting(state, script.targets.filter, seat, card);
    const both = new Set([...targets, ...costCards]).size;
    if (targets.length < script.targets.min || both < script.targets.min + costCount) {
      return `There is no ${describeFilter(script.targets.filter)} to target${costCount ? ' besides the cards paid as its cost' : ''}.`;
    }
  }
  if (feasibleOptions(state, script, seat, card).length === 0) {
    const first = script.options[0]!.steps.map((s) => stepProblem(state, s, seat, card)).find((p) => p);
    return `The effect couldn't do what it must: ${first ?? 'nothing applies.'}`;
  }
  return null;
}
