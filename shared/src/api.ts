import type { CardData, DuelResult, EffectSheet, SeatStep } from '@yugioh/engine';
import type { UserSettings } from './settings.ts';

// JSON shapes exchanged between the web client and the server.

export type AccountStatus = 'pending' | 'approved' | 'rejected';

/**
 * What an account may do beyond playing. The super admin is the account whose verified email is ADMIN_EMAIL, and only
 * it can make other accounts admins. Admins approve accounts, read duel logs and edit rulings.
 */
export type Role = 'player' | 'admin' | 'superAdmin';

/** Whether a role opens the admin page. */
export const isAdmin = (role: Role) => role !== 'player';

export interface User {
  id: number;
  username: string;
  status: AccountStatus;
  role: Role;
  createdAt: string;
}

/** What the admin sees of an account: also its email, so they know who is asking to join. */
export interface AdminUser extends User {
  email: string | null;
}

/**
 * Who is making the request. A guest is someone without an account who accepted a challenge link; only accounts
 * have settings.
 */
export type Me =
  | { kind: 'anonymous' }
  | { kind: 'guest'; guest: { name: string } }
  | { kind: 'user'; user: User; settings: UserSettings };

/**
 * A decklist to pick from: a premade deck, or one of the viewer's own (docs/deck-builder.md). `problems` is what keeps
 * it out of a duel; premade decks have none.
 */
export interface DeckSummary {
  id: number;
  name: string;
  premade: boolean;
  mainCount: number;
  extraCount: number;
  sideCount: number;
  problems: string[];
}

export type DuelStatus = 'waiting' | 'active' | 'finished';

/**
 * A duel as listed in the lobby: who plays it with which deck, how it ended, and whether the viewer can take the
 * empty seat. Anyone with the link can read it; a signed-out visitor can join as a guest.
 */
export interface DuelSummary {
  id: string;
  status: DuelStatus;
  createdAt: string;
  finishedAt: string | null;
  /** Seat 0 is the challenger; seat 1 is null while the duel is waiting. */
  players: [DuelPlayer, DuelPlayer | null];
  /** Set once the duel has finished. */
  result: DuelOutcome | null;
  yourSeat: 0 | 1 | null;
  canJoin: boolean;
}

export interface DuelPlayer {
  name: string;
  deck: string;
}

/** How a duel ended: the winner (null for a draw), why, and on which turn. */
export interface DuelOutcome extends DuelResult {
  turn: number;
}

/** A finished duel to watch again (docs/next-steps.md, Replays). */
export interface Replay {
  /** The seat at the bottom of the board, or `both` for every card face up. */
  from: 0 | 1 | 'both';
  steps: SeatStep[];
}

/** A deck with its cards, for anyone who may see it: its owner, anyone with the link once shared, or anyone for a premade deck. */
export interface DeckDetail {
  id: number;
  name: string;
  premade: boolean;
  /** Whether the viewer owns it and may edit it. */
  mine: boolean;
  /** Whether anyone with the link may see it. */
  shared: boolean;
  main: CardData[];
  extra: CardData[];
  side: CardData[];
}

/** What the deck builder saves: the whole deck each time. */
export interface DeckSave {
  name: string;
  main: number[];
  extra: number[];
  side: number[];
  shared: boolean;
}

/** One card in the deck builder's search: every card in our database, with whether it's in the game yet. */
export interface CatalogCard extends CardData {
  archetype: string | null;
  inPool: boolean;
}

/** What the judge, appeals and the AI opponent cost in one duel. */
export interface DuelCost {
  /** Judge decisions; each is one or more API calls. */
  judgeCalls: number;
  appeals: number;
  /** The AI opponent's model calls (docs/ai-opponent.md). */
  aiCalls: number;
  /** Players' questions to the judge; escalations count as appeals (docs/ask-the-judge.md). */
  questions: number;
  /** Estimated from the tokens used and Anthropic's list prices, in US dollars. */
  cost: number;
}

/** The admin's list of the latest duels with what each cost, and what every duel so far cost together. */
export interface AdminDuels {
  totalCost: number;
  duels: (DuelSummary & DuelCost)[];
}

/** A player's report that a card is ruled wrongly, or an appeal that overturned one of its scripted rulings. */
export interface SheetReport {
  id: number;
  matchId: string;
  /** How many events the duel had when the report was made. */
  seq: number;
  from: 'player' | 'appeal' | 'escalation';
  note: string;
  createdAt: string;
}

/** What the admin's Rulings section lists: cards to look at, and open reports of a rule in code being wrong. */
export interface Rulings {
  cards: RulingCard[];
  engine: SheetReport[];
}

/** A card whose rulings need the admin: it has open reports, or scripts set aside for the judge. */
export interface RulingCard {
  code: number;
  name: string;
  text: string;
  sheet: EffectSheet | null;
  reports: SheetReport[];
}
