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
