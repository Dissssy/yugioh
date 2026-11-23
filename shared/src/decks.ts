// What makes a deck legal (docs/deck-builder.md, Rules). The deck builder runs these as you build, and the server runs
// them again before a deck goes into a duel.

export type Section = 'main' | 'extra' | 'side';

export const SECTIONS: readonly Section[] = ['main', 'extra', 'side'];

/** The cards of a deck by passcode, one entry per copy. */
export interface DeckList {
  main: number[];
  extra: number[];
  side: number[];
}

/** How many cards each section may hold. */
export const SECTION_SIZE: Record<Section, { min: number; max: number }> = {
  main: { min: 40, max: 60 },
  extra: { min: 0, max: 15 },
  side: { min: 0, max: 15 },
};

export const SECTION_NAME: Record<Section, string> = { main: 'Main Deck', extra: 'Extra Deck', side: 'Side Deck' };

/** Copies of one card a deck may hold across all three sections. */
export const MAX_COPIES = 3;

/** What the rules need to know about a card. */
export interface RuleCard {
  name: string;
  /** Fusion, Synchro, Xyz and Link Monsters, which go in the Extra Deck. */
  extraDeck: boolean;
  /** Whether the card is in the game yet: in the card pool, with a working sheet (docs/card-pool.md). */
  inPool: boolean;
}

/** Where a card goes when it's added to the deck rather than the Side Deck. */
export const homeSection = (card: Pick<RuleCard, 'extraDeck'>): Section => (card.extraDeck ? 'extra' : 'main');

export const copiesIn = (deck: DeckList, code: number) =>
  SECTIONS.reduce((n, s) => n + deck[s].filter((c) => c === code).length, 0);

/** Why `card` can't be added to `section` of the deck, or null if it can. */
export function addBlocker(deck: DeckList, code: number, card: RuleCard, section: Section): string | null {
  if (!card.inPool) return 'Not in the game yet';
  if (section !== 'side' && section !== homeSection(card))
    return card.extraDeck ? 'Goes in the Extra Deck' : "Doesn't go in the Extra Deck";
  const copies = copiesIn(deck, code);
  if (copies >= MAX_COPIES) return `You have ${copies} of ${MAX_COPIES}`;
  if (deck[section].length >= SECTION_SIZE[section].max) return `${SECTION_NAME[section]} is full`;
  return null;
}

/** Everything that keeps the deck out of a duel, in plain words. An empty list means it's legal. */
export function deckProblems(deck: DeckList, cardOf: (code: number) => RuleCard | undefined): string[] {
  const problems: string[] = [];
  for (const section of SECTIONS) {
    const { min, max } = SECTION_SIZE[section];
    const n = deck[section].length;
    if (n < min) problems.push(`${SECTION_NAME[section]} has ${n} cards; it needs at least ${min}`);
    if (n > max) problems.push(`${SECTION_NAME[section]} has ${n} cards; it can hold ${max}`);
  }
  const seen = new Set<number>();
  for (const section of SECTIONS)
    for (const code of deck[section]) {
      const card = cardOf(code);
      if (!card) {
        problems.push(`Card ${code} doesn't exist`);
        continue;
      }
      if (section !== 'side' && section !== homeSection(card))
        problems.push(card.extraDeck ? `${card.name} goes in the Extra Deck` : `${card.name} doesn't go in the Extra Deck`);
      if (seen.has(code)) continue;
      seen.add(code);
      if (!card.inPool) problems.push(`${card.name} isn't in the game yet`);
      const copies = copiesIn(deck, code);
      if (copies > MAX_COPIES) problems.push(`${copies} copies of ${card.name}; at most ${MAX_COPIES}`);
    }
  return problems;
}
