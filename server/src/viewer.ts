import type { Response } from 'express';
import type { Me } from '@yugioh/shared';

/** Who is making a request, with the server-only details of a guest's invite. */
export type Viewer =
  | Exclude<Me, { kind: 'guest' }>
  | (Extract<Me, { kind: 'guest' }> & { guestToken: string; invitedById: number });

export const viewerOf = (res: Response) => res.locals.viewer as Viewer;

/** Approved accounts and guests can play; everyone else can't. */
export function playerKey(viewer: Viewer): string | null {
  if (viewer.kind === 'user') return viewer.user.status === 'approved' ? `user:${viewer.user.id}` : null;
  if (viewer.kind === 'guest') return `guest:${viewer.guestToken}`;
  return null;
}

export function displayName(viewer: Viewer): string {
  if (viewer.kind === 'user') return viewer.user.name ?? viewer.user.email ?? 'Player';
  return viewer.kind === 'guest' ? `${viewer.invite.invitedBy}'s guest` : 'Visitor';
}
