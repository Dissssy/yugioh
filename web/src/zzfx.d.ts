// ZzFX ships no types; this is the part the sounds use (web/src/sound.ts).
declare module 'zzfx' {
  export const ZZFX: {
    /** Master volume, multiplied into every sound. */
    volume: number;
    audioContext: AudioContext;
    play(...parameters: (number | undefined)[]): AudioBufferSourceNode;
  };
}
