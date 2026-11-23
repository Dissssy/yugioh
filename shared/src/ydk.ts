// `.ydk` deck files (docs/deck-builder.md, Decks and sharing): the plain format most Yu-Gi-Oh! tools read and write.
// One passcode per line under `#main`, `#extra` and `!side`; lines starting with `#` are otherwise comments.

import type { DeckList } from './decks.ts';

/** A deck read from a `.ydk` file, with the passcodes it listed that no card has. */
export interface ParsedYdk extends DeckList {
  unknown: number[];
}

/**
 * Reads a `.ydk` file. `resolve` turns a passcode into the card's own passcode (files may use an alternate artwork's)
 * and says whether it goes in the Extra Deck; undefined for a passcode no card has. Main and Extra Deck cards go where
 * they belong whichever heading listed them.
 */
export function parseYdk(text: string, resolve: (code: number) => { code: number; extraDeck: boolean } | undefined): ParsedYdk {
  const deck: ParsedYdk = { main: [], extra: [], side: [], unknown: [] };
  let section: 'main' | 'extra' | 'side' = 'main';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '#main') section = 'main';
    else if (line === '#extra') section = 'extra';
    else if (line === '!side') section = 'side';
    else if (/^\d+$/.test(line)) {
      const card = resolve(Number(line));
      if (!card) deck.unknown.push(Number(line));
      else deck[section === 'side' ? 'side' : card.extraDeck ? 'extra' : 'main'].push(card.code);
    }
  }
  return deck;
}

export function toYdk(deck: DeckList): string {
  return ['#created by Yu-Gi-Oh Duels', '#main', ...deck.main, '#extra', ...deck.extra, '!side', ...deck.side, ''].join('\n');
}
