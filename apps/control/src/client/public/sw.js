/* Service worker for the Ohjaamo PWA.
 *
 * Its ONLY job is push. There is deliberately no offline cache: every screen in
 * this app is live state from a server on the same tailnet, and a cached shell
 * showing yesterday's scoreboard would be worse than an error page — the whole
 * point of the app is that what you see is what is happening right now.
 *
 * Vite copies src/client/public/ verbatim into dist/client/, so this file is
 * served from /sw.js and therefore gets scope "/" — required, since the
 * notification click has to be able to focus the app at the root.
 *
 * Plain JS on purpose: it is not part of the TS bundle, so nothing here is
 * typechecked. Keep it small and boring.
 */

// Take over immediately instead of waiting for every tab to close. An old
// worker lingering after a deploy would keep handling pushes with old code.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      // Some push services deliver a bare string (and a test push sent by hand
      // certainly will). Showing it beats swallowing the notification.
      data = { title: "Pesisselostaja", body: event.data.text() };
    }
  }

  const title = data.title || "Pesisselostaja";
  const options = {
    body: data.body || "",
    // The tag collapses repeats of the same subject into one notification
    // instead of stacking them; renotify makes the replacement still alert, so
    // "rikki" -> "taas kunnossa" is not delivered silently.
    tag: data.tag || "pesisselostaja",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };

  // waitUntil is not optional: iOS kills the worker as soon as the handler
  // returns, and a notification still being built at that point never appears.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // An installed PWA has at most one window. Focusing the existing one is
      // what the operator expects; opening a second would lose the live SSE
      // connection the first one already has.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if (url !== "/" && "navigate" in client) await client.navigate(url);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
