import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@yugioh/shared';
import { api } from '../api.ts';
import { Duels } from './Duels.tsx';
import { Invites } from './Invites.tsx';

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Home({ me }: { me: Me }) {
  switch (me.kind) {
    case 'anonymous':
      return (
        <section>
          <h1>Welcome</h1>
          <p>This site is invite-only. Log in to request an account, or open an invite link from a player.</p>
          <a className="button" href="/auth/login">Log in or sign up</a>
        </section>
      );
    case 'guest':
      return <Guest invitedBy={me.invite.invitedBy} expiresAt={me.invite.expiresAt} />;
    case 'user': {
      const { user } = me;
      if (user.status === 'pending')
        return (
          <section>
            <h1>Waiting for approval</h1>
            <p>Your account ({user.email ?? user.name}) has been created and is waiting for the admin to approve it. Check back later.</p>
          </section>
        );
      if (user.status === 'rejected')
        return (
          <section>
            <h1>Not approved</h1>
            <p>Your account hasn't been approved for this site.</p>
          </section>
        );
      return (
        <section>
          <h1>Hi {user.name ?? user.email}</h1>
          <Duels canChallenge />
          <Invites />
        </section>
      );
    }
  }
}

function Guest({ invitedBy, expiresAt }: { invitedBy: string; expiresAt: string }) {
  const queryClient = useQueryClient();
  const leave = useMutation({
    mutationFn: () => api('/guest/leave', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  return (
    <section>
      <h1>You're {invitedBy}'s guest</h1>
      <p>Your invite lasts until {formatDate(expiresAt)}.</p>
      <Duels canChallenge={false} />
      <button onClick={() => leave.mutate()} disabled={leave.isPending}>Leave guest access</button>
    </section>
  );
}
