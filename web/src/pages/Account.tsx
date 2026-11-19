import type { Me, UserSettings } from '@yugioh/shared';
import { Link } from 'react-router';
import { errorText } from '../api.ts';
import { useSaveSettings, useSettings } from '../settings.ts';
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
      <section className="box">
        <h2>Duels</h2>
        <OpponentCardsSetting />
      </section>
    </div>
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
