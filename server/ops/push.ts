import crypto from 'node:crypto';
import webpush from 'web-push';
import { db, parseJson } from '../db/index.ts';
import { decryptSecret, encryptSecret, randomId } from '../lib/crypto.ts';
import { badRequest } from '../lib/http.ts';
import { getOpsSetting, getSettings, setOpsSetting } from '../repositories/settings.ts';

/**
 * Web Push: notifications on phones and desktops, with no app store app.
 *
 * Sending is outbound only - the server posts to Google's, Mozilla's or
 * Apple's push service, which wakes the device - so it works from a server
 * that nothing on the internet can reach. Tapping "Acknowledge" on the
 * notification does need the device to reach this server (company network,
 * VPN or a tunnel); without that it opens the app instead.
 */

interface StoredVapid {
  publicKey?: string;
  privateKeyEncrypted?: string;
}

let vapidCache: { publicKey: string; privateKey: string } | null = null;

/** The VAPID key pair: made once, kept in the database, the private half encrypted. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (vapidCache) return vapidCache;
  const stored = await getOpsSetting<StoredVapid>('webPush', {});
  if (stored.publicKey && stored.privateKeyEncrypted) {
    vapidCache = { publicKey: stored.publicKey, privateKey: decryptSecret(stored.privateKeyEncrypted) };
    return vapidCache;
  }
  const keys = webpush.generateVAPIDKeys();
  await setOpsSetting('webPush', { publicKey: keys.publicKey, privateKeyEncrypted: encryptSecret(keys.privateKey) });
  vapidCache = keys;
  return keys;
}

/** For tests that swap databases. */
export function resetVapidCache(): void {
  vapidCache = null;
}

const hashOf = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex');

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function validateSubscription(body: unknown): PushSubscriptionInput {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint : '';
  const keys = (raw.keys && typeof raw.keys === 'object' ? raw.keys : {}) as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest('That is not a push subscription.');
  }
  // The push service is the browser vendor's, and always https.
  if (url.protocol !== 'https:' || endpoint.length > 2000) throw badRequest('That is not a push subscription.');
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw badRequest('The subscription is missing its keys.');
  }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Saves a device for this person. A device that moves to another account moves with it. */
export async function saveSubscription(userId: string, input: PushSubscriptionInput, userAgent: string | null): Promise<void> {
  const now = new Date().toISOString();
  const hash = hashOf(input.endpoint);
  const existing = await db.get<{ id: string }>(`SELECT id FROM push_subscriptions WHERE endpoint_hash = ?`, [hash]);
  if (existing) {
    await db.run(`UPDATE push_subscriptions SET user_id = ?, keys = ?, user_agent = ?, last_used_at = ? WHERE id = ?`, [
      userId,
      JSON.stringify(input.keys),
      userAgent?.slice(0, 300) ?? null,
      now,
      existing.id,
    ]);
    return;
  }
  await db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint_hash, endpoint, keys, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), userId, hash, input.endpoint, JSON.stringify(input.keys), userAgent?.slice(0, 300) ?? null, now],
  );
}

/** Only ever the caller's own device. */
export async function removeSubscription(userId: string, endpoint: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(`SELECT id FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?`, [hashOf(endpoint), userId]);
  if (!row) return false;
  await db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [row.id]);
  return true;
}

export async function countSubscriptions(userId: string): Promise<number> {
  const row = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`, [userId]);
  return Number(row?.n ?? 0);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Present for a page: the notification gets an Acknowledge button. */
  pageId?: string | null;
  ticketId?: string | null;
  url?: string;
  tag?: string;
}

export interface PushResult {
  status: 'sent' | 'failed' | 'skipped';
  provider: string;
  detail: string;
}

/**
 * Sends to every device the person has. Succeeds if any device took it;
 * devices the push service reports as gone (404/410) are forgotten.
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<PushResult> {
  const rows = await db.all<{ id: string; endpoint: string; keys: string }>(`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ?`, [userId]);
  if (!rows.length) return { status: 'skipped', provider: 'web-push', detail: 'No phone or browser has push turned on (Profile → Phone notifications)' };

  const { publicKey, privateKey } = await vapidKeys();
  const settings = await getSettings();
  const subject = settings.supportEmail ? `mailto:${settings.supportEmail}` : 'mailto:infraticket@localhost';
  const body = JSON.stringify(payload);
  let delivered = 0;
  let removed = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: parseJson<{ p256dh: string; auth: string }>(row.keys, { p256dh: '', auth: '' }) }, body, {
        vapidDetails: { subject, publicKey, privateKey },
        // A page that is minutes old is still worth delivering; an hour, not.
        TTL: 3600,
        urgency: payload.pageId ? 'high' : 'normal',
        timeout: 10_000,
      });
      delivered += 1;
      await db.run(`UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [row.id]);
        removed += 1;
      } else {
        errors.push(statusCode ? `HTTP ${statusCode}` : (error as Error).message);
      }
    }
  }

  const gone = removed ? `; forgot ${removed} device(s) that unsubscribed` : '';
  if (delivered) return { status: 'sent', provider: 'web-push', detail: `Pushed to ${delivered} device(s)${gone}` };
  return { status: 'failed', provider: 'web-push', detail: (errors.join(', ') || 'No device accepted the notification') + gone };
}
