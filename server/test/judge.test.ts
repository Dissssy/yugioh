import { PREMADE_DECKS } from '../src/cards.ts';
import { readFile } from 'node:fs/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { decide, evolve, fits, legalActions, replay, scriptProblem, type CardData, type CardFilter, type DuelEvent, type DuelState, type EffectSheet, type Script, type Seat, zonePick } from '@yugioh/engine';
import { rule } from '../src/judge/script.ts';
import { judge, type JudgeDeps, type ModelCall, type Question } from '../src/judge/judge.ts';
import { listSheetCodes, readSheetFiles, textHash } from '../src/sheets.ts';
import { buildBoard, CASES, runCase } from '../src/judge/evals.ts';

const monster = (code: number, name: string, atk: number): CardData => ({
  code,
  name,
  type: 'Normal Monster',
  kind: 'monster',
  extraDeck: false,
  text: '',
  level: 4,
  atk,
  def: 1000,
  attribute: 'EARTH',
  race: 'Warrior',
});
const cards: Record<number, CardData> = {
  1: monster(1, 'Axe Raider', 1700),
  2: monster(2, 'Dark Blade', 1800),
  3: { ...monster(3, 'Monster Reincarnation', 0), type: 'Spell Card', kind: 'spell', race: 'Normal', text: 'Discard 1 card, then target 1 monster in your GY; add it to your hand.' },
};
const sheets: Record<number, EffectSheet> = {
  3: {
    code: 3,
    textHash: '',
    model: 'test',
    materials: null,
    normalSummon: true,
    effects: [{ kind: 'activation', speed: 1, mandatory: false, from: 'field', opt: 'none', window: 'Your Main Phase', cost: 'Discard 1 card', effect: 'Add that target to your hand.', targets: '1 monster in your GY', when: null, script: null, continuous: null, status: 'unverified' }],
  },
};

/** Seat 0 to move in Main Phase 1 holding Monster Reincarnation (a0) and two Axe Raiders, with Dark Blade (a9) in the GY. */
function board(): DuelState {
  const instances: Record<string, { code: number; owner: Seat }> = {};
  const ids = (prefix: string, owner: Seat, codes: number[]) =>
    codes.map((code, i) => {
      instances[`${prefix}${i}`] = { code, owner };
      return `${prefix}${i}`;
    });
  const events: DuelEvent[] = [
    {
      type: 'duelStarted',
      cards,
      sheets,
      instances,
      players: [
        { name: 'Yusei', deck: ids('a', 0, [3, 1, 1, 1, 1, 1, 1, 1, 1, 2]), extra: [] },
        { name: 'Yuma', deck: ids('b', 1, [2, 2, 2, 2, 2, 2]), extra: [] },
      ],
    },
    { type: 'drew', player: 0, count: 5 },
    { type: 'drew', player: 1, count: 5 },
    { type: 'moved', card: 'a9', owner: 0, from: 'deck', to: 'graveyard' },
    { type: 'turnStarted', player: 0, turn: 1 },
    { type: 'phaseChanged', phase: 'main1' },
  ];
  return replay(events);
}

/** The board after a0 is activated into zone 0, and its chain link. */
function activated() {
  const state = board();
  const d = decide(state, 0, { type: 'activate', card: 'a0', effect: 0, zone: 0 });
  if (!d.ok) throw new Error(d.error);
  const scratch = d.events.slice(1).reduce(evolve, state);
  return { state: scratch, link: scratch.chain.at(-1)! };
}

type Call = { name: string; input: unknown };
/** A model that makes the given tool calls, one list per turn, and records what it was sent. */
function scripted(turns: Call[][]) {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let n = 0;
  const model: ModelCall = async (params) => {
    sent.push(structuredClone(params));
    const calls = turns[n++] ?? [];
    return {
      id: `msg_${n}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      stop_reason: 'tool_use',
      stop_sequence: null,
      content: calls.map((c, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name: c.name, input: c.input })),
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message;
  };
  return { model, sent };
}

const results = (params: Anthropic.MessageCreateParamsNonStreaming) => {
  const last = params.messages.at(-1)!;
  return (last.content as Anthropic.ToolResultBlockParam[]).map((r) => ({ error: !!r.is_error, content: r.content }));
};

function deps(model: ModelCall, answers: string[][] = []): JudgeDeps & { questions: Question[] } {
  const questions: Question[] = [];
  return { model, random: () => 0.5, questions, ask: async (q) => (questions.push(q), answers.shift() ?? []) };
}

describe('the judge loop', () => {
  it('pays a cost the player chooses, declares targets, and commits only on finish', async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'ask_player', input: { player: 0, prompt: 'Choose 1 card to discard.', cards: ['a1', 'a2'], choices: [], min: 1, max: 1 } }],
      [{ name: 'move', input: { card: 'a2', to: 'graveyard' } }, { name: 'ask_player', input: { player: 0, prompt: 'Choose a monster in your GY.', cards: ['a9'], choices: [], min: 1, max: 1 } }],
      [{ name: 'declare_targets', input: { cards: ['a9'] } }, { name: 'finish', input: { legal: true, summary: 'Monster Reincarnation targets Dark Blade.' } }],
    ]);
    const d = deps(model, [['a2'], ['a9']]);
    const { record, events } = await judge({ stage: 'activation', state, link }, d);
    expect(d.questions[0]).toMatchObject({ player: 0, cards: [{ id: 'a1', place: 'hand' }, { id: 'a2', place: 'hand' }], min: 1, max: 1 });
    expect(results(sent[1]!)).toEqual([{ error: false, content: '{"picked":["a2"]}' }]);
    expect(record).toMatchObject({ stage: 'activation', legal: true, error: null, summary: 'Monster Reincarnation targets Dark Blade.' });
    expect(record.ops).toEqual([{ op: 'move', card: 'a2', to: 'graveyard' }, { op: 'declare_targets', cards: ['a9'] }]);
    const after = events.reduce(evolve, state);
    expect(after.players[0].graveyard).toEqual(['a9', 'a2']);
    expect(after.chain[0]!.targets).toEqual(['a9']);
    // Haiku with reasoning off, strict tools (up to the API's 20), the rules reference cached.
    expect(sent[0]).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'high' }, tool_choice: { type: 'any' } });
    const strict = sent[0]!.tools!.filter((t) => 'strict' in t && t.strict).map((t) => ('name' in t ? t.name : ''));
    expect(strict).toEqual(expect.arrayContaining(['move', 'special_summon', 'ask_player', 'finish']));
    expect(strict.length).toBeLessThanOrEqual(20);
  });

  it('returns refused ops as errors the model can correct, skipping the rest of that turn', async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'move', input: { card: 'a9', to: 'graveyard' } }, { name: 'finish', input: { legal: true, summary: 'Done.' } }],
      [{ name: 'move', input: { card: 'a1', to: 'graveyard' } }, { name: 'ask_player', input: { player: 0, prompt: 'Choose a monster in your GY.', cards: ['a9'], choices: [], min: 1, max: 1 } }],
      [{ name: 'declare_targets', input: { cards: ['a9'] } }, { name: 'finish', input: { legal: true, summary: 'Done.' } }],
    ]);
    const { record } = await judge({ stage: 'activation', state, link }, deps(model, [['a9']]));
    expect(results(sent[1]!)).toEqual([
      { error: true, content: 'Dark Blade is already there.' },
      { error: true, content: 'Skipped: an earlier call in this turn was refused.' },
    ]);
    expect(record.legal).toBe(true);
    expect(record.ops).toEqual([{ op: 'move', card: 'a1', to: 'graveyard' }, { op: 'declare_targets', cards: ['a9'] }]);
  });

  it('refuses to rule an activation legal before its cost is paid and its targets declared', async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'ask_player', input: { player: 0, prompt: 'Activate it?', cards: [], choices: ['Yes'], min: 1, max: 1 } }],
      [{ name: 'finish', input: { legal: true, summary: 'Targets Dark Blade.' } }],
      [{ name: 'move', input: { card: 'a1', to: 'graveyard' } }, { name: 'ask_player', input: { player: 0, prompt: 'Choose a monster in your GY.', cards: ['a9'], choices: [], min: 1, max: 1 } }, { name: 'finish', input: { legal: true, summary: 'Targets Dark Blade.' } }],
      [{ name: 'declare_targets', input: { cards: ['a9'] } }, { name: 'finish', input: { legal: true, summary: 'Targets Dark Blade.' } }],
    ]);
    const { record } = await judge({ stage: 'activation', state, link }, deps(model, [['a9']]));
    expect(results(sent[1]!)[0]!.content).toMatch(/one choice/);
    expect(results(sent[2]!)[0]!.content).toMatch(/cost \("Discard 1 card"\)/);
    expect(results(sent[3]!)[2]!.content).toMatch(/haven't declared targets/);
    expect(record).toMatchObject({ legal: true, error: null });
  });

  it('holds an activation to an appeal that overturned its refusal', async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'finish', input: { legal: false, summary: 'No Warrior in the GY.' } }],
      [{ name: 'finish', input: { legal: false, summary: 'No Warrior in the GY.' } }],
    ]);
    const { record } = await judge({ stage: 'activation', state, link, appealRuling: 'Dark Blade is a legal target.' }, deps(model));
    expect(sent[0]!.messages[0]!.content).toContain('An appeal already ruled this activation legal on this board, and that ruling binds: Dark Blade is a legal target.');
    expect(results(sent[1]!)[0]!.content).toMatch(/^An appeal already ruled this activation legal/);
    expect(record).toMatchObject({ legal: false, error: 'No finish within 16 turns.' });
  });

  it('lets players choose targets only from cards that fit before the cost was paid', async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'move', input: { card: 'a1', to: 'graveyard' } }, { name: 'ask_player', input: { player: 0, prompt: 'Choose a monster in your GY.', cards: ['a1', 'a9'], choices: [], min: 1, max: 1 } }],
      [{ name: 'declare_targets', input: { cards: ['a0'] } }],
      [{ name: 'declare_targets', input: { cards: ['a9'] } }],
      [{ name: 'finish', input: { legal: false, summary: 'No target.' } }],
      [{ name: 'finish', input: { legal: false, summary: 'No target.' } }],
    ]);
    const { record, events } = await judge({ stage: 'activation', state, link }, deps(model));
    expect(results(sent[1]!)[1]!.content).toMatch(/a1 was used to pay this activation's cost/);
    expect(results(sent[2]!)[0]!.content).toMatch(/a0 is the card being activated/);
    expect(results(sent[3]!)[0]!.content).toMatch(/didn't pick a9/);
    expect(record).toMatchObject({ legal: false, summary: 'No target.' });
    expect(events).toEqual([]);
  });

  it('offers a face-down card on the field without letting the asking player see what it is', async () => {
    const { state, link } = activated();
    const set = evolve(state, { type: 'monsterSet', player: 1, card: 'b0', zone: 2 });
    const { model } = scripted([
      [{ name: 'ask_player', input: { player: 0, prompt: 'Pick one.', cards: ['b0', 'b1'], choices: [], min: 1, max: 1 } }],
      [{ name: 'ask_player', input: { player: 0, prompt: 'Pick one.', cards: ['b0', 'a9'], choices: [], min: 1, max: 1 } }],
      [{ name: 'finish', input: { legal: false, summary: 'No.' } }],
    ]);
    const d = deps(model, [['b0']]);
    await judge({ stage: 'activation', state: set, link }, d);
    expect(d.questions).toEqual([
      expect.objectContaining({
        cards: [
          { id: 'b0', place: 'monsters', seat: 1, zone: 2, hidden: true },
          { id: 'a9', place: 'graveyard', seat: 0, zone: null, hidden: false },
        ],
      }),
    ]);
  });

  it("refuses a summary or question that names a card a player can't see", async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'ask_player', input: { player: 1, prompt: 'Yusei holds Axe Raider. Pick one.', cards: ['a9'], choices: [], min: 1, max: 1 } }],
      [{ name: 'ask_player', input: { player: 1, prompt: 'Pick one.', cards: ['a1'], choices: [], min: 1, max: 1 } }],
      [{ name: 'finish', input: { legal: false, summary: 'Yusei has no Axe Raider to discard.' } }],
      [{ name: 'finish', input: { legal: false, summary: 'Not now.' } }],
    ]);
    const { record, events } = await judge({ stage: 'activation', state, link }, deps(model));
    expect(results(sent[1]!)[0]!.content).toMatch(/names Axe Raider/);
    expect(results(sent[2]!)[0]!.content).toMatch(/can't see a1/);
    expect(results(sent[3]!)[0]!.content).toMatch(/names Axe Raider/);
    expect(record).toMatchObject({ legal: false, summary: 'Not now.' });
    expect(events).toEqual([]);
  });

  it('fails safe when the model errors or never finishes', async () => {
    const { state, link } = activated();
    const broken: ModelCall = () => Promise.reject(new Error('overloaded'));
    const failed = await judge({ stage: 'activation', state, link }, deps(broken));
    expect(failed.record).toMatchObject({ legal: false, error: 'overloaded' });
    const looping = scripted(Array(20).fill([{ name: 'draw', input: { player: 0, count: 0 } }]));
    const resolving = await judge({ stage: 'resolution', state, link }, deps(looping.model));
    expect(resolving.record).toMatchObject({ legal: true, error: 'No finish within 16 turns.' });
    expect(resolving.events).toEqual([]);
  });
});

async function fixtureCards() {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/cardinfo.json', import.meta.url), 'utf8')) as {
    data: { id: number; name: string; type: string; frameType: string; desc: string; race: string; atk?: number; def?: number; level?: number; attribute?: string }[];
  };
  return Object.fromEntries(
    fixture.data.map((c): [number, CardData] => [
      c.id,
      {
        code: c.id,
        name: c.name,
        type: c.type,
        kind: c.frameType === 'spell' ? 'spell' : c.frameType === 'trap' ? 'trap' : 'monster',
        extraDeck: /^(fusion|synchro|xyz|link)/.test(c.frameType),
        text: c.desc,
        level: c.level ?? null,
        atk: c.atk ?? null,
        def: c.def ?? null,
        attribute: c.attribute ?? null,
        race: c.race,
      },
    ]),
  );
}

const anyCard = (side: CardFilter['side'], place: CardFilter['place'], kinds: CardFilter['kinds'] = []): CardFilter => ({
  side,
  place,
  kinds,
  types: [],
  races: [],
  attributes: [],
  named: null,
  extraDeck: null,
  faceUp: null,
  position: null,
  level: null,
  atk: null,
  def: null,
});
/** Monster Reincarnation as a script: discard 1 card, then target 1 monster in your GY; add it to your hand. */
const reincarnation: Script = {
  conditions: [],
  cost: [{ do: 'move', cards: { from: 'choose', filter: anyCard('you', 'hand'), min: 1, max: 1, rank: null }, to: 'graveyard' }],
  targets: { filter: anyCard('you', 'graveyard', ['monster']), min: 1, max: 1, event: false },
  options: [{ label: '', cost: [], steps: [{ do: 'move', cards: { from: 'targets' }, to: 'hand' }] }],
  unapplied: null,
};
const withScript = (state: DuelState): DuelState => ({
  ...state,
  sheets: { 3: { ...sheets[3]!, effects: [{ ...sheets[3]!.effects[0]!, script: reincarnation }] } },
});

describe('a scripted effect', () => {
  it('pays the cost, has the player pick targets that fit before it, and resolves, with no model', async () => {
    const state = withScript(board());
    expect(scriptProblem(state, 0, 'a0', 0, null)).toBeNull();
    const d = decide(state, 0, { type: 'activate', card: 'a0', effect: 0, zone: 0 });
    if (!d.ok) throw new Error(d.error);
    const scratch = d.events.slice(1).reduce(evolve, state);
    const link = scratch.chain.at(-1)!;
    const answers = [['a2'], ['a9']];
    const questions: Question[] = [];
    const ask = async (q: Question) => (questions.push(q), answers.shift()!);
    const checked = await rule({ stage: 'activation', state: scratch, link }, { model: null, ask, random: () => 0.5 });
    expect(checked.record).toMatchObject({ model: 'script', legal: true, error: null, usage: [], summary: 'Monster Reincarnation is activated, targeting Dark Blade.' });
    // The discarded Axe Raider isn't offered as a target: it wasn't in the GY before the cost was paid.
    expect(questions.map((q) => q.cards.map((c) => c.id))).toEqual([['a1', 'a2', 'a3', 'a4'], ['a9']]);
    const paid = checked.events.reduce(evolve, scratch);
    const resolved = await rule({ stage: 'resolution', state: paid, link: paid.chain.at(-1)! }, { model: null, ask, random: () => 0.5 });
    expect(resolved.record).toMatchObject({ legal: true, error: null, summary: "Dark Blade went to its owner's hand." });
    const after = resolved.events.reduce(evolve, paid);
    expect(after.players[0].hand).toContain('a9');
    expect(after.players[0].graveyard).toEqual(['a2']);
  });

  it('is not offered, and refused with a reason, when only the cost would supply its target', () => {
    // No monster in the GY: discarding an Axe Raider would put one there, but legality is judged before the cost.
    const state = withScript(evolve(board(), { type: 'moved', card: 'a9', owner: 0, from: 'graveyard', to: 'banished' }));
    expect(legalActions(state, 0).some((a) => a.type === 'activate' && a.card === 'a0')).toBe(false);
    const d = decide(state, 0, { type: 'activate', card: 'a0', effect: 0, zone: 0 });
    expect(d).toEqual({ ok: false, error: 'There is no monster in your GY to target besides the cards paid as its cost.' });
  });

  it("matches a face-down card only on what its zone shows", () => {
    const state = evolve(board(), { type: 'monsterSet', player: 1, card: 'b0', zone: 0 });
    const filter = (f: Partial<CardFilter>) => ({ ...anyCard('opponent', 'monsters'), ...f });
    expect(fits(state, 'b0', filter({ kinds: ['monster'] }), 0)).toBe(true);
    expect(fits(state, 'b0', filter({ races: ['Warrior'] }), 0)).toBe(false);
    expect(fits(state, 'b0', filter({ faceUp: true }), 0)).toBe(false);
    expect(fits(state, 'b0', filter({ side: 'you' }), 0)).toBe(false);
  });
});

describe('the eval suite', () => {
  it('runs every scripted case offline, and builds every other case on a board where code accepts the activation', async () => {
    const data = await fixtureCards();
    const sheets = await readSheetFiles(data);
    let scripted = 0;
    for (const c of CASES) {
      const state = buildBoard(c, data, sheets);
      const code = Object.values(data).find((d) => d.name === c.activate)?.code;
      // A case with no activation checks what scripted triggers did on their own.
      const effect = code === undefined ? null : sheets[code]!.effects[c.effect ?? 0]!;
      if (!effect || effect.script || effect.when) {
        // Code rules on these exactly, without a model.
        const result = await runCase(c, state, null);
        expect(result.passed, `${c.name}: ${result.detail}`).toBe(true);
        scripted++;
        continue;
      }
      const actions = legalActions(state, c.seat ?? 0);
      const offered = actions.some((a) => a.type === 'activate' && a.effect === (c.effect ?? 0) && state.cards[state.instances[a.card]!.code]!.name === c.activate);
      expect(offered, c.name).toBe(true);
    }
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    expect(scripted).toBeGreaterThanOrEqual(20);
  });

  it('scores a case from the judge calls and the board after', async () => {
    const data = await fixtureCards();
    const sheets = await readSheetFiles(data);
    const rush = CASES.find((c) => c.name === 'rush recklessly gives 700 ATK')!;
    // Without its script, so the judge rules on it.
    for (const sheet of Object.values(sheets)) sheet.effects = sheet.effects.map((e) => ({ ...e, script: null }));
    const state = buildBoard(rush, data, sheets);
    const monster = state.players[0].monsters[0]!.id;
    const { model } = scripted([
      [{ name: 'ask_player', input: { player: 0, prompt: 'Choose a target.', cards: [monster], choices: [], min: 1, max: 1 } }],
      [{ name: 'declare_targets', input: { cards: [monster] } }, { name: 'finish', input: { legal: true, summary: 'Targeting it.' } }],
      [{ name: 'modify_stats', input: { card: monster, atk: 700, def: 0, atk_set: null, def_set: null, level_delta: 0, level_set: null, until: 'end_of_turn' } }, { name: 'finish', input: { legal: true, summary: '+700.' } }],
    ]);
    expect(await runCase(rush, state, model)).toMatchObject({ name: rush.name, passed: true, detail: '+700.' });
    const lazy = scripted([
      [{ name: 'ask_player', input: { player: 0, prompt: 'Choose a target.', cards: [monster], choices: [], min: 1, max: 1 } }],
      [{ name: 'declare_targets', input: { cards: [monster] } }, { name: 'finish', input: { legal: true, summary: 'Fine.' } }],
      [{ name: 'finish', input: { legal: true, summary: 'Nothing.' } }],
    ]);
    expect(await runCase(rush, state, lazy.model)).toMatchObject({ passed: false, detail: 'ATK 900' });
  });

  it('asks the controller which empty Monster Zone a Special Summoned monster goes to', async () => {
    const data = await fixtureCards();
    const sheets = await readSheetFiles(data);
    const truth = CASES.find((c) => c.name === 'reinforce truth summons a level 2 warrior from the deck')!;
    const state = buildBoard(truth, data, sheets);
    const card = state.players[0].spellTraps.find((s) => s && data[state.instances[s.id]!.code]!.name === 'Reinforce Truth')!.id;
    const intent = decide(state, 0, { type: 'activate', card, effect: 0, zone: null });
    if (!intent.ok) throw new Error(intent.error);
    const questions: Question[] = [];
    const ask: JudgeDeps['ask'] = async (q) => {
      questions.push(q);
      if (q.zones.length) return [zonePick(3)];
      return q.cards.length ? [q.cards.find((c) => data[state.instances[c.id]!.code]!.name === 'Speed Warrior')!.id] : [q.choices[0]!];
    };
    const scratch = intent.events.slice(1).reduce(evolve, state);
    const checked = await rule({ stage: 'activation', state: scratch, link: scratch.chain.at(-1)! }, { model: null, ask, random: () => 0.5 });
    const active = checked.events.reduce(evolve, scratch);
    const resolved = await rule({ stage: 'resolution', state: active, link: active.chain.at(-1)! }, { model: null, ask, random: () => 0.5 });
    expect(resolved.record.error).toBeNull();
    expect(questions.at(-1)).toMatchObject({ player: 0, cards: [], choices: [], zones: [0, 1, 2, 3, 4], min: 1, max: 1 });
    const after = resolved.events.reduce(evolve, active);
    expect(data[after.instances[after.players[0].monsters[3]!.id]!.code]!.name).toBe('Speed Warrior');
  });
});

describe('effect sheets', () => {
  it('has a current sheet for every premade-deck card with an effect', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/cardinfo.json', import.meta.url), 'utf8')) as {
      data: { id: number; name: string; desc: string; frameType: string; card_sets?: { set_name: string }[] }[];
    };
    const starter = fixture.data.filter(
      (c) => c.frameType !== 'normal' && c.card_sets?.some((s) => PREMADE_DECKS.some((d) => d.set === s.set_name)),
    );
    const data = Object.fromEntries(starter.map((c) => [c.id, { ...cards[1]!, code: c.id, name: c.name, text: c.desc }]));
    const loaded = await readSheetFiles(data);
    expect(Object.keys(loaded).map(Number).sort()).toEqual(starter.map((c) => c.id).sort());
    expect((await listSheetCodes()).length).toBe(starter.length);
    for (const c of starter) expect(loaded[c.id]!.textHash).toBe(textHash(c.desc));
  });

  it('gives each effect the spell speed its kind and card type have', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/cardinfo.json', import.meta.url), 'utf8')) as {
      data: { id: number; name: string; desc: string; type: string; race: string }[];
    };
    const data = Object.fromEntries(fixture.data.map((c) => [c.id, { ...cards[1]!, code: c.id, name: c.name, text: c.desc }]));
    const loaded = await readSheetFiles(data);
    for (const c of fixture.data) {
      for (const [i, e] of (loaded[c.id]?.effects ?? []).entries()) {
        const activation = c.race === 'Counter' ? 3 : c.type.includes('Trap') || c.race === 'Quick-Play' ? 2 : 1;
        const expected = { activation, quick: 2, ignition: 1, trigger: 1, flip: 1, continuous: 1, condition: 1 }[e.kind];
        expect(e.speed, `${c.name} effect ${i} (${e.kind})`).toBe(expected);
      }
    }
  });
});
