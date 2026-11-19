import { describe, expect, it } from 'vitest';
import { APPEAL_MODEL } from '../src/judge/appeal.ts';
import { JUDGE_MODEL } from '../src/judge/judge.ts';
import { costOf } from '../src/judge/pricing.ts';

const call = (model: string, input: number, cacheWrite: number, cacheRead: number, output: number) => ({ model, input, cacheWrite, cacheRead, output });

describe('costOf', () => {
  it('prices the judge and appeal models per million tokens', () => {
    expect(costOf([call(JUDGE_MODEL, 1e5, 0, 0, 0)])).toBeCloseTo(0.01, 10);
    expect(costOf([call(JUDGE_MODEL, 0, 1e5, 0, 1e5)])).toBeCloseTo(0.0125 + 0.05, 10);
    expect(costOf([call(APPEAL_MODEL, 1e6, 1e6, 1e6, 1e6)])).toBeCloseTo(4 + 5 + 0.2 + 20, 10);
  });

  it('charges Haiku 5.5 its long-prompt rates per call once the prompt is over 100K tokens', () => {
    expect(costOf([call(JUDGE_MODEL, 50_000, 0, 50_000, 1000)])).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01 + 1000 * 0.5) / 1e6, 10);
    expect(costOf([call(JUDGE_MODEL, 50_000, 1, 50_000, 1000)])).toBeCloseTo((50_000 * 0.5 + 0.625 + 50_000 * 0.05 + 1000 * 2.5) / 1e6, 10);
  });

  it('refuses a model it has no price for', () => {
    expect(() => costOf([call('claude-unknown', 1, 0, 0, 0)])).toThrow(/No price/);
  });
});
