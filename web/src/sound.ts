// The site's sound effects, generated in code with ZzFX (https://github.com/KilledByAPixel/ZzFX), so there are no audio
// files. Each sound is one row of ZzFX parameters; recorded samples could replace this table later without touching
// the callers. Volume and mute are per browser, with the duel settings.

import { ZZFX } from 'zzfx';
import { duelSettings } from './board/settings.ts';

// ZzFX parameters, in order: volume, randomness, frequency, attack, sustain, release, shape (0 sine, 1 triangle,
// 2 saw, 3 tan, 4 noise), shape curve, slide, delta slide, pitch jump, pitch jump time, repeat time, noise, modulation,
// bit crush, delay, sustain volume, decay, tremolo, filter.
const sounds = {
  /** A card drawn, or added to the hand from the Deck. */
  draw: [0.4, 0.05, 900, 0, 0.01, 0.05, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4],
  /** A card Set face-down. */
  set: [0.5, 0.05, 180, 0, 0.02, 0.08, 4, 1],
  /** A monster arriving face-up: Normal, Flip, Special, Synchro or Xyz Summoned. */
  summon: [0.7, 0.05, 220, 0.02, 0.08, 0.3, 1, 1.5, 0, 0, 220, 0.08],
  /** A face-down card turning face-up. */
  flip: [0.5, 0.05, 600, 0, 0.02, 0.06, 1, 1, 30],
  attack: [0.6, 0.05, 300, 0.01, 0.05, 0.2, 2, 1, -12],
  /** Damage taken. */
  hit: [0.8, 0.1, 90, 0, 0.05, 0.35, 4, 1.5, 0, 0, 0, 0, 0, 0.6],
  destroy: [0.7, 0.1, 333, 0.01, 0, 0.6, 4, 1.9, 0, 0, 0, 0, 0, 0.4, 0, 0.3],
  /** A card's effect activated. */
  activate: [0.5, 0.02, 880, 0.02, 0.1, 0.3, 0, 1, 0, 0, 440, 0.05, 0, 0, 0, 0, 0.05],
  /** LP gained. */
  gain: [0.5, 0, 660, 0.01, 0.08, 0.2, 0, 1, 0, 0, 330, 0.06],
  /** The player's own turn begins. */
  yourTurn: [0.6, 0, 523, 0.01, 0.12, 0.35, 0, 1, 0, 0, 262, 0.12],
  /** The duel waits on the player's answer: a response, a trigger, a pick. */
  answer: [0.6, 0, 880, 0, 0.05, 0.12, 0, 1, 0, 0, 0, 0, 0.08],
  win: [0.7, 0, 392, 0.02, 0.25, 0.5, 0, 1, 0, 0, 196, 0.15, 0.15],
  lose: [0.6, 0, 220, 0.02, 0.2, 0.6, 1, 1, -1.5],
} satisfies Record<string, number[]>;

export type Sound = keyof typeof sounds;

/** How loud ZzFX plays at full volume; its own default, which leaves room for sounds that overlap. */
const MASTER = 0.3;

/** Plays a sound, unless muted. Browsers keep audio off until the page has been clicked or typed in. */
export function play(sound: Sound) {
  const { volume, muted } = duelSettings();
  if (muted || volume === 0 || ZZFX.audioContext.state !== 'running') return;
  ZZFX.volume = MASTER * volume;
  ZZFX.play(...sounds[sound]);
}

// Audio may start only after the player has used the page.
const unlock = () => {
  void ZZFX.audioContext.resume().then(() => {
    if (ZZFX.audioContext.state !== 'running') return;
    for (const type of ['pointerdown', 'keydown'] as const) window.removeEventListener(type, unlock);
  });
};
for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, unlock);
