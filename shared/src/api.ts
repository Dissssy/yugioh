import type { CardData } from '@yugioh/engine';

// JSON shapes exchanged between the web client and the server.

export type AccountStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  id: number;
  email: string | null;
  name: string | null;
  status: AccountStatus;
  isAdmin: boolean;
  createdAt: string;
}

/** Who is making the request. A guest is an anonymous visitor who redeemed an invite. */
export type Me =
  | { kind: 'anonymous' }
  | { kind: 'guest'; invite: InvitePreview }
  | { kind: 'user'; user: User };

export interface Invite {
  token: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}

export interface InvitePreview {
  invitedBy: string;
  expiresAt: string;
}

/** Why an invite link can't be used. */
export type InviteProblem = 'not_found' | 'expired' | 'used';

/** A decklist to pick from. */
export interface DeckSummary {
  id: number;
  name: string;
  mainCount: number;
  extraCount: number;
}

export type DuelStatus = 'waiting' | 'active' | 'finished';

/** A duel as listed in the lobby: who is in it and whether the viewer can take the empty seat. */
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
