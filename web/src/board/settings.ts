import { useCallback, useState } from 'react';

/** Per-browser duel preferences. Kept in localStorage, so they are a convenience and may be lost. */
export interface DuelSettings {
  speed: 'normal' | 'fast';
  reduceMotion: boolean;
}

const KEY = 'duel-settings';
const defaults: DuelSettings = { speed: 'normal', reduceMotion: false };

function load(): DuelSettings {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DuelSettings>) };
  } catch {
    return defaults;
  }
}

export function useDuelSettings() {
  const [settings, setSettings] = useState(load);
  const update = useCallback((change: Partial<DuelSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...change };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private windows); the setting then lasts for this page only.
      }
      return next;
    });
  }, []);
  return [settings, update] as const;
}

/** True when the system asks for less motion. */
export const systemReducesMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
