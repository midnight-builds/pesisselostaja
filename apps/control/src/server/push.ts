/** Web Push: VAPID identity, subscription storage, delivery.
 *
 *  `web-push` is the only runtime npm dependency this otherwise dependency-free
 *  server has, and it is a deliberate exception (DESIGN.md says no frameworks).
 *  A push message is an ECDH-derived, AES128GCM-encrypted payload plus an
 *  ES256-signed VAPID JWT. Hand-rolled crypto of that shape does not fail
 *  loudly — it "works" right up until Apple's push service rejects the token
 *  mid-match, which is precisely the moment this feature exists to cover.
 *
 *  Everything persists as plain JSON in run/ (store.ts), same idiom as the
 *  rest of the control plane: an operator can read or delete state from the
 *  file browser when something is sideways. */

import webpush from "web-push";
import type { PushSendResult } from "../shared/types.js";
import { createStore } from "./store.js";

/** VAPID requires a contact `sub` claim (mailto: or https:) so a push service
 *  can reach whoever is sending. Nothing verifies it; it just has to be a
 *  valid, stable identifier — overridable for a different deployment. */
const VAPID_SUBJECT = process.env.CONTROL_VAPID_SUBJECT ?? "mailto:pesisselostaja@codexsrv.tail6875ae.ts.net";

/** How long a push service should keep trying. Every notification we send is
 *  about the state of a broadcast RIGHT NOW; one delivered half an hour late
 *  is worse than none, because it describes a match that already ended.
 *  10 minutes is roughly "still actionable". */
const TTL_SEC = 600;

/** The push endpoint is a third party over the network. Without a cap a hung
 *  connection would keep a poller callback alive indefinitely. */
const SOCKET_TIMEOUT_MS = 10_000;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  addedAt: string;
  /** Last successful delivery — the cheapest way to tell a live phone from a
   *  subscription that has been quietly dead since June. */
  lastOkAt: string | null;
}

/** Keys are generated once and then MUST NOT change: every subscription a
 *  browser hands us is bound to the public key it was created with, so a
 *  regenerated pair silently invalidates every installed phone. */
const vapidStore = createStore<VapidKeys | null>("vapid.json", null);
const subscriptionStore = createStore<StoredSubscription[]>("push-subscriptions.json", []);

let cachedVapid: VapidKeys | null = null;

async function ensureVapid(): Promise<VapidKeys> {
  if (cachedVapid) return cachedVapid;
  // update() serializes read-modify-write, so two requests racing on first
  // boot can't each generate a pair and clobber each other.
  const keys = await vapidStore.update((current) => {
    if (current && current.publicKey && current.privateKey) return current;
    const generated = webpush.generateVAPIDKeys();
    return { ...generated, createdAt: new Date().toISOString() };
  });
  if (!keys) throw new Error("VAPID-avainten luonti epäonnistui");
  cachedVapid = keys;
  return keys;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapid()).publicKey;
}

/** Accepts the raw JSON a browser's PushSubscription serializes to. Validated
 *  by hand rather than trusted: a malformed entry here would throw inside the
 *  send loop later, i.e. during the one broadcast we needed it to work. */
export async function addSubscription(sub: unknown): Promise<void> {
  const parsed = parseSubscription(sub);
  if (!parsed) throw new Error("virheellinen push-tilaus (endpoint tai avaimet puuttuvat)");

  await subscriptionStore.update((list) => {
    // The endpoint IS the identity. Re-subscribing (permission re-granted,
    // app reinstalled) must replace, not duplicate — otherwise the phone
    // buzzes twice per event.
    const others = list.filter((entry) => entry.endpoint !== parsed.endpoint);
    return [...others, parsed];
  });
}

export async function getSubscriptionCount(): Promise<number> {
  return (await subscriptionStore.read()).length;
}

function parseSubscription(sub: unknown): StoredSubscription | null {
  if (typeof sub !== "object" || sub === null) return null;
  const record = sub as Record<string, unknown>;
  const endpoint = record.endpoint;
  const keys = record.keys as Record<string, unknown> | undefined;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return null;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    addedAt: new Date().toISOString(),
    lastOkAt: null,
  };
}

/** The payload the service worker (client/public/sw.js) unpacks. Kept as a
 *  named shape on both sides so a rename here is visible there. */
interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  at: string;
}

/** Sends to every subscribed phone.
 *
 *  Never throws. Callers are the live poller and route handlers — a push
 *  service having a bad minute must not take down the state loop or fail an
 *  operator's button press. Delivery problems are logged; the return value is
 *  there for the routes that want to report them. */
export async function sendPush(
  title: string,
  body: string,
  opts: { tag?: string; url?: string } = {}
): Promise<void> {
  await sendPushDetailed(title, body, opts);
}

export async function sendPushDetailed(
  title: string,
  body: string,
  opts: { tag?: string; url?: string } = {}
): Promise<PushSendResult> {
  const result: PushSendResult = { sent: 0, failed: 0, removed: 0 };
  let subs: StoredSubscription[];
  let vapid: VapidKeys;
  try {
    subs = await subscriptionStore.read();
    if (subs.length === 0) return result;
    vapid = await ensureVapid();
  } catch (err) {
    console.error("[control] push: tilausten/avainten luku epäonnistui:", err);
    return result;
  }

  const payload: PushPayload = {
    title,
    body,
    tag: opts.tag ?? "pesisselostaja",
    url: opts.url ?? "/",
    at: new Date().toISOString(),
  };
  const text = JSON.stringify(payload);

  const dead: string[] = [];
  const delivered: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, text, {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          TTL: TTL_SEC,
          timeout: SOCKET_TIMEOUT_MS,
          // Everything we send is "the broadcast changed state" — worth waking
          // the phone for, which is what iOS reads `high` as.
          urgency: "high",
        });
        delivered.push(sub.endpoint);
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        const status = err instanceof webpush.WebPushError ? err.statusCode : 0;
        // 404 / 410 mean the push service has thrown the subscription away for
        // good (app deleted, permission revoked, key rotated). Anything else —
        // 5xx, timeouts, DNS — may well be transient, and dropping a phone's
        // subscription over one bad minute would silently disarm the alerts.
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint);
        } else {
          console.warn("[control] push epäonnistui:", status || "verkkovirhe", err instanceof Error ? err.message : err);
        }
      }
    })
  );

  if (dead.length > 0 || delivered.length > 0) {
    const okAt = new Date().toISOString();
    try {
      await subscriptionStore.update((list) =>
        list
          .filter((entry) => !dead.includes(entry.endpoint))
          .map((entry) => (delivered.includes(entry.endpoint) ? { ...entry, lastOkAt: okAt } : entry))
      );
      result.removed = dead.length;
    } catch (err) {
      console.error("[control] push: tilauslistan päivitys epäonnistui:", err);
    }
  }

  return result;
}
