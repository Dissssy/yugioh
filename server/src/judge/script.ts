// Runs a scripted effect (see Script in the engine's types.ts) without a model: code pays the cost, asks the player
// for every choice the card gives them, and applies the steps as ops. A scripted activation that reaches here is
// legal, since code refuses the others before they are offered. Its record joins the log like a judge's ruling, with
// the model "script", so it can be contested the same way.

import { createHash } from 'node:crypto';
import {
  applyOp,
  cardOf,
  chooseFrom,
  cardsFitting,
  describeFilter,
  evolve,
  feasibleOptions,
  fits,
  locate,
  scriptOf,
  statsOf,
  targetable,
  visibleTo,
  type DuelEvent,
  type DuelState,
  type JudgeRecord,
  type Op,
  type Selection,
  type StatValue,
  type Step,
} from '@yugioh/engine';
import { checkQuestion, judge, type JudgeCall, type JudgeDeps, type JudgeOutcome, type ModelCall } from './judge.ts';
import type { AskPlayer } from './tools.ts';

/** The `model` of a ruling made by a script. */
export const SCRIPT = 'script';

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
    const applied = applyOp(state, op, { player: seat, stage, random: deps.random });
    if (!applied.ok) throw new Refused(`${op.op} was refused: ${applied.error}`);
    state = applied.events.reduce(evolve, state);
    events.push(...applied.events);
    ops.push(op);
  };
  const ask = async (q: Omit<AskPlayer, 'player'>): Promise<string[]> => {
    const question = checkQuestion(state, { player: seat, ...q });
    if ('error' in question) throw new Refused(`A question was refused: ${question.error}`);
    const picks = await deps.ask(question);
    transcript.push({ question: q.prompt, cards: q.cards, choices: q.choices, picks });
    return picks;
  };
  /** A card's name for text both players read, or "a card" if either can't see it before or after. */
  const shown = (id: string, before: DuelState) =>
    ([0, 1] as const).every((p) => visibleTo(before, id, p)) || ([0, 1] as const).every((p) => visibleTo(state, id, p)) ? cardOf(state, id).name : 'a card';
  const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

  /** The cards a selection picks, asking the player when it is theirs to choose. */
  const select = async (sel: Selection, verb: string, limit = Infinity): Promise<string[]> => {
    if (sel.from === 'self') return locate(state, self) ? [self] : [];
    if (sel.from === 'targets') return link.targets.filter((id) => script.targets && fits(state, id, script.targets.filter, seat));
    if (sel.from === 'all') return cardsFitting(state, sel.filter, seat, self);
    const options = chooseFrom(state, sel, seat, self);
    const max = Math.min(sel.max, options.length, limit);
    if (max === 0) return [];
    // A tie-break with no tie leaves nothing to choose.
    if (sel.rank && options.length === 1 && sel.min >= 1) return options;
    const count = sel.min === max ? `${max}` : `${sel.min} to ${max}`;
    return ask({ prompt: `${name}: choose ${count} ${describeFilter(sel.filter)} to ${verb}.`, cards: options, choices: [], min: Math.min(sel.min, max), max });
  };

  /** A stat read when the step resolves: from this card, or the first target still on the field (or in a pile, for original stats). */
  const valueOf = (v: StatValue): number | null => {
    const id = v.of === 'self' ? self : link.targets.find((t) => script.targets && fits(state, t, script.targets.filter, seat));
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
        apply({ op: 'destroy', cards });
        return `${list(cards.map((id) => shown(id, before)))} ${cards.length === 1 ? 'was' : 'were'} destroyed.`;
      }
      case 'move': {
        const fromHand = step.cards.from === 'choose' && step.cards.filter.place === 'hand' && step.to === 'graveyard';
        const verb = fromHand ? 'discard' : { hand: 'add to the hand', graveyard: 'send to the GY', banished: 'banish' }[step.to as 'hand'] ?? 'return to the Deck';
        const cards = await select(step.cards, verb);
        for (const id of cards) apply({ op: 'move', card: id, to: step.to });
        if (!cards.length || cost) return null;
        const where = { hand: "to its owner's hand", graveyard: 'to the GY', banished: 'banished' }[step.to as 'hand'] ?? 'to the Deck';
        return `${list(cards.map((id) => shown(id, before)))} ${step.to === 'banished' ? 'was' : 'went'} ${where}.`;
      }
      case 'special_summon': {
        const free = state.players[seat].monsters.filter((z) => z === null).length;
        const cards = await select(step.cards, 'Special Summon', free);
        for (const id of cards.slice(0, free)) {
          const position =
            step.position !== 'choice'
              ? step.position
              : (await ask({ prompt: `${name}: Special Summon it in which position?`, cards: [], choices: ['Attack Position', 'Defense Position'], min: 1, max: 1 }))[0] === 'Defense Position'
                ? 'defense'
                : 'attack';
          apply({ op: 'special_summon', card: id, controller: seat, position });
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
      case 'extra_normal_summon':
        apply({ op: 'extra_normal_summon', player: seat });
        return `${state.players[seat].name} may conduct one more Normal Summon or Set this turn.`;
    }
  };

  try {
    if (stage === 'activation') {
      const before = state;
      for (const step of script.cost) await run(step, true);
      let summary = `${name} is activated`;
      if (script.targets) {
        const used = new Set(ops.flatMap((o) => ('cards' in o ? o.cards : 'card' in o ? [o.card] : [])));
        // Legality is judged before the cost: only cards that fit then, and weren't used to pay it, can be targeted.
        const options = targetable(before, script, seat, self, link.cause).filter((id) => !used.has(id) && fits(state, id, script.targets!.filter, seat));
        const max = Math.min(script.targets.max, options.length);
        if (options.length < script.targets.min) throw new Refused('No card left to target after the cost.');
        const count = script.targets.min === max ? `${max}` : `${script.targets.min} to ${max}`;
        // "Target that monster" leaves nothing to choose.
        const targets = script.targets.event
          ? options
          : await ask({ prompt: `${name}: choose ${count} ${describeFilter(script.targets.filter)} to target.`, cards: options, choices: [], min: script.targets.min, max });
        apply({ op: 'declare_targets', cards: targets });
        summary += `, targeting ${list(targets.map((id) => shown(id, before)))}`;
      }
      if (script.options.length > 1) {
        const labels = feasibleOptions(before, script, seat, self).map((i) => script.options[i]!.label);
        const [choice] = labels.length === 1 ? labels : await ask({ prompt: `${name}: choose an effect.`, cards: [], choices: labels, min: 1, max: 1 });
        apply({ op: 'choose_effect', choice: choice! });
        summary += ` (${choice})`;
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
