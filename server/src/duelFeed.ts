// Each player's own live feed of their duels: a duel's summary is sent to both its players whenever it may have changed,
// so the site can show which duels wait on them (their turn, a response, a deck to choose) from any page.

import type { DuelSummary } from '@yugioh/shared';
import type { Duels } from './duels.ts';

/** A burst of changes to one duel (everything played before a pass) is summarized once, this long after it starts. */
const SETTLE_MS = 150;

export class DuelFeed {
  private duels: Duels;
  /** Who follows their feed, by seat key. */
  private followers = new Map<string, Set<(duel: DuelSummary) => void>>();
  /** Duels with a summary on its way. */
  private pending = new Set<string>();

  constructor(duels: Duels) {
    this.duels = duels;
    duels.onChange = (id) => this.changed(id);
  }

  /** Follows the player's feed. Returns the function that stops it. */
  follow(seatKey: string, send: (duel: DuelSummary) => void): () => void {
    const sends = this.followers.get(seatKey) ?? new Set();
    this.followers.set(seatKey, sends.add(send));
    return () => {
      sends.delete(send);
      if (sends.size === 0) this.followers.delete(seatKey);
    };
  }

  private changed(id: string) {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    setTimeout(() => {
      this.pending.delete(id);
      this.send(id).catch((error: unknown) => console.error(`Duel ${id}'s feed update failed:`, error));
    }, SETTLE_MS);
  }

  private async send(id: string) {
    const row = await this.duels.find(id);
    if (!row) return;
    for (const key of [row.seat0, row.seat1]) {
      const sends = key === null ? undefined : this.followers.get(key);
      if (!sends) continue;
      const summary = await this.duels.summarize(row, key, false);
      for (const send of sends) send(summary);
    }
  }
}
