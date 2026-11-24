// Web Push (docs/ux-niceties.md): a player's browsers are told when a duel needs them, even with the site closed. The
// service worker (web/public/sw.js) shows the notification. While a tab of the site is open, the tab tells the player
// itself, so the duel feed pushes only to players with no tab open.

import { eq } from 'drizzle-orm';
import webpush, { type PushSubscription } from 'web-push';
import type { Db } from './db/client.ts';
import { pushSubscriptions } from './db/schema.ts';

/** What the service worker shows. */
export interface PushMessage {
  body: string;
  /** One notification per duel: a newer one replaces it. */
  tag: string;
  /** The page a click opens. */
  url: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** Who push services contact about this sender: the site's https address, or the admin's email. */
  subject: string;
}

export class Push {
  readonly publicKey: string;
  private db: Db;
  private vapid: VapidKeys;

  constructor(db: Db, vapid: VapidKeys) {
    this.db = db;
    this.vapid = vapid;
    this.publicKey = vapid.publicKey;
  }

  /** Keeps this browser's subscription for the player, moving it over if another player had it on this browser. */
  async subscribe(seatKey: string, subscription: PushSubscription) {
    const row = { seatKey, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth };
    await this.db
      .insert(pushSubscriptions)
      .values({ endpoint: subscription.endpoint, ...row })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });
  }

  async unsubscribe(endpoint: string) {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }

  /** Sends to every browser the player subscribed, forgetting those the push service says are gone. */
  async send(seatKey: string, message: PushMessage) {
    const rows = await this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.seatKey, seatKey));
    const { subject, publicKey, privateKey } = this.vapid;
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(message), {
            vapidDetails: { subject, publicKey, privateKey },
            TTL: 24 * 60 * 60,
          });
        } catch (error) {
          const status = error instanceof webpush.WebPushError ? error.statusCode : null;
          if (status === 404 || status === 410) await this.unsubscribe(row.endpoint);
          else console.error(`Web Push to ${new URL(row.endpoint).host} failed:`, error);
        }
      }),
    );
  }
}
