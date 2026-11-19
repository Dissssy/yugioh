import { readFile } from 'node:fs/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { decide, evolve, legalActions, replay, type CardData, type DuelEvent, type DuelState, type EffectSheet, type Seat } from '@yugioh/engine';
import { judge, type JudgeDeps, type ModelCall, type Question } from '../src/judge/judge.ts';
import { listSheetCodes, loadSheets, textHash } from '../src/sheets.ts';
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
    verified: true,
    model: 'test',
    materials: null,
    effects: [{ kind: 'activation', speed: 1, mandatory: false, opt: 'none', window: 'Your Main Phase', cost: 'Discard 1 card', effect: 'Add that target to your hand.', targets: '1 monster in your GY' }],
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
      first: 0,
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
      [{ name: 'move', input: { card: 'a2', to: 'graveyard' } }, { name: 'declare_targets', input: { cards: ['a9'] } }],
      [{ name: 'finish', input: { legal: true, summary: 'Monster Reincarnation targets Dark Blade.' } }],
    ]);
    const d = deps(model, [['a2']]);
    const { record, events } = await judge({ stage: 'activation', state, link }, d);
    expect(d.questions[0]).toMatchObject({ player: 0, cards: [{ id: 'a1', place: 'hand' }, { id: 'a2', place: 'hand' }], min: 1, max: 1 });
    expect(results(sent[1]!)).toEqual([{ error: false, content: '{"picked":["a2"]}' }]);
    expect(record).toMatchObject({ stage: 'activation', legal: true, error: null, summary: 'Monster Reincarnation targets Dark Blade.' });
    expect(record.ops).toEqual([{ op: 'move', card: 'a2', to: 'graveyard' }, { op: 'declare_targets', cards: ['a9'] }]);
    const after = events.reduce(evolve, state);
    expect(after.players[0].graveyard).toEqual(['a9', 'a2']);
    expect(after.chain[0]!.targets).toEqual(['a9']);
    // Haiku with reasoning off, strict tools, the rules reference cached.
    expect(sent[0]).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'high' }, tool_choice: { type: 'any' } });
    expect(sent[0]!.tools!.every((t) => 'strict' in t && t.strict)).toBe(true);
  });

  it('returns refused ops as errors the model can correct, skipping the rest of that turn', async () => {
    const { state, link } = activated();
    const { model, sent } = scripted([
      [{ name: 'move', input: { card: 'a9', to: 'graveyard' } }, { name: 'finish', input: { legal: true, summary: 'Done.' } }],
      [{ name: 'move', input: { card: 'a1', to: 'graveyard' } }, { name: 'finish', input: { legal: true, summary: 'Done.' } }],
    ]);
    const { record } = await judge({ stage: 'activation', state, link }, deps(model));
    expect(results(sent[1]!)).toEqual([
      { error: true, content: 'Dark Blade is already there.' },
      { error: true, content: 'Skipped: an earlier call in this turn was refused.' },
    ]);
    expect(record.legal).toBe(true);
    expect(record.ops).toEqual([{ op: 'move', card: 'a1', to: 'graveyard' }]);
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

describe('the eval suite', () => {
  it('builds every case on a board where code accepts the activation', async () => {
    const data = await fixtureCards();
    const sheets = await loadSheets(data);
    for (const c of CASES) {
      const state = buildBoard(c, data, sheets);
      const actions = legalActions(state, 0);
      const offered = actions.some((a) => a.type === 'activate' && state.cards[state.instances[a.card]!.code]!.name === c.activate);
      expect(offered, c.name).toBe(true);
    }
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  it('scores a case from the judge calls and the board after', async () => {
    const data = await fixtureCards();
    const sheets = await loadSheets(data);
    const rush = CASES.find((c) => c.name === 'rush recklessly gives 700 ATK')!;
    const state = buildBoard(rush, data, sheets);
    const monster = state.players[0].monsters[0]!.id;
    const { model } = scripted([
      [{ name: 'ask_player', input: { player: 0, prompt: 'Choose a target.', cards: [monster], choices: [], min: 1, max: 1 } }],
      [{ name: 'declare_targets', input: { cards: [monster] } }, { name: 'finish', input: { legal: true, summary: 'Targeting it.' } }],
      [{ name: 'modify_stats', input: { card: monster, atk: 700, def: 0, level_delta: 0, level_set: null, until: 'end_of_turn' } }, { name: 'finish', input: { legal: true, summary: '+700.' } }],
    ]);
    expect(await runCase(rush, state, model)).toEqual({ name: rush.name, passed: true, detail: '+700.' });
    const lazy = scripted([[{ name: 'finish', input: { legal: true, summary: 'Fine.' } }], [{ name: 'finish', input: { legal: true, summary: 'Nothing.' } }]]);
    expect(await runCase(rush, state, lazy.model)).toMatchObject({ passed: false, detail: 'ATK 900' });
  });
});

describe('effect sheets', () => {
  it('has a current sheet for every starter-deck card with an effect', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/cardinfo.json', import.meta.url), 'utf8')) as {
      data: { id: number; name: string; desc: string; frameType: string; card_sets?: { set_name: string }[] }[];
    };
    const starter = fixture.data.filter(
      (c) => c.frameType !== 'normal' && c.card_sets?.some((s) => /^Starter Deck: (Yu-Gi-Oh! 5D's|Dawn of the Xyz)$/.test(s.set_name)),
    );
    const data = Object.fromEntries(starter.map((c) => [c.id, { ...cards[1]!, code: c.id, name: c.name, text: c.desc }]));
    const loaded = await loadSheets(data);
    expect(Object.keys(loaded).map(Number).sort()).toEqual(starter.map((c) => c.id).sort());
    expect((await listSheetCodes()).length).toBe(starter.length);
    for (const c of starter) expect(loaded[c.id]!.textHash).toBe(textHash(c.desc));
  });
});
