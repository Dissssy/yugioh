import type { CardData, EffectSheet } from '@yugioh/engine';
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

/** A decklist to pick from. */
export interface DeckSummary {
  id: number;
  name: string;
  mainCount: number;
  extraCount: number;
}

export type DuelStatus = 'waiting' | 'active' | 'finished';

/**
 * A duel as listed in the lobby: who is in it and whether the viewer can take the empty seat.
 * Anyone with the link can read it; a signed-out visitor can join as a guest.
 */
export interface DuelSummary {
  id: string;
  status: DuelStatus;
  createdAt: string;
  createdBy: string;
  /** Seat 0 is the challenger; seat 1 is empty while the duel is waiting. */
  decks: [string, string | null];
  yourSeat: 0 | 1 | null;
  canJoin: boolean;
}

export interface DeckDetail {
  id: number;
  name: string;
  main: CardData[];
  extra: CardData[];
}

/** What the judge, appeals and the AI opponent cost in one duel. */
export interface DuelCost {
  /** Judge decisions; each is one or more API calls. */
  judgeCalls: number;
  appeals: number;
  /** The AI opponent's model calls (docs/ai-opponent.md). */
  aiCalls: number;
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
  from: 'player' | 'appeal';
  note: string;
  createdAt: string;
}

/** A card whose rulings need the admin: it has open reports, or scripts set aside for the judge. */
export interface RulingCard {
  code: number;
  name: string;
  text: string;
  sheet: EffectSheet | null;
  reports: SheetReport[];
}
