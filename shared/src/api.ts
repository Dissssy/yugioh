import type { CardData } from '@yugioh/engine';

// JSON shapes exchanged between the web client and the server.

export type AccountStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  id: number;
  username: string;
  status: AccountStatus;
  isAdmin: boolean;
  createdAt: string;
}

/** What the admin sees of an account: also its email, so they know who is asking to join. */
export interface AdminUser extends User {
  email: string | null;
}

/** Who is making the request. A guest is someone without an account who accepted a challenge link. */
export type Me =
  | { kind: 'anonymous' }
  | { kind: 'guest'; guest: { name: string } }
  | { kind: 'user'; user: User };

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

/** What the judge and appeals cost in one duel. */
export interface DuelCost {
  /** Judge decisions; each is one or more API calls. */
  judgeCalls: number;
  appeals: number;
  /** Estimated from the tokens used and Anthropic's list prices, in US dollars. */
  cost: number;
}

/** The admin's list of the latest duels with what each cost, and what every duel so far cost together. */
export interface AdminDuels {
  totalCost: number;
  duels: (DuelSummary & DuelCost)[];
}
