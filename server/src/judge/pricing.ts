// What the judge and appeals cost. The only place that knows Anthropic's prices; everything else stores token
// counts (ModelUsage) and asks here for dollars, so a price change applies to past matches too.

import type Anthropic from '@anthropic-ai/sdk';
import type { ModelUsage } from '@yugioh/engine';

/** US dollars per million tokens. Cache writes are the 5-minute kind (1.25x input), the only kind the server uses. */
interface Rates {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

interface Pricing {
  rates: Rates;
  /** Rates for a call whose whole prompt (input, cache writes and cache reads) is over `above` tokens. */
  long?: { above: number; rates: Rates };
}

/** Anthropic API list prices, checked 2026-11-19. */
const PRICES: Record<string, Pricing> = {
  'claude-haiku-5-5': {
    rates: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    long: { above: 100_000, rates: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 } },
  },
  'claude-opus-5-5': { rates: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 } },
};

/** The token counts of one response to a request for `model`. */
export function usageOf(model: string, message: Anthropic.Message): ModelUsage {
  const u = message.usage;
  return {
    model,
    input: u.input_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  };
}

/** The cost in US dollars of some API calls. A model without a price here is an error, so a new model can't go uncounted. */
export function costOf(calls: ModelUsage[]): number {
  let total = 0;
  for (const c of calls) {
    const pricing = PRICES[c.model];
    if (!pricing) throw new Error(`No price for model ${c.model}; add it to pricing.ts.`);
    const prompt = c.input + c.cacheWrite + c.cacheRead;
    const r = pricing.long && prompt > pricing.long.above ? pricing.long.rates : pricing.rates;
    total += (c.input * r.input + c.cacheWrite * r.cacheWrite + c.cacheRead * r.cacheRead + c.output * r.output) / 1e6;
  }
  return total;
}
