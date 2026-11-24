import { useSearchParams } from 'react-router';
import { useDiscordLogin } from '../api.ts';

/** The ways to log in: the website's own login (Auth0) or Discord. Both come back to the page that sent the visitor. */
export function Login() {
  const [params] = useSearchParams();
  const returnTo = encodeURIComponent(params.get('returnTo') ?? '/');
  const discord = useDiscordLogin();
  return (
    <section className="notice box login">
      <h1>Log in or sign up</h1>
      <a className="button primary big" href={`/auth/login?returnTo=${returnTo}`}>Log in</a>
      {discord.data && <a className="button big" href={`/auth/discord/login?returnTo=${returnTo}`}>Log in with Discord</a>}
      <p className="muted small">
        New accounts need the admin's approval. If you already have an account, log in the way you did before; you can add
        the other login from your account page.
      </p>
    </section>
  );
}
