import { useSyncExternalStore } from 'react';

/** Per-browser duel preferences. Kept in localStorage, so they are a convenience and may be lost. */
export interface DuelSettings {
  speed: 'normal' | 'fast';
  reduceMotion: boolean;
  /** Sound volume, 0 to 1. */
  volume: number;
  muted: boolean;
  /** Desktop notifications (notify.tsx), once the browser allows them. */
  notify: boolean;
  /** Emotes read out loud too (sound.ts). */
  speakEmotes: boolean;
  /** The table seen at an angle, as from a chair, rather than from straight above. */
  tilt: boolean;
}

const KEY = 'duel-settings';
const defaults: DuelSettings = { speed: 'normal', reduceMotion: false, volume: 0.6, muted: false, notify: false, speakEmotes: false, tilt: false };

function load(): DuelSettings {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DuelSettings>) };
  } catch {
    return defaults;
  }
}

let current = load();
const listeners = new Set<() => void>();

/** The settings now, for code outside React (the sounds). */
export const duelSettings = () => current;

export function updateDuelSettings(change: Partial<DuelSettings>) {
  current = { ...current, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage can be unavailable (private windows); the setting then lasts for this page only.
  }
  for (const listener of listeners) listener();
}

export function useDuelSettings() {
  const settings = useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    duelSettings,
  );
  return [settings, updateDuelSettings] as const;
}

/** True when the system asks for less motion. */
export const systemReducesMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
