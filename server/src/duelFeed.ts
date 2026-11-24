// Each player's own live feed of their duels: a duel's summary is sent to both its players whenever it may have changed,
// so the site can show which duels wait on them (their turn, a response, a deck to choose) from any page. A player with
// no tab following their feed hears the news by Web Push instead (push.ts).

import { newsOf, type DuelSummary } from '@yugioh/shared';
import type { Duels } from './duels.ts';
import type { Push } from './push.ts';
import { isAiKey } from './viewer.ts';

/** A burst of changes to one duel (everything played before a pass) is summarized once, this long after it starts. */
const SETTLE_MS = 150;

export class DuelFeed {
  private duels: Duels;
  private push: Push | null;
  /** The last summary of each duel for each of its players, by `duel:seatKey`, to tell what is news. */
  private last = new Map<string, DuelSummary>();
  /** Who follows their feed, by seat key. */
  private followers = new Map<string, Set<(duel: DuelSummary) => void>>();
  /** Duels with a summary on its way. */
  private pending = new Set<string>();

  constructor(duels: Duels, push: Push | null) {
    this.duels = duels;
    this.push = push;
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
      if (key === null || isAiKey(key)) continue;
      const sends = this.followers.get(key);
      if (!sends && !this.push) continue;
      const summary = await this.duels.summarize(row, key, false);
      const before = this.last.get(`${id}:${key}`);
      if (summary.status === 'finished') this.last.delete(`${id}:${key}`);
      else this.last.set(`${id}:${key}`, summary);
      if (sends) for (const send of sends) send(summary);
      else {
        const news = newsOf(before, summary);
        if (news) await this.push!.send(key, { body: news, tag: id, url: `/duel/${id}` });
      }
    }
  }
}
