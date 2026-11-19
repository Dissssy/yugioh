// What each player is allowed to see. Hidden cards are sent without an ID or card data, so nothing leaks to the browser.

import { waitingFor } from './chain.ts';
import { legalActions, normalSummonUsed } from './rules.ts';
import { statsOf } from './continuous.ts';
import { evolve, locate, replay } from './state.ts';
import type { CardView, DuelEvent, DuelState, FieldCard, FieldCardView, Hand, LogEntry, LogEvent, Phase, Place, PlayerView, Seat, StartView } from './types.ts';

export function viewFor(state: DuelState, seat: Seat): PlayerView {
  const shown = (id: string): CardView => ({ id, card: state.cards[state.instances[id]!.code]! });
  const hidden: CardView = { hidden: true };
  const field = (owner: Seat, monsters: boolean) => (c: FieldCard | null): FieldCardView | null =>
    c && {
      card: c.faceUp || owner === seat ? shown(c.id) : hidden,
      position: c.position,
      faceUp: c.faceUp,
      stats: monsters && c.faceUp ? statsOf(state, c.id) : null,
      materials: c.materials.map(shown),
    };
  const deckList = [
    ...new Set(Object.values(state.instances).filter((i) => i.owner === seat).map((i) => i.code)),
  ].sort((a, b) => a - b);

  return {
    you: seat,
    deckList,
    turn: state.turn,
    turnPlayer: state.turnPlayer,
    phase: state.phase,
    normalSummonUsed: normalSummonUsed(state),
    result: state.result,
    players: ([0, 1] as const).map((owner) => {
      const p = state.players[owner];
      const mine = owner === seat;
      return {
        name: p.name,
        lp: p.lp,
        deckCount: p.deck.length,
        hand: p.hand.map((id) => (mine ? shown(id) : hidden)),
        monsters: p.monsters.map(field(owner, true)),
        spellTraps: p.spellTraps.map(field(owner, false)),
        graveyard: p.graveyard.map(shown),
        banished: p.banished.map(shown),
        extra: p.extra.map((id) => (mine ? shown(id) : hidden)),
      };
    }) as PlayerView['players'],
    chain: state.chain.map((link) => ({ player: link.player, card: shown(link.card), effect: link.effect, targets: link.targets, choice: link.choice })),
    waiting: waitingFor(state, seat),
    start: startFor(state, seat),
    actions: legalActions(state, seat),
  };
}

/** Rock-paper-scissors as `seat` sees it: never the opponent's pick before both are shown. */
function startFor(state: DuelState, seat: Seat): StartView | null {
  const step = state.step;
  if (step.at === 'rps') return { at: 'rps', yours: step.picks[seat], theirsIn: step.picks[seat === 0 ? 1 : 0] !== null, last: step.last };
  if (step.at === 'order') return { at: 'order', chooser: step.chooser, hands: step.hands };
  return null;
}

/** The whole duel log as one player sees it. */
export function logFor(events: readonly DuelEvent[], seat: Seat): LogEntry[] {
  let state = replay(events.slice(0, 1));
  return events.flatMap((event, seq) => {
    if (seq > 0) state = evolve(state, event);
    const entry = entryFor(state, event, seq, state.turn, seat);
    return entry ? [entry] : [];
  });
}

/** One event as a log entry for one player, or null for events players never see. `state` is the state right after the event. */
export function entryFor(state: DuelState, event: DuelEvent, seq: number, turn: number, seat: Seat): LogEntry | null {
  const visible = visibleEvent(state, event, seat);
  return visible && { seq, turn, event: visible, text: describe(state, visible) };
}

/**
 * The whole duel with nothing hidden, one line per event, for reviewing it afterwards. Only for admins: it names
 * every hidden card. Cards are written `Name [instance ID]` so a line can be matched with intents and rulings.
 */
export function reviewLog(events: readonly DuelEvent[]): { seq: number; turn: number; text: string }[] {
  let state = replay(events.slice(0, 1));
  return events.map((event, seq) => {
    if (seq > 0) state = evolve(state, event);
    return { seq, turn: state.turn, text: reviewText(state, event) };
  });
}

function reviewText(state: DuelState, event: DuelEvent): string {
  const who = (seat: Seat) => state.players[seat].name;
  const label = (id: string) => {
    const instance = state.instances[id];
    return instance ? `${state.cards[instance.code]!.name} [${id}]` : id;
  };
  /** JSON with every card ID labelled. */
  const labelled = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'string' && state.instances[v] ? label(v) : v));
  switch (event.type) {
    case 'duelStarted':
      return `Duel started: ${event.players[0].name} (seat 0) vs ${event.players[1].name} (seat 1)`;
    case 'rpsPicked':
      return `${who(event.player)} picked ${event.hand}`;
    case 'intent':
      return `${who(event.player)} asked for ${labelled(event.intent)}`;
    case 'deckShuffled':
      return `${who(event.player)}'s Deck was shuffled`;
    case 'monsterSet':
    case 'spellTrapSet':
      return `${who(event.player)} Set ${label(event.card)} in zone ${event.zone}`;
    case 'moved':
      return `${label(event.card)} moved from ${who(event.owner)}'s ${event.from} to ${event.to}`;
    case 'phaseChanged':
      return phaseNames[event.phase];
    case 'flippedByAttack':
      return `${label(event.card)} was flipped face-up by the attack`;
    case 'linkResolved':
      return 'The chain link resolved';
    case 'checkpoint':
      return `Checkpoint: triggers, then a response window${event.cause ? ` for ${event.cause.event}` : ''}, then ${event.then.do}`;
    case 'triggersDone':
      return 'Triggers done';
    case 'passed':
      return `${who(event.player)} passed`;
    case 'attackEnded':
      return event.replay ? 'The attack ended in a replay' : 'The attack ended';
    case 'attackDeclared':
      return `${label(event.attacker)} attacked ${event.target ? label(event.target) : 'directly'}`;
    case 'judged': {
      const r = event.record;
      const outcome = r.stage === 'activation' ? (r.legal ? 'allowed' : 'REFUSED') : 'resolved';
      return [
        `Judge (${r.stage}, ${r.model}) on ${who(r.player)}'s ${label(r.card)}, effect ${r.effect}: ${outcome}. ${r.summary}`,
        r.error && `Error: ${r.error}`,
        r.ops.length > 0 && `Ops: ${labelled(r.ops)}`,
      ]
        .filter(Boolean)
        .join(' | ');
    }
    case 'sheetUpdated':
      return `The effect sheet of ${state.cards[event.code]?.name ?? event.code} changed: ${labelled(event.sheet)}`;
    case 'appealed': {
      const a = event.appeal;
      const note = a.note ? ` with the note "${a.note}"` : '';
      return `Appeal (${a.model}) by ${who(a.by)} of ruling #${a.judged}${note}: ${a.verdict}. ${a.explanation} | Correct ruling: ${a.ruling}`;
    }
    default:
      return describe(state, event)!;
  }
}

/** Places both players can see into. */
const PUBLIC: Place[] = ['monsters', 'spellTraps', 'materials', 'graveyard', 'banished'];

/** Whether a card is visible to `seat` where it is now. */
export function visibleTo(state: DuelState, id: string, seat: Seat): boolean {
  const at = locate(state, id);
  if (!at) return false;
  if (at.zone === 'graveyard' || at.zone === 'banished' || at.zone === 'materials') return true;
  if (at.zone === 'monsters' || at.zone === 'spellTraps') return at.seat === seat || state.players[at.seat][at.zone][at.index]!.faceUp;
  return at.zone !== 'deck' && at.seat === seat;
}

function visibleEvent(state: DuelState, event: DuelEvent, seat: Seat): LogEvent | null {
  switch (event.type) {
    case 'duelStarted':
    case 'intent':
    case 'rpsPicked':
    case 'deckShuffled':
    case 'sheetUpdated':
    case 'checkpoint':
    case 'triggersDone':
    case 'passed':
    case 'attackEnded':
      return null;
    case 'moved': {
      // A card moving between places this player can't see (Deck to hand, say) stays anonymous.
      const seen = event.owner === seat || PUBLIC.includes(event.from) || visibleTo(state, event.card, seat);
      return { ...event, card: seen ? event.card : null };
    }
    case 'judged': {
      const r = event.record;
      // A refused activation from the hand never revealed the card to the opponent, so they see nothing.
      if (!r.legal && r.player !== seat && !visibleTo(state, r.card, seat)) return null;
      return {
        type: 'judged',
        stage: r.stage,
        player: r.player,
        card: visibleTo(state, r.card, seat) || r.player === seat ? r.card : null,
        legal: r.legal,
        summary: r.summary,
        failed: r.error !== null,
      };
    }
    case 'appealed': {
      const { judged, by, verdict, explanation } = event.appeal;
      return { type: 'appealed', judged, by, verdict, explanation };
    }
    case 'monsterSet':
    case 'spellTrapSet':
      return event.player === seat ? event : { ...event, card: null };
    case 'attackDeclared': {
      const at = event.target === null ? null : locate(state, event.target);
      return { ...event, targetZone: at?.zone === 'monsters' ? at.index : null };
    }
    default:
      return event;
  }
}

const phaseNames: Record<Phase, string> = {
  draw: 'Draw Phase',
  standby: 'Standby Phase',
  main1: 'Main Phase 1',
  battle: 'Battle Phase',
  main2: 'Main Phase 2',
  end: 'End Phase',
};

/** One line for the duel log, written so it reveals nothing hidden from either player. */
function describe(state: DuelState, event: LogEvent): string | null {
  const who = (seat: Seat) => state.players[seat].name;
  const name = (id: string) => state.cards[state.instances[id]!.code]!.name;
  const names = (ids: string[]) => ids.map(name).join(', ');
  const hand = (h: Hand) => h[0]!.toUpperCase() + h.slice(1);
  switch (event.type) {
    case 'rpsShown': {
      const [a, b] = event.hands;
      const picks = `${who(0)} threw ${hand(a)}, ${who(1)} threw ${hand(b)}`;
      return event.winner === null ? `Rock-paper-scissors: ${picks}. A tie, so they pick again.` : `Rock-paper-scissors: ${picks}. ${who(event.winner)} wins.`;
    }
    case 'orderChosen':
      return `${who(event.player)} chose to go ${event.first === event.player ? 'first' : 'second'}`;
    case 'turnStarted':
      return `Turn ${event.turn}: ${who(event.player)}`;
    case 'phaseChanged':
      return event.phase === 'battle' || event.phase === 'main2' ? phaseNames[event.phase] : null;
    case 'drew':
      return `${who(event.player)} drew ${event.count === 1 ? 'a card' : `${event.count} cards`}`;
    case 'tributed':
      return `${who(event.player)} tributed ${names(event.cards)}`;
    case 'normalSummoned':
      return `${who(event.player)} Normal Summoned ${name(event.card)}`;
    case 'monsterSet':
      return `${who(event.player)} Set a monster`;
    case 'spellTrapSet':
      return `${who(event.player)} Set a Spell or Trap`;
    case 'flipSummoned':
      return `${who(event.player)} Flip Summoned ${name(event.card)}`;
    case 'positionChanged':
      return `${who(event.player)} changed ${name(event.card)} to ${event.position} position`;
    case 'attackDeclared':
      // A face-down target is flipped by the very next event, so naming it here reveals nothing early.
      return `${name(event.attacker)} attacked ${event.target ? name(event.target) : 'directly'}`;
    case 'battleDamage':
      return `${who(event.player)} took ${event.amount} damage`;
    case 'destroyedByBattle':
      return `${names(event.cards)} destroyed by battle`;
    case 'discarded':
      return `${who(event.player)} discarded ${names(event.cards)}`;
    case 'duelEnded': {
      const { winner, reason } = event.result;
      if (winner === null) return 'The duel ended in a draw';
      const loser = who(winner === 0 ? 1 : 0);
      const why = { lp: `${loser}'s LP reached 0`, deckOut: `${loser} couldn't draw`, surrender: `${loser} surrendered` }[reason];
      return `${who(winner)} won: ${why}`;
    }
    case 'judged':
      return event.summary;
    case 'appealed':
      return `Appeal ${event.verdict === 'upheld' ? 'upheld the ruling' : 'overturned the ruling'}: ${event.explanation}`;
    case 'effectActivated':
      return `${who(event.player)} activated ${name(event.card)}`;
    case 'targeted':
      return `Targeting ${names(event.cards)}`;
    case 'effectChosen':
      return `Chose: ${event.choice}`;
    case 'moved': {
      const to = { hand: 'to the hand', deck_top: 'on top of the Deck', deck_bottom: 'to the bottom of the Deck', deck_shuffled: 'into the Deck', graveyard: 'to the GY', banished: 'banished' }[event.to];
      const from = { deck: 'Deck', hand: 'hand', monsters: 'field', spellTraps: 'field', materials: 'Xyz Materials', graveyard: 'GY', banished: 'banished cards', extra: 'Extra Deck' }[event.from];
      return `${event.card ? name(event.card) : `${who(event.owner)}'s card`} from the ${from} ${to}`;
    }
    case 'specialSummoned':
      return `${who(event.player)} Special Summoned ${name(event.card)} in ${event.position} position`;
    case 'extraSummoned':
      return `${who(event.player)} ${event.how === 'synchro' ? 'Synchro' : 'Xyz'} Summoned ${name(event.card)} in ${event.position} position, using ${names(event.materials)}`;
    case 'destroyed':
      return `${names(event.cards)} destroyed`;
    case 'lpChanged':
      return event.kind === 'gain'
        ? `${who(event.player)} gained ${event.amount} LP`
        : `${who(event.player)} ${event.kind === 'cost' ? 'paid' : 'took'} ${-event.amount} ${event.kind === 'cost' ? 'LP' : 'damage'}`;
    case 'statsModified': {
      const m = event.modifier;
      const parts = [
        m.atkSet !== null ? `ATK became ${m.atkSet}` : '',
        m.defSet !== null ? `DEF became ${m.defSet}` : '',
        m.atk ? `${m.atk > 0 ? '+' : ''}${m.atk} ATK` : '',
        m.def ? `${m.def > 0 ? '+' : ''}${m.def} DEF` : '',
        m.levelSet !== null ? `Level ${m.levelSet}` : '',
        m.levelDelta ? `${m.levelDelta > 0 ? '+' : ''}${m.levelDelta} Level` : '',
      ].filter(Boolean);
      return `${name(m.card)}: ${parts.join(', ')}`;
    }
    case 'normalSummonGranted':
      return `${who(event.player)} may Normal Summon again this turn`;
    case 'chatted':
      return `${who(event.player)}: ${event.text}`;
    case 'flippedByAttack':
    case 'linkResolved':
      return null;
  }
}
