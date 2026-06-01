import https from "node:https";
import http from "node:http";

export interface HaConfig {
  url: string;
  token: string;
  ttsEntity: string;
  mediaPlayerEntity: string;
}

function request(
  method: "POST" | "GET",
  urlStr: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === "https:";
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: body
        ? { ...headers, "Content-Length": Buffer.byteLength(body) }
        : headers,
      rejectUnauthorized: false,
    };
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function speak(config: HaConfig, message: string): Promise<void> {
  const body = JSON.stringify({
    entity_id: config.ttsEntity,
    cache: true,
    media_player_entity_id: config.mediaPlayerEntity,
    message,
  });
  const res = await request("POST", `${config.url}/api/services/tts/speak`, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.token}`,
  }, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HA TTS speak failed (${res.status}): ${res.text}`);
  }
}

export async function waitForIdle(
  config: HaConfig,
  timeoutMs = 30_000
): Promise<void> {
  if (!config.mediaPlayerEntity) return;

  // Give HA a moment to start playing before we start polling
  await sleep(1000);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(
        "GET",
        `${config.url}/api/states/${config.mediaPlayerEntity}`,
        { Authorization: `Bearer ${config.token}` }
      );
      if (res.status === 200) {
        const state = (JSON.parse(res.text) as { state: string }).state;
        if (state === "idle" || state === "paused" || state === "off" || state === "unavailable") {
          return;
        }
      }
    } catch {
      // network hiccup — keep waiting
    }
    await sleep(600);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
