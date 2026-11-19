import type { Response } from 'express';
import type { Me } from '@yugioh/shared';

/** Who is making a request, with the guest's ID for the server. */
export type Viewer = Exclude<Me, { kind: 'guest' }> | (Extract<Me, { kind: 'guest' }> & { guestId: number });

export const viewerOf = (res: Response) => res.locals.viewer as Viewer;

export const userKey = (id: number) => `user:${id}`;
export const guestKey = (id: number) => `guest:${id}`;

/** Approved accounts and guests can play; everyone else can't. */
export function playerKey(viewer: Viewer): string | null {
  if (viewer.kind === 'user') return viewer.user.status === 'approved' ? userKey(viewer.user.id) : null;
  if (viewer.kind === 'guest') return guestKey(viewer.guestId);
  return null;
}

/** Guests pick any name, so it is always marked to keep it apart from the accounts' usernames. */
export const guestName = (name: string) => `${name} (guest)`;

export function displayName(viewer: Viewer): string {
  if (viewer.kind === 'user') return viewer.user.username;
  return viewer.kind === 'guest' ? guestName(viewer.guest.name) : 'Visitor';
}
