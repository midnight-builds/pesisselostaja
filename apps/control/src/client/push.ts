/** Client half of Web Push: service-worker registration, permission, and the
 *  browser-side subscription.
 *
 *  iOS is the whole reason this file is more than ten lines. On iPhone:
 *   - Web Push only exists at all when the site has been added to the home
 *     screen (standalone display mode). In a normal Safari tab `Notification`
 *     is simply undefined — there is no permission prompt to fall back to.
 *   - `Notification.requestPermission()` must be called from a user gesture.
 *     Awaiting anything before it (a fetch for the VAPID key, say) can spend
 *     the gesture and get the call rejected, so permission is asked FIRST and
 *     every network round-trip happens after.
 *   - Both facts are invisible failures if unhandled: the button appears to do
 *     nothing. Hence the explicit status values below, each with its own
 *     Finnish explanation in the UI. */

import type { NotificationPrefs, PushSendResult } from "../shared/types";

export type PushStatus =
  /** No service worker / PushManager at all — e.g. a desktop browser with it
   *  disabled, or a very old iOS. */
  | "unsupported"
  /** iOS Safari tab: supported by the OS, but only once installed. */
  | "needs-install"
  /** Permission denied. Only the OS settings can undo this, not our button. */
  | "blocked"
  /** Supported and allowed to ask — the button is live. */
  | "off"
  /** Subscribed; this phone will get the alerts. */
  | "on";

/** iPadOS reports itself as "MacIntel" with touch points, so the platform
 *  check needs both arms to catch every iOS device. */
function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/** True when running as an installed app rather than in a browser tab. The
 *  legacy `navigator.standalone` is the only reliable signal on older iOS. */
export function isStandalone(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (legacy === true) return true;
  return window.matchMedia("(display-mode: standalone)").matches;
}

function pushApiAvailable(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Registers the worker. Failure is not fatal: everything except notifications
 *  keeps working without it, so this only ever logs. */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (err) {
    console.warn("[ohjaamo] service workerin rekisteröinti epäonnistui", err);
  }
}

export async function readPushStatus(): Promise<PushStatus> {
  if (!pushApiAvailable()) {
    // On iOS the API is missing precisely BECAUSE the app is not installed —
    // telling the operator to install is far more useful than "ei tuettu".
    return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) return "on";
  } catch {
    // Worker not ready yet — treat as "not subscribed" rather than an error.
  }
  // Permission may already be "granted" while no subscription exists (app
  // reinstalled, subscription expired) — the button still has work to do.
  return "off";
}

/** VAPID public keys travel as URL-safe base64; PushManager wants raw bytes.
 *  Built on an explicit ArrayBuffer so the result is a plain Uint8Array that
 *  satisfies BufferSource under TypeScript's newer typed-array generics. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Asks for permission and subscribes this phone. MUST be called straight from
 *  a tap handler — see the file header. Throws a Finnish sentence on every
 *  failure path, because the UI renders the message verbatim. */
export async function enablePush(): Promise<PushStatus> {
  if (!pushApiAvailable()) {
    throw new Error(
      isIos() && !isStandalone()
        ? "Lisää sovellus ensin Koti-valikkoon — iOS sallii ilmoitukset vain asennetulle sovellukselle."
        : "Selain ei tue push-ilmoituksia."
    );
  }

  // First thing in the gesture, before any await on the network.
  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    throw new Error("Ilmoitukset on estetty. Salli ne tämän puhelimen asetuksista (Ilmoitukset → Ohjaamo).");
  }
  if (permission !== "granted") {
    throw new Error("Ilmoituslupaa ei myönnetty.");
  }

  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await fetchJson<{ publicKey: string }>("/api/push/key");

  // An existing subscription made against an older VAPID key would keep
  // failing silently at the push service, so it is replaced rather than reused
  // when the key no longer matches.
  const existing = await registration.pushManager.getSubscription();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  if (existing) await existing.unsubscribe();

  const subscription = await registration.pushManager.subscribe({
    // Required by every current browser: a push may not be silent/data-only.
    userVisibleOnly: true,
    applicationServerKey,
  });

  await fetchJson<null>("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });

  return "on";
}

export async function sendTestPush(): Promise<PushSendResult> {
  return fetchJson<PushSendResult>("/api/push/test", { method: "POST" });
}

export async function getPushPrefs(): Promise<NotificationPrefs> {
  return fetchJson<NotificationPrefs>("/api/push/prefs");
}

export async function setPushPrefs(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  return fetchJson<NotificationPrefs>("/api/push/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** Same error contract as api.ts: any failure becomes a Finnish sentence.
 *  Kept local rather than imported so the push flow has no dependency on the
 *  live-state client. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Palvelimeen ei saada yhteyttä");
  }
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Palvelin vastasi virheellistä JSONia (HTTP ${res.status})`);
    }
  }
  if (!res.ok) {
    const err = body as { error?: string; detail?: string } | null;
    if (err && typeof err.error === "string") {
      throw new Error(err.detail ? `${err.error}: ${err.detail}` : err.error);
    }
    throw new Error(`Palvelinvirhe (HTTP ${res.status})`);
  }
  return body as T;
}
