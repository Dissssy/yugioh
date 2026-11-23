import type { CardData, DuelResult, EffectSheet, SeatStep } from '@yugioh/engine';
import type { Banlist, DeckList } from './decks.ts';
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

/**
 * `waiting` for an opponent, then `preparing` while both players choose their decks (docs/deck-builder.md, The pre-duel
 * stage), then `active` from rock-paper-scissors on.
 */
export type DuelStatus = 'waiting' | 'preparing' | 'active' | 'finished';

/**
 * A duel as listed in the lobby: who plays it with which deck, how it ended, and whether the viewer can take the
 * empty seat. Anyone with the link can read it; a signed-out visitor can join as a guest.
 */
export interface DuelSummary {
  id: string;
  status: DuelStatus;
  /** The banlist both decks follow. */
  banlist: string;
  /** Whether both players must bring a premade deck, changing it only by Side Deck swaps. */
  premadeOnly: boolean;
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
  /** The deck's name: the viewer's own once chosen, the opponent's once the duel starts. */
  deck: string | null;
  /** Whether the player has pressed Ready in the pre-duel stage. */
  ready: boolean;
}

/** A player's copy of a deck for one duel. Changing it changes no saved deck. */
export interface DuelDeck extends DeckList {
  name: string;
  /** Copied from a premade deck and changed only by Side Deck swaps, so its section sizes aren't checked. */
  premade: boolean;
}

/** What a player builds from in the pre-duel stage: their copy of a deck so far, and the banlist it must follow. */
export interface DuelPrep {
  deck: DuelDeck | null;
  banlist: Banlist;
}

/** The duel's copy of a deck: one of the player's decks or a premade one, or a list they built or uploaded. */
export type DuelDeckSave = { deckId: number } | ({ name: string } & DeckList);

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
  /** The banlist it's built for; null for the default list. */
  banlistId: number | null;
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
  banlistId: number | null;
  main: number[];
  extra: number[];
  side: number[];
  shared: boolean;
}

/** A banlist to pick from: a default list, or one of the viewer's own (docs/deck-builder.md, Banlists). */
export interface BanlistSummary {
  id: number;
  name: string;
  /** One of the default lists, rebuilt from YGOPRODeck on every card import. */
  isDefault: boolean;
  /** A default list's fixed name in code (`tcg`, `ocg`, `goat`, `none`); null for players' lists. */
  slug: string | null;
  /** How many cards it limits. */
  listed: number;
}

/** A banlist for anyone who may see it: a default list, its owner, or anyone with the link once shared. */
export interface BanlistDetail extends BanlistSummary {
  mine: boolean;
  shared: boolean;
  /** Copies allowed of each listed card by passcode: 0, 1 or 2. */
  limits: Record<string, number>;
}

export interface BanlistSave {
  name: string;
  limits: Record<string, number>;
  shared: boolean;
}

/** One card in the deck builder's search: every card in our database, with whether it's in the game yet. */
export interface CatalogCard extends CardData {
  archetype: string | null;
  inPool: boolean;
  /** Passcodes of the card's alternate artworks, if it has any. */
  altCodes?: number[];
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
