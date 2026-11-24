// The Discord Activity (docs/discord.md): the same web app, opened by Discord in an iframe on discord.com and served
// through Discord's proxy. It signs in with Discord before anything renders.
import type { DiscordSDK } from '@discord/embedded-app-sdk';
import { api } from './api.ts';

/** Discord opens the Activity with `frame_id` in the address, and the SDK needs it. */
export const inActivity = new URLSearchParams(window.location.search).has('frame_id');

/** The SDK once the Activity has signed in; null on the website. */
export let discordSdk: DiscordSDK | null = null;

/** Connects to Discord and signs the player in. The SDK is loaded only here, so the website never downloads it. */
export async function startActivity(): Promise<void> {
  const [{ DiscordSDK }, { clientId }] = await Promise.all([import('@discord/embedded-app-sdk'), api<{ clientId: string }>('/discord')]);
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();
  // `prompt: 'none'` asks only the first time; after that Discord answers without showing anything.
  const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
  const { accessToken } = await api<{ accessToken: string }>('/discord/session', {
    method: 'POST',
    body: JSON.stringify({ code, instanceId: sdk.instanceId }),
  });
  await sdk.commands.authenticate({ access_token: accessToken });
  discordSdk = sdk;
}
