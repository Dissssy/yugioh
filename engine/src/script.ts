// Structured effects (see Script in types.ts): which cards fit a filter, and whether an activation is legal now.
// Code decides these exactly, so an activation a script rules out is never offered.

import { cardOf } from './rules.ts';
import { levelNow, nameOf, statsOf } from './continuous.ts';
import { levelOf, locate, monsterZonesFor, other, summonMatches, summonName } from './state.ts';
import type { CardData, CardFilter, Condition, DuelState, Happening, Range, Script, Seat, Selection, Step } from './types.ts';

/** The script of a card's effect, if it has one that hasn't been flagged. */
export function scriptOf(state: DuelState, card: string, effect: number): Script | null {
  const e = state.sheets[cardOf(state, card).code]?.effects[effect];
  return e?.status === 'flagged' ? null : (e?.script ?? null);
}

const inRange = (value: number | null, range: Range | null) =>
  range === null || (value !== null && (range.min === null || value >= range.min) && (range.max === null || value <= range.max));

/**
 * Whether a card's printed identity fits the filter: its kind, type line, monster type, name (`name` if an effect
 * changed it), Attribute and Deck.
 */
export function identityFits(card: CardData, filter: CardFilter, name = card.name): boolean {
  if (filter.kinds.length && !filter.kinds.includes(card.kind)) return false;
  const words = card.type.toLowerCase().split(/\s+/);
  if (!filter.types.every((t) => words.includes(t.toLowerCase()))) return false;
  if (filter.races.length && !filter.races.some((r) => r.toLowerCase() === card.race.toLowerCase())) return false;
  if (filter.named !== null && !name.toLowerCase().includes(filter.named.toLowerCase())) return false;
  if (filter.attributes.length && !filter.attributes.some((a) => a.toUpperCase() === card.attribute)) return false;
  return filter.extraDeck === null || card.extraDeck === filter.extraDeck;
}

/** Whether a card fits a filter, for the effect of player `seat`. A face-down card shows only whether it is a monster or a Spell/Trap. */
export function fits(state: DuelState, id: string, filter: CardFilter, seat: Seat): boolean {
  const at = locate(state, id);
  if (!at) return false;
  if (filter.side !== 'either' && (filter.side === 'you') !== (at.seat === seat)) return false;
  // An Xyz Material is not a card on the field, so no filter's place fits it.
  if (at.zone === 'materials') return false;
  const onField = at.zone === 'monsters' || at.zone === 'spellTraps';
  if (filter.place !== 'any' && (filter.place === 'field' ? !onField : filter.place !== at.zone)) return false;
  const field = at.zone === 'monsters' || at.zone === 'spellTraps' ? state.players[at.seat][at.zone][at.index]! : null;
  if (filter.faceUp !== null && (!field || field.faceUp !== filter.faceUp)) return false;
  if (filter.position !== null && (at.zone !== 'monsters' || field!.position !== filter.position)) return false;
  if (field && !field.faceUp) {
    const identity = filter.types.length + filter.races.length + filter.attributes.length > 0 || filter.named !== null || filter.extraDeck !== null || filter.level || filter.atk || filter.def;
    if (identity) return false;
    if (filter.kinds.length === 0) return true;
    return at.zone === 'monsters' ? filter.kinds.includes('monster') : filter.kinds.includes('spell') && filter.kinds.includes('trap');
  }
  const card = cardOf(state, id);
  if (!identityFits(card, filter, field ? nameOf(state, id) : card.name)) return false;
  // Current stats on the field, printed ones elsewhere. ATK and DEF are only worked out when the filter asks, since an
  // effect that counts monsters by Level (Tenshin) changes ATK itself.
  const monster = at.zone === 'monsters';
  if (filter.level && !inRange(monster ? levelNow(state, id) : levelOf(card), filter.level)) return false;
  if (!filter.atk && !filter.def) return true;
  const stats = monster ? statsOf(state, id) : { atk: card.atk, def: card.def };
  return inRange(stats.atk, filter.atk) && inRange(stats.def, filter.def);
}

/**
 * Whether an effect stopped `seat` Special Summoning this card this turn (Silent Angler's "you cannot Special Summon
 * monsters from your hand"). A Token (`id` null) is stopped only by a ban on every monster.
 */
export function specialSummonForbidden(state: DuelState, seat: Seat, id: string | null): boolean {
  return state.forbidden.some(
    (f) => f.player === seat && f.what === 'special_summon' && f.turn === state.turn && (f.filter === null || (id !== null && fits(state, id, f.filter, seat))),
  );
}

/**
 * Whether a monster must be Special Summoned a certain way before any other effect may Special Summon it: an Extra
 * Deck monster (by its Synchro or Xyz Summon), or one that can't be Normal Summoned and has its own Summoning
 * procedure (Moulinglacia the Elemental Lord, Medium of the Ice Barrier).
 */
function mustBeProperlySummoned(state: DuelState, id: string): boolean {
  const code = state.instances[id]!.code;
  const sheet = state.sheets[code];
  return state.cards[code]!.extraDeck || (sheet?.normalSummon === false && sheet.effects.some((e) => e.kind === 'condition' && e.script !== null));
}

/** Why `seat` can't Special Summon this monster by an effect now, or null if they can. */
export function specialSummonProblem(state: DuelState, seat: Seat, id: string): string | null {
  const card = state.cards[state.instances[id]!.code]!;
  if (specialSummonForbidden(state, seat, id)) return `An effect stops you Special Summoning ${card.name} this turn.`;
  if (mustBeProperlySummoned(state, id) && !state.properlySummoned.includes(id)) {
    return `${card.name} must first be ${card.extraDeck ? `${card.type.startsWith('XYZ') ? 'Xyz' : 'Synchro'} Summoned` : 'Special Summoned by its own procedure'} before an effect can Special Summon it.`;
  }
  return null;
}

/** The cards a step may pick from its `choose` selection: for a Special Summon, only the monsters that can be Special Summoned. */
export function choosableFor(state: DuelState, step: Step, seat: Seat, card: string): string[] {
  if (!('cards' in step) || step.cards.from !== 'choose') return [];
  const all = chooseFrom(state, step.cards, seat, card);
  return step.do === 'special_summon' ? all.filter((id) => !specialSummonProblem(state, seat, id)) : all;
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

/** "face-up Warrior monster your opponent controls"; with `they`, as said of a player ("monster in their hand"). */
export function describeFilter(f: CardFilter, they = false): string {
  const words: string[] = [];
  if (f.faceUp !== null) words.push(f.faceUp ? 'face-up' : 'face-down');
  if (f.position) words.push(`${f.position === 'attack' ? 'Attack' : 'Defense'} Position`);
  if (f.attributes.length) words.push(f.attributes.join(' or '));
  if (f.named !== null) words.push(`"${f.named}"`);
  if (f.races.length) words.push(f.races.join(' or '));
  words.push(...f.types);
  if (f.extraDeck !== null) words.push(f.extraDeck ? 'Extra Deck' : 'Main Deck');
  const kinds = [...f.kinds].sort();
  words.push(
    kinds.length === 0 ? 'card' : kinds.join() === 'spell,trap' ? 'Spell/Trap' : kinds.map((k) => (k === 'monster' ? 'monster' : k === 'spell' ? 'Spell' : 'Trap')).join(' or '),
  );
  const range = (name: string, r: Range | null) =>
    !r ? [] : r.min !== null && r.max !== null ? (r.min === r.max ? [`${name} ${r.min}`] : [`${name} ${r.min} to ${r.max}`]) : r.max !== null ? [`${name} ${r.max} or less`] : r.min !== null ? [`${name} ${r.min} or more`] : [];
  const stats = [...range('Level', f.level), ...range('ATK', f.atk), ...range('DEF', f.def)];
  if (stats.length) words.push(`with ${stats.join(' and ')}`);
  if (f.place === 'any') return words.join(' ');
  const pile = { hand: 'hand', deck: 'Deck', graveyard: 'GY', banished: 'banished cards' }[f.place as 'hand'];
  const field = { field: 'on the field', monsters: 'in a Monster Zone', spellTraps: 'in a Spell & Trap Zone' }[f.place as 'field'];
  const [you, your] = they ? ['they control', 'their'] : ['you control', 'your'];
  if (field) words.push(f.side === 'you' ? you : f.side === 'opponent' ? `${your} opponent controls` : field);
  else words.push(f.side === 'you' ? `in ${your} ${pile}` : f.side === 'opponent' ? `in ${your} opponent's ${pile}` : `in either player's ${pile}`);
  return words.join(' ');
}

const freeMonsterZones = (state: DuelState, seat: Seat) => monsterZonesFor(state, seat, false).length;

/**
 * How many of the player's Monster Zones a cost frees: monsters it Tributes or sends from their field, so a Summon
 * paid for that way still has a zone (Turret Warrior with five monsters out).
 */
function zonesFreedBy(state: DuelState, cost: Step[], card: string): number {
  return cost.reduce((n, step) => {
    if (step.do !== 'move') return n;
    if (step.cards.from === 'self') return n + (locate(state, card)?.zone === 'monsters' ? 1 : 0);
    const f = step.cards.from === 'choose' ? step.cards.filter : null;
    return f && f.side === 'you' && (f.place === 'monsters' || (f.place === 'field' && f.kinds.join() === 'monster')) ? n + (step.cards as { min: number }).min : n;
  }, 0);
}

/**
 * Why a step couldn't do what it must on this board, or null. A `choose` with min 0 ("you can") and steps on targets
 * need nothing here. `freed` is how many Monster Zones the cost frees first.
 */
function stepProblem(state: DuelState, step: Step, seat: Seat, card: string, freed = 0): string | null {
  if (step.do === 'change_lp' && step.kind === 'cost') return state.players[seat].lp < step.amount ? `You can't pay ${step.amount} LP.` : null;
  if (step.do === 'summon_token') {
    const player = step.player === 'you' ? seat : other(seat);
    if (freeMonsterZones(state, player) + (player === seat ? freed : 0) < step.count) return `There ${step.count === 1 ? 'is no free Monster Zone' : `aren't ${step.count} free Monster Zones`} for the Token${step.count === 1 ? '' : 's'}.`;
    return specialSummonForbidden(state, seat, null) ? "An effect stops you Special Summoning this turn." : null;
  }
  if (step.do === 'negate_attack') return state.attack ? null : 'No attack is being made.';
  if (step.do === 'negate_activation') return state.chain.length > 0 ? null : 'There is no activation to negate.';
  if (step.do === 'detach') return detachFrom(state, step, seat, card).length > 0 ? null : `No ${step.cards.from === 'self' ? 'this card has' : 'monster here has'} ${step.count} Xyz Material${step.count === 1 ? '' : 's'} to detach.`;
  if (step.do === 'forbid' && step.wholeTurn) {
    const player = step.player === 'you' ? seat : other(seat);
    const did = state.didThisTurn.find((d) => d.player === player && d.what === step.what && (!step.filter || (d.card !== null && locate(state, d.card) && fits(state, d.card, step.filter, seat))));
    if (did) return { declare_attack: 'You already declared an attack this turn.', battle_phase: 'You already conducted your Battle Phase this turn.', special_summon: `You already Special Summoned ${step.filter ? `a ${describeFilter(step.filter, true)}` : 'a monster'} this turn.` }[step.what];
  }
  if (!('cards' in step)) return null;
  const sel = step.cards;
  if (step.do === 'special_summon' && freeMonsterZones(state, seat) + freed === 0) return 'You have no free Monster Zone to Special Summon into.';
  if (step.do === 'take_control' && freeMonsterZones(state, seat) + freed === 0) return 'You have no free Monster Zone to take control of a monster into.';
  if (step.do === 'special_summon' && sel.from === 'self') {
    const problem = specialSummonProblem(state, seat, card);
    if (problem) return problem;
  }
  if (step.do === 'remove_counters' && selected(state, sel, seat, card).every((id) => (onFieldCard(state, id)?.counters[step.counter] ?? 0) < step.count)) {
    return `There aren't ${step.count} ${step.counter === 'spell' ? 'Spell Counter' : 'counter'}${step.count === 1 ? '' : 's'} to remove.`;
  }
  if (sel.from === 'battling' && battling(state, sel.filter, seat, card).length === 0) return `This card isn't battling a ${describeFilter(sel.filter)}.`;
  if (sel.from === 'all' && cardsFitting(state, sel.filter, seat, card).length === 0) return `There is no ${describeFilter(sel.filter)}.`;
  if (sel.from === 'random' && cardsFitting(state, sel.filter, seat, card).length < sel.min) return `There is no ${describeFilter(sel.filter)}.`;
  if (sel.from === 'choose' && choosableFor(state, step, seat, card).length < sel.min) {
    return sel.min === 1 ? `There is no ${describeFilter(sel.filter)}.` : `There are fewer than ${sel.min} of: ${describeFilter(sel.filter)}.`;
  }
  return null;
}

/** The monster battling this card, if it fits the filter. */
export function battling(state: DuelState, filter: CardFilter, seat: Seat, card: string): string[] {
  const a = state.attack;
  const other = a?.attacker === card ? a.target : a?.target === card ? a.attacker : null;
  return other && locate(state, other)?.zone === 'monsters' && fits(state, other, filter, seat) ? [other] : [];
}

/** The cards a selection that needs no choice picks; for `choose`, every card it could pick. */
function selected(state: DuelState, sel: Selection, seat: Seat, card: string): string[] {
  switch (sel.from) {
    case 'self':
      return [card];
    case 'targets':
      return [];
    case 'choose':
      return chooseFrom(state, sel, seat, card);
    case 'all':
    case 'random':
      return cardsFitting(state, sel.filter, seat, card);
    case 'battling':
      return battling(state, sel.filter, seat, card);
  }
}

const onFieldCard = (state: DuelState, id: string) => {
  const at = locate(state, id);
  return at?.zone === 'monsters' || at?.zone === 'spellTraps' ? state.players[at.seat][at.zone][at.index]! : null;
};

/** The Xyz Monsters a detach step may take its materials from: those its selection allows that have enough. */
export function detachFrom(state: DuelState, step: Extract<Step, { do: 'detach' }>, seat: Seat, card: string): string[] {
  const sel = step.cards;
  return selected(state, sel, seat, card).filter((id) => materialsOf(state, id).length >= step.count);
}

/** The Xyz Materials attached to a monster on the field (none for any other card). */
export function materialsOf(state: DuelState, id: string): string[] {
  const at = locate(state, id);
  return at?.zone === 'monsters' ? state.players[at.seat].monsters[at.index]!.materials : [];
}

/** Why an option of a script can't be picked now (its own cost can't be paid, or a step couldn't do what it must), or null. */
function optionProblem(state: DuelState, script: Script, option: Script['options'][number], seat: Seat, card: string): string | null {
  for (const step of option.cost) {
    const problem = stepProblem(state, step, seat, card);
    if (problem) return `The cost can't be paid: ${problem}`;
  }
  const freed = zonesFreedBy(state, [...script.cost, ...option.cost], card);
  return option.steps.map((s) => stepProblem(state, s, seat, card, freed)).find((p) => p) ?? null;
}

/** The options of a script that can be picked now, by index. */
export function feasibleOptions(state: DuelState, script: Script, seat: Seat, card: string): number[] {
  return script.options.flatMap((o, i) => (optionProblem(state, script, o, seat, card) ? [] : [i]));
}

/** Whether a cost step discards or sends cards from the hand to the GY, which a `cost_substitute` card may stand in for. */
export function fromHandToGraveyard(step: Step): step is Extract<Step, { do: 'move' }> & { cards: Extract<Selection, { from: 'choose' }> } {
  return step.do === 'move' && step.to === 'graveyard' && step.cards.from === 'choose' && step.cards.filter.place === 'hand';
}

/**
 * A card in the player's GY whose `cost_substitute` effect can stand in for 1 card of a cost paid from the hand for an
 * effect of `card`, if one can now.
 */
export function costSubstitute(state: DuelState, seat: Seat, card: string): { card: string; effect: number } | null {
  for (const id of state.players[seat].graveyard) {
    const code = state.instances[id]!.code;
    const effects = state.sheets[code]?.effects ?? [];
    for (const [index, e] of effects.entries()) {
      if (e.kind !== 'continuous' || e.status === 'flagged' || e.continuous?.apply !== 'cost_substitute' || !identityFits(state.cards[state.instances[card]!.code]!, e.continuous.for)) continue;
      const used = state.usedThisTurn.some((u) => u.effect === index && (e.opt === 'hard' ? u.code === code : u.card === id));
      if (e.opt === 'none' || !used) return { card: id, effect: index };
    }
  }
  return null;
}

/** The most cards a script may target: a number, or as many as the non-Tuners used for this card's Synchro Summon. */
export function targetMax(state: DuelState, script: Script, card: string): number {
  const max = script.targets?.max ?? 0;
  if (max !== 'non_tuner_materials') return max;
  const at = locate(state, card);
  const materials = at?.zone === 'monsters' ? (state.players[at.seat].monsters[at.index]!.summoned?.materials ?? []) : [];
  return materials.filter((id) => !state.cards[state.instances[id]!.code]!.type.includes('Tuner')).length;
}

/** The cards a script may target: those that fit, and for "target that monster" only the card its event happened to. */
export function targetable(state: DuelState, script: Script, seat: Seat, card: string, cause: Happening | null): string[] {
  if (!script.targets) return [];
  const summoned = script.options.some((o) => o.steps.some((s) => s.do === 'special_summon' && s.cards.from === 'targets'));
  const fitting = cardsFitting(state, script.targets.filter, seat, script.targets.others ? card : '').filter((id) => !summoned || !specialSummonProblem(state, seat, id));
  return script.targets.event ? fitting.filter((id) => cause && cause.event !== 'phase' && id === cause.card) : fitting;
}

const phaseNames = { draw: 'Draw Phase', standby: 'Standby Phase', main1: 'Main Phase 1', battle: 'Battle Phase', main2: 'Main Phase 2', end: 'End Phase' };

/** Why a condition doesn't hold for player `seat` and their card `card`, or null if it does. */
export function conditionProblem(state: DuelState, c: Condition, seat: Seat, card: string): string | null {
  switch (c.if) {
    case 'before_battle_phase':
      return state.turnPlayer === seat && (state.phase === 'battle' || state.phase === 'main2' || state.phase === 'end') ? 'It can only be activated before you conduct your Battle Phase.' : null;
    case 'count': {
      const n = cardsFitting(state, c.filter, seat, card).length;
      if (n < c.min) return `It needs ${c.min === 1 ? 'a' : `at least ${c.min} of:`} ${describeFilter(c.filter)}.`;
      return c.max !== null && n > c.max ? `It needs ${c.max === 0 ? 'no' : `at most ${c.max} of:`} ${describeFilter(c.filter)}.` : null;
    }
    case 'phase':
      return c.phases.includes(state.phase) ? null : `It can only be activated during the ${c.phases.map((p) => phaseNames[p]).join(' or ')}.`;
    case 'turn':
      return (state.turnPlayer === seat) === (c.whose === 'you') ? null : `It only applies during ${c.whose === 'you' ? 'your' : "your opponent's"} turn.`;
    case 'position': {
      const at = locate(state, card);
      const m = at?.zone === 'monsters' ? state.players[at.seat].monsters[at.index]! : null;
      return m?.faceUp && m.position === c.position ? null : `It needs this card to be in face-up ${c.position === 'attack' ? 'Attack' : 'Defense'} Position.`;
    }
    case 'materials': {
      const n = materialsOf(state, card).length;
      if ((c.min === null || n >= c.min) && (c.max === null || n <= c.max)) return null;
      return c.max === 0 ? 'It needs this card to have no Xyz Material.' : `It needs this card to have ${c.min ?? 0}${c.max === null ? ' or more' : ` to ${c.max}`} Xyz Materials.`;
    }
    case 'outnumbered': {
      const count = (p: Seat) => [...state.players[p].monsters, ...state.players[p].spellTraps].filter((c) => c !== null).length;
      return count(other(seat)) - count(seat) >= c.by ? null : `It needs your opponent to control at least ${c.by} more cards than you.`;
    }
    case 'summoned_this_turn': {
      const at = locate(state, card);
      const summoned = at?.zone === 'monsters' ? state.players[at.seat].monsters[at.index]!.summoned : null;
      if (summoned && summoned.turn === state.turn && summonMatches(summoned.how, c.how)) return null;
      return `It needs this card to have been ${c.how.length ? `${c.how.map((h) => summonName[h]).join(' or ')} ` : ''}Summoned this turn.`;
    }
    case 'battling': {
      const a = state.attack;
      const battling = c.as === 'attacker' ? a?.attacker === card && a.target !== null : a?.target === card;
      if (battling && (!c.damageStep || a!.damageStep)) return null;
      return `It needs this card to be ${c.as === 'attacker' ? "attacking an opponent's monster" : 'the attack target'}${c.damageStep ? ' in the Damage Step' : ''}.`;
    }
    case 'last_attack': {
      const at = locate(state, card);
      const attacks = at?.zone === 'monsters' ? state.players[at.seat].monsters[at.index]!.attacks : null;
      return attacks?.turn === state.turn && attacks.on === c.on ? null : `It needs this card's last attack this turn to have been on a ${c.on === 'attack' ? 'Attack' : 'Defense'} Position monster.`;
    }
  }
}

/**
 * Why a scripted activation is illegal on this board, or null if it is legal (or the effect has no script). Judged
 * before the cost is paid: a card the cost will use can't also be one of its targets. `cause` is the event it is
 * activated for, if any.
 */
export function scriptProblem(board: DuelState, seat: Seat, card: string, effect: number, cause: Happening | null): string | null {
  const script = scriptOf(board, card, effect);
  if (!script) return null;
  // A Summoning procedure is the proper way to Summon its card, so its own Summon is never refused for not being one.
  const procedure = board.sheets[board.instances[card]!.code]!.effects[effect]!.kind === 'condition';
  const state = procedure ? { ...board, properlySummoned: [...board.properlySummoned, card] } : board;
  for (const c of script.conditions) {
    const problem = conditionProblem(state, c, seat, card);
    if (problem) return problem;
  }
  const costCards = new Set<string>();
  let costCount = 0;
  // A card in the GY may stand in for 1 card of a cost paid from the hand (Revealer of the Ice Barrier).
  let substitute = costSubstitute(state, seat, card) !== null;
  for (const original of script.cost) {
    const step = substitute && fromHandToGraveyard(original) && original.cards.min > 0 ? { ...original, cards: { ...original.cards, min: original.cards.min - 1 } } : original;
    if (step !== original) substitute = false;
    const problem = stepProblem(state, step, seat, card);
    if (problem) return `The cost can't be paid: ${problem}`;
    // A card the cost uses can't also be a target (an Xyz Monster that only loses a material still can).
    if ('cards' in step && step.cards.from === 'choose' && step.do !== 'detach') {
      for (const id of chooseFrom(state, step.cards, seat, card)) costCards.add(id);
      costCount += step.cards.min;
    }
  }
  if (script.targets) {
    const targets = targetable(state, script, seat, card, cause);
    const both = new Set([...targets, ...costCards]).size;
    if (targets.length < script.targets.min || both < script.targets.min + costCount) {
      return `There is no ${describeFilter(script.targets.filter)} to target${costCount ? ' besides the cards paid as its cost' : ''}.`;
    }
  }
  if (feasibleOptions(state, script, seat, card).length === 0) {
    const first = script.options[0] && optionProblem(state, script, script.options[0], seat, card);
    return first?.startsWith('The cost') ? first : `The effect couldn't do what it must: ${first ?? 'nothing applies.'}`;
  }
  return null;
}
