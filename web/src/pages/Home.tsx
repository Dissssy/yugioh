import type { Me } from '@yugioh/shared';
import { Duels, NewChallenge } from './Duels.tsx';
import { Notice } from './Notice.tsx';

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Home({ me }: { me: Me }) {
  switch (me.kind) {
    case 'anonymous':
      return <Welcome />;
    case 'guest':
      return (
        <Dashboard title={`Hi ${me.guest.name}`}>
          <section className="box">
            <h2>Playing as a guest</h2>
            <p>
              You can play any challenge someone sends you a link to, but you can't create challenges. Your guest access
              ends a day after your last duel finishes.
            </p>
            <p className="muted small">Log in to keep your duels on an account.</p>
          </section>
        </Dashboard>
      );
    case 'user': {
      const { user } = me;
      if (user.status === 'pending')
        return (
          <Notice title="Waiting for approval">
            <p>Your account is waiting for the admin to approve it. Check back later.</p>
            <p className="muted small">Meanwhile you can pick your username from the menu under your name at the top right.</p>
          </Notice>
        );
      if (user.status === 'rejected')
        return (
          <Notice title="Not approved" tone="error">
            Your account hasn't been approved for this site.
          </Notice>
        );
      return (
        <Dashboard title={`Hi ${user.username}`}>
          <NewChallenge />
        </Dashboard>
      );
    }
  }
}

/** Two columns: things to do on the left, the viewer's duels on the right. */
function Dashboard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dashboard">
      <div className="dashboard-side">
        <h1>{title}</h1>
        {children}
      </div>
      <Duels />
    </div>
  );
}

function Welcome() {
  return (
    <section className="welcome">
      <div className="fan" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card back" style={{ '--i': i - 2 } as React.CSSProperties} />
        ))}
      </div>
      <h1>Yu-Gi-Oh Duels</h1>
      <p className="lead">Duel your friends online. The rules are handled for you, so you can just play.</p>
      <a className="button primary big" href="/auth/login">Log in or sign up</a>
      <p className="muted small">
        This site is invite-only. New accounts need the admin's approval. Got a challenge link? Open it to play as a guest.
      </p>
    </section>
  );
}
