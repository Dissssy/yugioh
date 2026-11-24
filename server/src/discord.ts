// Signing in from inside the Discord Activity (docs/discord.md). Discord's login alone proves only who someone is,
// and anyone can run it against our app outside Discord. So the server also asks Discord, with the app's bot token,
// whether that person is in a running copy of the Activity, and where it runs, since only servers an admin trusts approve.

const API = 'https://discord.com/api/v10';

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
}

export interface DiscordUser {
  id: string;
  username: string;
}

/**
 * A running copy of the Activity: the Discord user IDs in it, and where it runs, as `guild:<server id>` or, in a DM or
 * group DM, `dm:<channel id>`.
 */
export interface ActivityInstance {
  users: string[];
  place: string;
}

/** The calls the server makes to Discord. Tests replace them. */
export interface DiscordApi {
  clientId: string;
  /** Where the website sends someone to log in with Discord; Discord comes back to `redirectUri` with a code. */
  authorizeUrl(state: string, redirectUri: string): string;
  /**
   * Trades a code for an access token: from the Activity's `authorize`, or with the `redirectUri` it was issued for
   * from the website's login. Null when Discord refuses the code.
   */
  exchangeCode(code: string, redirectUri?: string): Promise<string | null>;
  user(accessToken: string): Promise<DiscordUser>;
  /** Who is in a running Activity instance, and where it runs. Null when no such instance is running. */
  instance(instanceId: string): Promise<ActivityInstance | null>;
}

async function call<T>(path: string, init: RequestInit, missing?: number): Promise<T | null> {
  const res = await fetch(`${API}${path}`, init);
  if (res.status === missing) return null;
  if (!res.ok) throw new Error(`Discord ${init.method ?? 'GET'} ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function discordApi(config: DiscordConfig): DiscordApi {
  return {
    clientId: config.clientId,
    authorizeUrl(state, redirectUri) {
      const query = new URLSearchParams({ client_id: config.clientId, response_type: 'code', scope: 'identify', redirect_uri: redirectUri, state, prompt: 'none' });
      return `https://discord.com/oauth2/authorize?${query}`;
    },
    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code });
      if (redirectUri) body.set('redirect_uri', redirectUri);
      const token = await call<{ access_token: string }>('/oauth2/token', { method: 'POST', body }, 400);
      return token?.access_token ?? null;
    },
    async user(accessToken) {
      return (await call<DiscordUser>('/users/@me', { headers: { authorization: `Bearer ${accessToken}` } }))!;
    },
    async instance(instanceId) {
      const path = `/applications/${config.clientId}/activity-instances/${encodeURIComponent(instanceId)}`;
      type Instance = { users: string[]; location: { guild_id?: string; channel_id: string } };
      const instance = await call<Instance>(path, { headers: { authorization: `Bot ${config.botToken}` } }, 404);
      const { guild_id: guild, channel_id: channel } = instance?.location ?? {};
      return instance && { users: instance.users, place: guild ? `guild:${guild}` : `dm:${channel}` };
    },
  };
}
