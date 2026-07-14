// Opt-in debug telemetry for chasing mobile-background bugs (missed speech,
// audio going silent after the app returns from the background). Posts to
// /api/debug-log on the local test server (src/server.ts); on the real
// GitHub Pages deployment that endpoint doesn't exist, so calls just fail
// silently and cost nothing. Enable with ?debug=1 or localStorage.
const ENDPOINT = "/api/debug-log";
const LS_FLAG = "pesisselostaja-debug";

let enabled: boolean | null = null;

function isEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled =
      new URLSearchParams(location.search).get("debug") === "1" ||
      localStorage.getItem(LS_FLAG) === "1";
  } catch {
    enabled = false;
  }
  return enabled;
}

export function debugLog(event: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  const payload = { ts: new Date().toISOString(), event, ...data };
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => { /* no debug server here — ignore */ });
  } catch { /* ignore */ }
}
