// What the AI opponent reads. Built only from its seat's view and log (and the public deck lists), so nothing hidden
// from that seat can reach the model. The prefix is the same from call to call so the prompt cache holds it: the rules,
// then the decks, then the duel log one entry per block (it only grows), and only the board and options after that.

import type Anthropic from '@anthropic-ai/sdk';
import type { CardData, CardView, FieldCardView, JudgingView, LogEntry, PlayerSideView, PlayerView } from '@yugioh/engine';
import { describeStats, zoneName } from './moves.ts';

export const SYSTEM = `You are Claude, playing a Yu-Gi-Oh! TCG duel on a website against a person. Play to win, under the official rules.

How this site works:
- Code knows the rules of the game (phases, summons, battle, chains, timing) and lists every move you may make right now. You answer with the number of one of them. You make one move per answer; you will be asked again for the next one.
- A Normal Summon puts the monster face-up in attack position; a Set puts it face-down in defense position. Use the position you want it in.
- Card effects are ruled by a judge. Activating an effect only starts it: the judge (or the card's script) checks whether it can be activated, pays its costs and resolves it, and may ask you questions along the way (a target, a card to discard). Answer those by number too.
- After you summon, attack or activate, your opponent may get a chance to respond, and you may get one after theirs. A window where you hold nothing to respond with is passed for you.
- The duel log shows everything you have seen happen, oldest first, with each entry's number (#) and the turn (T). Cards you can't see (your opponent's hand, their Set cards, any Deck) are never named.
- Your notes: with every answer you write a short note to yourself (plans, what you know about your opponent's Set cards and hand). The latest note is shown to you next time.

How to play well:
- Read your cards' text in your deck list. Check what is on the field before attacking: a face-down monster may have high DEF, and Set Spells/Traps may be responses.
- Count LP: if you can win this turn, do it.
- Keep in mind the moves you have already made this turn (the log shows them).
- Pass when you have nothing useful to do in a response window; end your turn when you have nothing left to gain.

Answer with JSON only:
- reason: one or two sentences on why.
- choice (for a move) or picks (for a question): the number(s) of what you pick.
- note: your note to yourself for the next call, one or two sentences.`;

/** A decklist with each card's text, one line per card. */
function deckList(title: string, main: CardData[], extra: CardData[]): string {
  const line = (c: CardData) => {
    const stats = c.kind === 'monster' ? ` | ${c.attribute ?? ''} ${c.race}${c.level !== null ? `, Level ${c.level}` : ''}, ATK ${c.atk ?? '?'} / DEF ${c.def ?? '?'}` : ` | ${c.race}`;
    return `- ${c.name} (${c.type}${stats}): ${c.text.replace(/\s+/g, ' ')}`;
  };
  return [`## ${title}`, `Main Deck (${main.length} cards):`, ...main.map(line), `Extra Deck (${extra.length} cards):`, ...extra.map(line)].join('\n');
}

export interface Decks {
  mine: { name: string; main: CardData[]; extra: CardData[] };
  theirs: { name: string; main: CardData[]; extra: CardData[] };
}

export function decksText(d: Decks): string {
  return [
    '# The decks',
    deckList(`Your deck: ${d.mine.name}`, d.mine.main, d.mine.extra),
    '',
    deckList(`Your opponent's deck: ${d.theirs.name} (a public premade deck; you don't know their hand or their Deck order)`, d.theirs.main, d.theirs.extra),
  ].join('\n');
}

const PHASES = { draw: 'Draw Phase', standby: 'Standby Phase', main1: 'Main Phase 1', battle: 'Battle Phase', main2: 'Main Phase 2', end: 'End Phase' };

const cardName = (c: CardView) => ('id' in c ? c.card.name : 'a face-down card');

function fieldCard(f: FieldCardView): string {
  if (!('id' in f.card)) return `face-down card${f.position === 'defense' ? ' in defense position' : ''}`;
  const name = `${f.card.card.name}${f.faceUp ? '' : ' (face-down, Set by you)'}`;
  const extra = [
    f.stats && describeStats(f),
    f.materials.length ? `Xyz Materials: ${f.materials.map(cardName).join(', ')}` : '',
    f.spellCounters ? `${f.spellCounters} Spell Counters` : '',
  ].filter(Boolean);
  return extra.length ? `${name} (${extra.join('; ')})` : name;
}

function side(p: PlayerSideView, label: string, own: boolean): string {
  const zones = (list: (FieldCardView | null)[]) =>
    list.map((f, i) => (f ? `${zoneName(i)}: ${fieldCard(f)}` : null)).filter(Boolean).join('; ') || 'empty';
  return [
    `## ${label}: ${p.name}, ${p.lp} LP`,
    `Hand (${p.hand.length}): ${own ? p.hand.map(cardName).join(', ') || 'none' : `${p.hand.length} cards you can't see`}`,
    `Monster Zones: ${zones(p.monsters)}`,
    `Spell & Trap Zones: ${zones(p.spellTraps)}`,
    `GY: ${p.graveyard.map(cardName).join(', ') || 'empty'}`,
    `Banished: ${p.banished.map(cardName).join(', ') || 'none'}`,
    `Deck: ${p.deckCount} cards. Extra Deck: ${own ? p.extra.map(cardName).join(', ') || 'empty' : `${p.extra.length} cards`}`,
  ].join('\n');
}

/** The board as the AI's seat sees it. */
export function boardText(view: PlayerView): string {
  const me = view.you;
  const them = me === 0 ? 1 : 0;
  const whose = (seat: number) => (seat === me ? 'your' : "your opponent's");
  return [
    '# The board now',
    `Turn ${view.turn}, ${whose(view.turnPlayer)} turn, ${PHASES[view.phase]}.${view.turnPlayer === me && view.normalSummonUsed ? ' You have used your Normal Summon this turn.' : ''}`,
    side(view.players[me], 'You', true),
    side(view.players[them], 'Your opponent', false),
    view.chain.length
      ? `Chain (first link first): ${view.chain.map((l, i) => `${i + 1}. ${whose(l.player)} ${cardName(l.card)}`).join('; ')}`
      : 'The chain is empty.',
    view.waiting?.cause ? `Waiting on: ${view.waiting.for === 'respond' ? 'a response to' : view.waiting.for === 'triggers' ? 'triggers for' : 'a choice for'} ${view.waiting.cause}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The log as content blocks, one per entry, so each call finds the previous call's cached prefix. */
export function logBlocks(log: LogEntry[]): Anthropic.TextBlockParam[] {
  const lines = log.filter((e) => e.text !== null).map((e) => ({ type: 'text' as const, text: `#${e.seq} T${e.turn} ${e.text}` }));
  return [{ type: 'text', text: '# The duel log so far' }, ...lines];
}

/** What the call asks: a move from the numbered list, or the answer to a judge question. */
export function askText(view: PlayerView, note: string, ask: { moves: string[] } | { judging: JudgingView; options: string[] }): string {
  const parts = [boardText(view), `# Your note from last time\n${note || '(none yet)'}`];
  if ('moves' in ask) {
    parts.push(`# Your moves\nPick one by its number (the "choice" field).\n${ask.moves.map((m, i) => `${i + 1}. ${m}`).join('\n')}`);
  } else {
    const p = ask.judging.prompt!;
    const card = cardName(ask.judging.card);
    const stage = ask.judging.stage === 'activation' ? 'activating' : 'resolving';
    const count = p.min === p.max ? `exactly ${p.min}` : `between ${p.min} and ${p.max}`;
    parts.push(
      `# A question from the judge\nThe judge is ${stage} ${card} and asks you: ${p.text}\nPick ${count} of these by number (the "picks" field).\n${ask.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`,
    );
  }
  return parts.join('\n\n');
}
