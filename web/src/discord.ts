// The Discord Activity (docs/discord.md): the same web app, opened by Discord in an iframe on discord.com and served
// through Discord's proxy. It signs in with Discord before anything renders.
import type { DiscordSDK } from '@discord/embedded-app-sdk';
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

/** Discord opens the Activity with `frame_id` in the address, and the SDK needs it. */
export const inActivity = new URLSearchParams(window.location.search).has('frame_id');

/** The SDK once the Activity has signed in; null on the website. */
let discordSdk: DiscordSDK | null = null;
/** The website's own address. Inside the Activity the page runs on Discord's proxy, whose links work only there. */
let siteUrl = window.location.origin;

/** Connects to Discord and signs the player in. The SDK is loaded only here, so the website never downloads it. */
export async function startActivity(): Promise<void> {
  const [{ DiscordSDK, Events }, config] = await Promise.all([import('@discord/embedded-app-sdk'), api<{ clientId: string; siteUrl: string }>('/discord')]);
  const sdk = new DiscordSDK(config.clientId);
  await sdk.ready();
  // `prompt: 'none'` asks only the first time; after that Discord answers without showing anything.
  const { code } = await sdk.commands.authorize({ client_id: config.clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
  const { accessToken } = await api<{ accessToken: string }>('/discord/session', {
    method: 'POST',
    body: JSON.stringify({ code, instanceId: sdk.instanceId }),
  });
  await sdk.commands.authenticate({ access_token: accessToken });
  await sdk.subscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, ({ layout_mode }) => setSmall(layout_mode === PIP || layout_mode === GRID));
  discordSdk = sdk;
  siteUrl = config.siteUrl;
}

/** A link to a page of the website, `path` from the root, that works anywhere, including from inside Discord. */
export const siteLink = (path: string) => new URL(path, siteUrl).href;

/**
 * Copies a link. Discord's frame may not allow the clipboard, so there the link opens in the browser instead, where it
 * can be copied. Resolves to whether it was copied.
 */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch (error) {
    if (!discordSdk) throw error;
    await discordSdk.commands.openExternalLink({ url });
    return false;
  }
}

// Discord's layout modes: the Activity fills the call, shrinks to a pop-out while the player looks elsewhere, or is one
// tile of several.
const PIP = 1;
const GRID = 2;
let small = false;
const listeners = new Set<() => void>();
function setSmall(value: boolean) {
  small = value;
  for (const listener of listeners) listener();
}

/** Whether Discord shows the Activity small, in its pop-out or as one tile of a grid. Always false on the website. */
export function useSmallFrame(): boolean {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => small,
  );
}
