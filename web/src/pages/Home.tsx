import type { Me } from '@yugioh/shared';
import { Duels } from './Duels.tsx';
import { Username } from './Username.tsx';

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Home({ me }: { me: Me }) {
  switch (me.kind) {
    case 'anonymous':
      return (
        <section>
          <h1>Welcome</h1>
          <p>This site is invite-only. Log in to request an account, or open a challenge link from a player to play as a guest.</p>
          <a className="button" href="/auth/login">Log in or sign up</a>
        </section>
      );
    case 'guest':
      return <Guest name={me.guest.name} />;
    case 'user': {
      const { user } = me;
      if (user.status === 'pending')
        return (
          <section>
            <h1>Waiting for approval</h1>
            <p>Your account has been created and is waiting for the admin to approve it. Check back later.</p>
            <Username user={user} />
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
          <h1>Hi {user.username}</h1>
          <Username user={user} />
          <Duels canChallenge />
        </section>
      );
    }
  }
}

function Guest({ name }: { name: string }) {
  return (
    <section>
      <h1>Hi {name}</h1>
      <p>
        You're playing as a guest. You can play any challenge someone sends you a link to, but you can't create
        challenges. Your guest access ends a day after your last duel finishes. Log in to keep your duels on an account.
      </p>
      <Duels canChallenge={false} />
    </section>
  );
}
