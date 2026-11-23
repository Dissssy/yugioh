// Runs a scripted effect (see Script in the engine's types.ts) without a model: code pays the cost, asks the player
// for every choice the card gives them, and applies the steps as ops. A scripted activation that reaches here is
// legal, since code refuses the others before they are offered. Its record joins the log like a judge's ruling, with
// the model "script", so it can be contested the same way.

import { createHash } from 'node:crypto';
import {
  applyOp,
  battling,
  replacement,
  cardOf,
  chooseFrom,
  specialSummonProblem,
  cardsFitting,
  describeFilter,
  detachFrom,
  evolve,
  feasibleOptions,
  fits,
  fusionMaterialOptions,
  fusionMonsters,
  fusionOf,
  fusionZones,
  zonePick,
  isProcedure,
  locate,
  materialsOf,
  monsterZonesFor,
  scriptOf,
  statsOf,
  targetable,
  targetMax,
  costSubstitute,
  fromHandToGraveyard,
  visibleTo,
  type DuelEvent,
  type DuelState,
  type JudgeRecord,
  type Op,
  type Selection,
  type StatValue,
  type Step,
} from '@yugioh/engine';
import { checkQuestion, judge, placeInto, type JudgeCall, type JudgeDeps, type JudgeOutcome, type ModelCall } from './judge.ts';
import type { AskPlayer } from './tools.ts';

const counterName = (counter: 'spell', count: number) => `${count} ${counter === 'spell' ? 'Spell Counter' : 'counter'}${count === 1 ? '' : 's'}`;

/** The `model` of a ruling made by a script. */
export const SCRIPT = 'script';
/** The `model` of a ruling nobody made, because the card needs the judge and this server has none. */
export const NO_JUDGE = 'none';
/** Whether a ruling called a model, which is what counts as a judge call. */
export const calledModel = (model: string | null) => model !== SCRIPT && model !== NO_JUDGE;

const untilText = { end_of_turn: 'until the end of the turn', end_of_battle_phase: 'until the end of the Battle Phase', next_standby_phase: 'until the next Standby Phase', while_on_field: '' };

/** Rules on an effect: by its script when it has one, else by the judge (which needs `model`). */
export function rule(call: JudgeCall, deps: Omit<JudgeDeps, 'model'> & { model: ModelCall | null }): Promise<JudgeOutcome> {
  if (scriptOf(call.state, call.link.card, call.link.effect)) return runScript(call, deps);
  if (!deps.model) throw new Error('This effect needs the judge, and no model is set up.');
  return judge(call, { ...deps, model: deps.model });
}

class Refused extends Error {}

export async function runScript(call: JudgeCall, deps: Pick<JudgeDeps, 'ask' | 'random'>): Promise<JudgeOutcome> {
  const { stage, link } = call;
  const script = scriptOf(call.state, link.card, link.effect)!;
  const seat = link.player;
  const self = link.card;
  let state = call.state;
  const events: DuelEvent[] = [];
  const ops: Op[] = [];
  /** The questions asked and the answers, kept as the record's transcript. */
  const transcript: unknown[] = [{ script }];
  const name = cardOf(state, self).name;
  const record = (fields: Pick<JudgeRecord, 'legal' | 'summary' | 'error'>): JudgeRecord => ({
    stage,
    player: seat,
    card: self,
    effect: link.effect,
    model: SCRIPT,
    promptVersion: createHash('sha256').update(JSON.stringify(script)).digest('hex').slice(0, 12),
    stateHash: createHash('sha256').update(JSON.stringify(call.state)).digest('hex'),
    transcript,
    ops,
    usage: [],
    ...fields,
  });

  const apply = (op: Op) => {
    const applied = applyOp(state, op, { player: seat, source: self, stage, random: deps.random });
    if (!applied.ok) throw new Refused(`${op.op} was refused: ${applied.error}`);
    state = applied.events.reduce(evolve, state);
    events.push(...applied.events);
    ops.push(op);
  };
  const ask = async (q: Omit<AskPlayer, 'player'>, player = seat): Promise<string[]> => {
    const question = checkQuestion(state, { player, ...q });
    if ('error' in question) throw new Refused(`A question was refused: ${question.error}`);
    const picks = await deps.ask(question);
    transcript.push({ question: q.prompt, cards: q.cards, choices: q.choices, picks });
    return picks;
  };
  /** A card's name for text both players read, or "a card" if either can't see it before or after. */
  const shown = (id: string, before: DuelState) =>
    ([0, 1] as const).every((p) => visibleTo(before, id, p)) || ([0, 1] as const).every((p) => visibleTo(state, id, p)) ? cardOf(state, id).name : 'a card';
  const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

  /** Targets an earlier step of this effect Special Summoned or took control of: still its targets ("Special Summon it, and if you do, equip this card to it"). */
  const movedHere = new Set<string>();
  /** The cards a selection picks, asking the player when it is theirs to choose. */
  const select = async (sel: Selection, verb: string, limit = Infinity, keep: (id: string) => boolean = () => true): Promise<string[]> => {
    if (sel.from === 'self') return locate(state, self) ? [self] : [];
    if (sel.from === 'targets') return link.targets.filter((id) => movedHere.has(id) || (script.targets && fits(state, id, script.targets.filter, seat)));
    if (sel.from === 'all') return cardsFitting(state, sel.filter, seat, self);
    if (sel.from === 'battling') return battling(state, sel.filter, seat, self);
    if (sel.from === 'random') {
      const pool = cardsFitting(state, sel.filter, seat, self);
      const picked: string[] = [];
      while (pool.length > 0 && picked.length < Math.min(sel.count, limit)) picked.push(...pool.splice(Math.floor(deps.random() * pool.length), 1));
      transcript.push({ random: picked });
      return picked;
    }
    const options = chooseFrom(state, sel, seat, self).filter(keep);
    const max = Math.min(sel.max, options.length, limit);
    if (max === 0) return [];
    // A tie-break with no tie leaves nothing to choose.
    if (sel.rank && options.length === 1 && sel.min >= 1) return options;
    const count = sel.min === max ? `${max}` : `${sel.min} to ${max}`;
    return ask({ prompt: `${name}: choose ${count} ${describeFilter(sel.filter)} to ${verb}.`, cards: options, choices: [], min: Math.min(sel.min, max), max });
  };

  /** The cards the cost moved, first moved first, for a stat read from the cost. */
  const paid: string[] = [];
  /** The cards the last move step moved, for a pledge about "the added monster". */
  let moved: string[] = [];
  /** Whether a `cost_substitute` card already stood in for part of this cost. */
  let substituted = false;
  /** A stat read when the step resolves: from this card, the first target still on the field (or in a pile, for original stats), or the first card paid as the cost. */
  const valueOf = (v: StatValue): number | null => {
    const id = v.of === 'self' ? self : v.of === 'cost' ? paid[0] : link.targets.find((t) => script.targets && fits(state, t, script.targets.filter, seat));
    if (!id || !locate(state, id)) return null;
    const printed = cardOf(state, id)[v.stat];
    const at = locate(state, id)!;
    const base = v.original ? printed : at.zone === 'monsters' ? statsOf(state, id)[v.stat] : printed;
    return base === null ? null : Math.round(base * v.times);
  };

  /** Applies one step; returns a sentence on what happened, or null if it did nothing. */
  const run = async (step: Step, cost: boolean): Promise<string | null> => {
    const before = state;
    switch (step.do) {
      case 'destroy': {
        const cards = (await select(step.cards, 'destroy')).filter((id) => ['monsters', 'spellTraps'].includes(locate(state, id)!.zone));
        if (!cards.length) return null;
        // A monster that can detach materials instead (Gachi Gachi Gantetsu): its controller decides.
        const kept: string[] = [];
        for (const id of cards) {
          const count = replacement(state, id);
          if (count === null) continue;
          const owner = locate(state, id)!.seat;
          const label = cardOf(state, id).name;
          const [answer] = await ask({ prompt: `${label} would be destroyed. Detach ${count} Xyz Material${count === 1 ? '' : 's'} instead?`, cards: [], choices: ['Detach instead', 'Let it be destroyed'], min: 1, max: 1 }, owner);
          if (answer !== 'Detach instead') continue;
          const attached = materialsOf(state, id);
          const picked =
            attached.length === count ? attached : await ask({ prompt: `${label}: choose ${count} Xyz Material${count === 1 ? '' : 's'} to detach.`, cards: attached, choices: [], min: count, max: count }, owner);
          for (const m of picked) apply({ op: 'detach', card: m });
          kept.push(id);
        }
        const lost = cards.filter((id) => !kept.includes(id));
        if (lost.length) apply({ op: 'destroy', cards: lost });
        const said = kept.map((id) => `${shown(id, before)} detached Xyz Material instead of being destroyed.`);
        if (lost.length) said.unshift(`${list(lost.map((id) => shown(id, before)))} ${lost.length === 1 ? 'was' : 'were'} destroyed.`);
        return said.join(' ');
      }
      case 'move': {
        const fromHand = step.cards.from === 'choose' && step.cards.filter.place === 'hand' && step.to === 'graveyard';
        const verb = fromHand ? 'discard' : { hand: 'add to the hand', graveyard: 'send to the GY', banished: 'banish' }[step.to as 'hand'] ?? 'return to the Deck';
        let sel = step.cards;
        // A card in the GY may be banished instead of 1 card of a cost from the hand (Revealer of the Ice Barrier).
        const sub = cost && !substituted && fromHandToGraveyard(step) ? costSubstitute(state, seat, self) : null;
        if (sub && fromHandToGraveyard(step)) {
          const short = chooseFrom(state, step.cards, seat, self).length < step.cards.min;
          const banish = `Banish ${cardOf(state, sub.card).name} from your GY instead of 1 of them`;
          const [pick] = short ? [banish] : await ask({ prompt: `${name}: pay the cost from your hand, or ${banish.toLowerCase()}?`, cards: [], choices: ['Pay from your hand', banish], min: 1, max: 1 });
          if (pick === banish) {
            apply({ op: 'substitute_cost', card: sub.card, effect: sub.effect });
            substituted = true;
            sel = { ...step.cards, min: Math.max(0, step.cards.min - 1), max: Math.max(0, step.cards.max - 1) };
          }
        }
        const cards = await select(sel, verb);
        for (const id of cards) apply({ op: 'move', card: id, to: step.to });
        moved = cards;
        if (cost) paid.push(...cards);
        if (!cards.length || cost) return null;
        const where = { hand: "to its owner's hand", graveyard: 'to the GY', banished: 'banished' }[step.to as 'hand'] ?? 'to the Deck';
        return `${list(cards.map((id) => shown(id, before)))} ${step.to === 'banished' ? 'was' : 'went'} ${where}.`;
      }
      case 'special_summon': {
        const free = monsterZonesFor(state, seat, false).length;
        const cards = await select(step.cards, 'Special Summon', free, (id) => !specialSummonProblem(state, seat, id));
        for (const id of cards.slice(0, free)) {
          const position =
            step.position !== 'choice'
              ? step.position
              : (await ask({ prompt: `${name}: Special Summon it in which position?`, cards: [], choices: ['Attack Position', 'Defense Position'], min: 1, max: 1 }))[0] === 'Defense Position'
                ? 'defense'
                : 'attack';
          const placed = await placeInto(state, { op: 'special_summon', card: id, controller: seat, position, banish_when_leaves: step.banishWhenLeaves }, { player: seat, source: self, stage, random: deps.random }, deps.ask);
          if (!placed.ok) throw new Refused(`special_summon was refused: ${placed.error}`);
          if (placed.picks) transcript.push({ question: 'Monster Zone', picks: placed.picks });
          apply(placed.op);
          movedHere.add(id);
        }
        return cards.length ? `${list(cards.slice(0, free).map((id) => shown(id, before)))} ${cards.length === 1 ? 'was' : 'were'} Special Summoned.` : null;
      }
      case 'modify_stats': {
        const cards = (await select(step.cards, 'apply this to')).filter((id) => {
          const at = locate(state, id);
          return at?.zone === 'monsters' && state.players[at.seat].monsters[at.index]!.faceUp;
        });
        for (const id of cards) {
          apply({ op: 'modify_stats', card: id, atk: step.atk, def: step.def, atk_set: null, def_set: null, level_delta: step.levelDelta, level_set: step.levelSet, until: step.until });
        }
        if (!cards.length) return null;
        const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
        const parts = [step.atk && `${signed(step.atk)} ATK`, step.def && `${signed(step.def)} DEF`, step.levelDelta && `${signed(step.levelDelta)} Level`, step.levelSet !== null && `Level ${step.levelSet}`].filter(Boolean);
        return `${list(cards.map((id) => shown(id, before)))}: ${parts.join(', ')}${untilText[step.until] ? ` ${untilText[step.until]}` : ''}.`;
      }
      case 'set_stats': {
        const cards = (await select(step.cards, 'apply this to')).filter((id) => {
          const at = locate(state, id);
          return at?.zone === 'monsters' && state.players[at.seat].monsters[at.index]!.faceUp;
        });
        const atk = step.atk && valueOf(step.atk);
        const def = step.def && valueOf(step.def);
        // A stat read from a target that is gone can't be applied.
        if ((step.atk && atk === null) || (step.def && def === null)) return null;
        for (const id of cards) apply({ op: 'modify_stats', card: id, atk: 0, def: 0, atk_set: atk ?? null, def_set: def ?? null, level_delta: 0, level_set: null, until: step.until });
        if (!cards.length) return null;
        const parts = [atk !== null && atk !== undefined && `ATK became ${atk}`, def !== null && def !== undefined && `DEF became ${def}`].filter(Boolean);
        return `${list(cards.map((id) => shown(id, before)))}: ${parts.join(', ')}${untilText[step.until] ? ` ${untilText[step.until]}` : ''}.`;
      }
      case 'gain_stats': {
        const cards = (await select(step.cards, 'apply this to')).filter((id) => {
          const at = locate(state, id);
          return at?.zone === 'monsters' && state.players[at.seat].monsters[at.index]!.faceUp;
        });
        const atk = step.atk ? (valueOf(step.atk) ?? 0) : 0;
        const def = step.def ? (valueOf(step.def) ?? 0) : 0;
        if (!cards.length || (atk === 0 && def === 0)) return null;
        for (const id of cards) apply({ op: 'modify_stats', card: id, atk, def, atk_set: null, def_set: null, level_delta: 0, level_set: null, until: step.until });
        const parts = [atk && `${atk > 0 ? '+' : ''}${atk} ATK`, def && `${def > 0 ? '+' : ''}${def} DEF`].filter(Boolean);
        return `${list(cards.map((id) => shown(id, before)))}: ${parts.join(', ')}${untilText[step.until] ? ` ${untilText[step.until]}` : ''}.`;
      }
      case 'change_position': {
        const changed: string[] = [];
        for (const id of await select(step.cards, 'change the battle position of')) {
          const at = locate(state, id);
          if (at?.zone !== 'monsters') continue;
          const m = state.players[at.seat].monsters[at.index]!;
          const position = step.position === 'switch' ? (m.position === 'attack' ? 'defense' : 'attack') : step.position;
          if (m.faceUp && m.position === position) continue;
          apply({ op: 'change_position', card: id, position });
          changed.push(id);
        }
        return changed.length ? `${list(changed.map((id) => shown(id, before)))} changed battle position.` : null;
      }
      case 'take_control': {
        const taken: string[] = [];
        for (const id of await select(step.cards, 'take control of', monsterZonesFor(state, seat, false).length)) {
          const at = locate(state, id);
          if (at?.zone !== 'monsters' || at.seat === seat) continue;
          const placed = await placeInto(state, { op: 'take_control', card: id, controller: seat, until: step.until }, { player: seat, source: self, stage, random: deps.random }, deps.ask);
          if (!placed.ok) throw new Refused(`take_control was refused: ${placed.error}`);
          if (placed.picks) transcript.push({ question: 'Monster Zone', picks: placed.picks });
          apply(placed.op);
          taken.push(id);
          movedHere.add(id);
        }
        return taken.length ? `${state.players[seat].name} took control of ${list(taken.map((id) => shown(id, before)))}${step.until === 'end_phase' ? ' until the End Phase' : ''}.` : null;
      }
      case 'arrange_top': {
        const top = state.players[seat].deck.slice(0, step.count);
        if (!top.length) return null;
        // The cards are shown only to the player who looks, as the options of the question; the rest stay on top in order.
        const prompt = step.bottom
          ? `${name}: the top of the Deck. Pick the cards to put on the bottom; the rest go back on top.`
          : `${name}: the top of the Deck. Pick none to put them back.`;
        const picked = await ask({ prompt, cards: top, choices: [], min: 0, max: top.length });
        const bottom = step.bottom ? top.filter((id) => picked.includes(id)) : [];
        for (const id of bottom) apply({ op: 'move', card: id, to: 'deck_bottom' });
        const looked = `${state.players[seat].name} looked at the top ${top.length === 1 ? 'card' : `${top.length} cards`} of their Deck`;
        return `${looked}${bottom.length ? ` and put ${bottom.length === 1 ? 'one' : bottom.length} on the bottom` : ''}.`;
      }
      case 'summon_token': {
        const player = step.player === 'you' ? seat : seat === 0 ? 1 : 0;
        const count = Math.min(step.count, monsterZonesFor(state, player, false).length);
        for (let i = 0; i < count; i++) {
          const position =
            step.position !== 'choice'
              ? step.position
              : (await ask({ prompt: `${name}: Special Summon ${step.token.name} in which position?`, cards: [], choices: ['Attack Position', 'Defense Position'], min: 1, max: 1 }))[0] === 'Defense Position'
                ? 'defense'
                : 'attack';
          const placed = await placeInto(state, { op: 'summon_token', controller: player, token: step.token, position }, { player: seat, source: self, stage, random: deps.random }, deps.ask);
          if (!placed.ok) throw new Refused(`summon_token was refused: ${placed.error}`);
          if (placed.picks) transcript.push({ question: 'Monster Zone', picks: placed.picks });
          apply(placed.op);
        }
        return count ? `${state.players[player].name} Special Summoned ${count === 1 ? `1 ${step.token.name}` : `${count} ${step.token.name}s`}.` : null;
      }
      case 'change_lp': {
        const player = step.player === 'you' ? seat : seat === 0 ? 1 : 0;
        apply({ op: 'change_lp', player, amount: step.amount, kind: step.kind });
        const who = state.players[player].name;
        return cost ? null : step.kind === 'gain' ? `${who} gained ${step.amount} LP.` : `${who} took ${step.amount} damage.`;
      }
      case 'draw': {
        const player = step.player === 'you' ? seat : seat === 0 ? 1 : 0;
        apply({ op: 'draw', player, count: step.count });
        return `${state.players[player].name} drew ${step.count} card${step.count === 1 ? '' : 's'}.`;
      }
      case 'negate_attack':
        if (!state.attack) return null;
        apply({ op: 'negate_attack' });
        return 'The attack was negated.';
      case 'detach': {
        const from = detachFrom(state, step, seat, self);
        if (!from.length) return null;
        const [xyz] = from.length === 1 ? from : await ask({ prompt: `${name}: detach ${step.count} Xyz Material${step.count === 1 ? '' : 's'} from which Xyz Monster?`, cards: from, choices: [], min: 1, max: 1 });
        const attached = materialsOf(state, xyz!);
        const picked =
          attached.length === step.count
            ? attached
            : await ask({ prompt: `${name}: choose ${step.count} Xyz Material${step.count === 1 ? '' : 's'} to detach.`, cards: attached, choices: [], min: step.count, max: step.count });
        for (const id of picked) apply({ op: 'detach', card: id });
        return cost ? null : `${list(picked.map((id) => shown(id, before)))} ${picked.length === 1 ? 'was' : 'were'} detached from ${shown(xyz!, before)}.`;
      }
      case 'link': {
        const [monster] = (await select(step.cards, 'equip it to')).filter((id) => locate(state, id)?.zone === 'monsters');
        // A card that left the field (or was flipped face-down) in the chain links to nothing; the rest still applies.
        const at = locate(state, self);
        if (!monster || at?.zone !== 'spellTraps' || !state.players[at.seat].spellTraps[at.index]!.faceUp) return null;
        apply({ op: 'link', card: monster });
        return `${name} ${cardOf(state, self).race === 'Equip' ? 'was equipped to' : 'now applies to'} ${shown(monster, before)}.`;
      }
      case 'negate_activation': {
        const cause = link.cause?.event === 'activated' ? link.cause : null;
        const answered = cause && state.chain[cause.link];
        if (!answered || answered.card !== cause.card || answered.negated) return null;
        apply({ op: 'negate_activation', card: cause.card });
        const where = locate(state, cause.card)?.zone;
        const destroyed = step.destroy && (where === 'monsters' || where === 'spellTraps');
        if (destroyed) apply({ op: 'destroy', cards: [cause.card] });
        return `The activation of ${shown(cause.card, before)} was negated${destroyed ? ', and it was destroyed' : ''}.`;
      }
      case 'negate_effects': {
        const cards = (await select(step.cards, 'negate the effects of')).filter((id) => {
          const at = locate(state, id);
          return at?.zone === 'monsters' && state.players[at.seat].monsters[at.index]!.faceUp;
        });
        for (const id of cards) apply({ op: 'negate_effects', card: id });
        return cards.length ? `${list(cards.map((id) => shown(id, before)))} ${cards.length === 1 ? 'has its' : 'have their'} effects negated.` : null;
      }
      case 'fusion_summon': {
        const monsters = fusionMonsters(state, seat, step.from);
        if (!monsters.length) return null;
        const [fusion] = await ask({ prompt: `${name}: choose a Fusion Monster to Fusion Summon.`, cards: monsters, choices: [], min: 1, max: 1 });
        const fusionName = cardOf(state, fusion!).name;
        const needed = fusionOf(state, fusion!)!.materials.length;
        const materials: string[] = [];
        while (materials.length < needed) {
          const options = fusionMaterialOptions(state, seat, fusion!, step.from, materials);
          const [pick] = await ask({ prompt: `${name}: choose Fusion Material ${materials.length + 1} of ${needed} for ${fusionName}.`, cards: options, choices: [], min: 1, max: 1 });
          materials.push(pick!);
        }
        const [position] = await ask({ prompt: `${name}: Fusion Summon ${fusionName} in which position?`, cards: [], choices: ['Attack Position', 'Defense Position'], min: 1, max: 1 });
        const zones = fusionZones(state, seat, materials);
        let zone = zones[0];
        if (zones.length > 1) {
          const picks = await deps.ask({ player: seat, text: `${fusionName}: choose a Monster Zone for it.`, cards: [], choices: [], zones, min: 1, max: 1 });
          transcript.push({ question: 'Monster Zone', picks });
          zone = zones.find((z) => zonePick(z) === picks[0]);
        }
        if (zone === undefined) throw new Refused('No Monster Zone was picked.');
        apply({ op: 'fusion_summon', card: fusion!, materials, from: step.from, zone, position: position === 'Defense Position' ? 'defense' : 'attack' });
        return `${fusionName} was Fusion Summoned, using ${list(materials.map((id) => shown(id, before)))}.`;
      }
      case 'set_again':
        apply({ op: 'set_again' });
        return `${name} will be Set again.`;
      case 'add_counters': {
        const counted: string[] = [];
        for (const id of await select(step.cards, 'place counters on')) {
          const at = locate(state, id);
          const c = at && (at.zone === 'monsters' || at.zone === 'spellTraps') ? state.players[at.seat][at.zone][at.index]! : null;
          if (!c?.faceUp || (step.max !== null && (c.counters[step.counter] ?? 0) >= step.max)) continue;
          apply({ op: 'add_counters', card: id, counter: step.counter, count: step.count, max: step.max });
          counted.push(id);
        }
        return counted.length ? `${list(counted.map((id) => shown(id, before)))} got ${counterName(step.counter, step.count)}.` : null;
      }
      case 'remove_counters': {
        const [id] = await select(step.cards, 'remove counters from', 1);
        if (!id) return null;
        apply({ op: 'remove_counters', card: id, counter: step.counter, count: step.count });
        return `${counterName(step.counter, step.count)} removed from ${shown(id, before)}.`;
      }
      case 'forbid': {
        const player = step.player === 'you' ? seat : seat === 0 ? 1 : 0;
        apply({ op: 'forbid', player, what: step.what, filter: step.filter });
        const what = { battle_phase: 'conduct their Battle Phase', declare_attack: 'declare an attack', special_summon: `Special Summon ${step.filter ? `a ${describeFilter(step.filter, true)}` : 'monsters'}` }[step.what];
        return `${state.players[player].name} can't ${what} this turn.`;
      }
      case 'lock': {
        apply({ op: 'lock', player: step.player, filter: step.filter, until: step.until, while_face_up: step.whileFaceUp });
        const who = step.player === 'both' ? 'Neither player can' : `${state.players[step.player === 'you' ? seat : seat === 0 ? 1 : 0]!.name} can't`;
        const what = step.filter ? `${describeFilter(step.filter)}s` : 'cards';
        return `${who} activate ${what} until the End Phase${step.until === 'your_next_end_phase' ? ` of ${state.players[seat]!.name}'s next turn` : ''}.`;
      }
      case 'pledge_normal_summon': {
        if (!moved.length) return null;
        apply({ op: 'pledge_normal_summon', player: seat, cards: moved, damage: step.damage });
        return `${state.players[seat].name} takes ${step.damage} damage in the End Phase unless they Normal Summon the added monster, or a card with the same name, this turn.`;
      }
      case 'extra_normal_summon':
        apply({ op: 'extra_normal_summon', player: seat });
        return `${state.players[seat].name} may conduct one more Normal Summon or Set this turn.`;
    }
  };

  try {
    // A Summoning procedure doesn't start a chain: its cost and steps happen at once.
    if (isProcedure(state, self, link.effect)) {
      for (const step of script.cost) await run(step, true);
      const said: string[] = [];
      for (const step of script.options[0]!.steps) {
        const line = await run(step, false);
        if (line) said.push(line);
      }
      if (!locate(state, self) || locate(state, self)!.zone !== 'monsters') throw new Refused('The procedure made no Summon.');
      const how = paid.length ? ` by ${{ graveyard: 'sending', banished: 'banishing' }[locate(state, paid[0]!)!.zone as 'graveyard'] ?? 'using'} ${list(paid.map((id) => shown(id, call.state)))}` : '';
      return { record: record({ legal: true, summary: [`${name} was Special Summoned by its own procedure${how}.`, ...said.slice(1)].join(' '), error: null }), events };
    }
    if (stage === 'activation') {
      const before = state;
      let summary = `${name} is activated`;
      // The effect is picked first, since a bullet can have its own cost.
      let option = script.options[0]!;
      if (script.options.length > 1) {
        const labels = feasibleOptions(before, script, seat, self).map((i) => script.options[i]!.label);
        const [choice] = labels.length === 1 ? labels : await ask({ prompt: `${name}: choose an effect.`, cards: [], choices: labels, min: 1, max: 1 });
        apply({ op: 'choose_effect', choice: choice! });
        option = script.options.find((o) => o.label === choice)!;
        summary += ` (${choice})`;
      }
      for (const step of [...script.cost, ...option.cost]) await run(step, true);
      if (script.targets) {
        const used = new Set(ops.flatMap((o) => ('cards' in o ? o.cards : 'card' in o ? [o.card] : [])));
        // Legality is judged before the cost: only cards that fit then, and weren't used to pay it, can be targeted.
        const options = targetable(before, script, seat, self, link.cause).filter((id) => !used.has(id) && fits(state, id, script.targets!.filter, seat));
        const max = Math.min(targetMax(before, script, self), options.length);
        if (options.length < script.targets.min) throw new Refused('No card left to target after the cost.');
        const count = script.targets.min === max ? `${max}` : `${script.targets.min} to ${max}`;
        // "Target that monster" leaves nothing to choose.
        const targets = script.targets.event
          ? options
          : await ask({ prompt: `${name}: choose ${count} ${describeFilter(script.targets.filter)} to target.`, cards: options, choices: [], min: script.targets.min, max });
        apply({ op: 'declare_targets', cards: targets });
        summary += `, targeting ${list(targets.map((id) => shown(id, before)))}`;
      }
      return { record: record({ legal: true, summary: `${summary}.`, error: null }), events };
    }
    const option = script.options.find((o) => o.label === link.choice) ?? script.options[0]!;
    const said: string[] = [];
    for (const step of option.steps) {
      const line = await run(step, false);
      if (line) said.push(line);
    }
    if (said.length === 0) said.push(`${name} resolved, but there was nothing left for it to affect.`);
    if (script.unapplied) said.push(`Not applied in this version: ${script.unapplied}`);
    return { record: record({ legal: true, summary: said.join(' '), error: null }), events };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    // A script that can't run is a bug in its sheet: nothing happens, and the record says why.
    const summary = stage === 'activation' ? `${name} could not be activated.` : `${name} could not be resolved, so it did nothing.`;
    return { record: record({ legal: stage === 'resolution', summary, error: e.message }), events: [] };
  }
}
