import { useMutation } from '@tanstack/react-query';
import type { Logins, Me, UserSettings } from '@yugioh/shared';
import { Link, useSearchParams } from 'react-router';
import { api, errorText, useDiscordLogin } from '../api.ts';
import { inActivity } from '../discord.ts';
import { useSaveSettings, useSettings } from '../settings.ts';
import { NotifySetting } from '../notify.tsx';
import { Notice } from './Notice.tsx';
import { Username } from './Username.tsx';

/** The account's username and settings. */
export function Account({ me }: { me: Me }) {
  if (me.kind !== 'user')
    return (
      <Notice title="No account" action={<Link className="button" to="/">Back home</Link>}>
        Log in to have a username and settings. Guests play with the default settings.
      </Notice>
    );
  return (
    <div className="account">
      <h1>Account</h1>
      <section className="box">
        <h2>Profile</h2>
        <p className="muted small">The only name other players see. Change it as often as you like.</p>
        <Username user={me.user} />
      </section>
      <LoginsSection logins={me.logins} />
      <section className="box">
        <h2>Duels</h2>
        <OpponentCardsSetting />
        <NotifySetting />
      </section>
    </div>
  );
}

/**
 * The account's logins, and buttons to add the missing one (docs/discord.md). Linking joins two accounts into one:
 * the website login's account stays, unless only the Discord one is approved, and the other's decks and duels move.
 */
function LoginsSection({ logins }: { logins: Logins }) {
  const [params] = useSearchParams();
  const discordOn = useDiscordLogin().data;
  const link = useMutation({
    mutationFn: (to: 'discord' | 'auth0') => api<{ url: string }>(`/me/link/${to}`, { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const linkError = params.get('linkError');
  if (!discordOn && !logins.discord) return null;

  return (
    <section className="box">
      <h2>Logins</h2>
      <p className="muted small">
        Log in either way to reach the same account. Adding a login that already has its own account joins the two: your
        decks and duels from both are kept.
      </p>
      <dl className="logins">
        <dt>Website login</dt>
        <dd>
          {logins.auth0 ? (
            'Added'
          ) : inActivity ? (
            <span className="muted small">Open the website and log in with Discord there to add it.</span>
          ) : (
            <button onClick={() => link.mutate('auth0')} disabled={link.isPending}>Add website login</button>
          )}
        </dd>
        <dt>Discord</dt>
        <dd>{logins.discord ? 'Added' : <button onClick={() => link.mutate('discord')} disabled={link.isPending}>Add Discord</button>}</dd>
      </dl>
      {(link.isError || linkError) && <p className="error small">{link.isError ? errorText(link.error) : linkError}</p>}
    </section>
  );
}

const opponentCardsOptions: { value: UserSettings['opponentCards']; label: string }[] = [
  { value: 'faceThem', label: 'Face your opponent, like across a real table' },
  { value: 'faceYou', label: 'Face you' },
];

/** Which way the opponent's cards on the field point. Saved to the account as soon as it changes. */
export function OpponentCardsSetting() {
  const { opponentCards } = useSettings();
  const save = useSaveSettings();
  return (
    <fieldset className="setting">
      <legend>Opponent's cards on the field</legend>
      {opponentCardsOptions.map((o) => (
        <label key={o.value}>
          <input
            type="radio"
            name="opponentCards"
            checked={opponentCards === o.value}
            onChange={() => save.mutate({ opponentCards: o.value })}
          />{' '}
          {o.label}
        </label>
      ))}
      {save.isError && <span className="error small">{errorText(save.error)}</span>}
    </fieldset>
  );
}
