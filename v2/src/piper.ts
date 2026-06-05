// Piper neural TTS in the browser.
//
// Two backends behind one API:
//  - "vits"   → @diffusionstudio/vits-web for the official Piper voices
//               (harri). Models cached in OPFS, ORT + phonemizer wasm from CDN.
//  - "custom" → a hand-rolled Piper pipeline for community voices that aren't in
//               vits-web's hardcoded list (asmo lives in a different HuggingFace
//               repo). Reuses the same espeak phonemizer (@diffusionstudio/
//               piper-wasm via its CDN script) + onnxruntime-web, mirroring
//               vits-web's own inference. Models cached via the Cache API.
//
// Everything heavy is loaded lazily (dynamic import / injected script) so the
// default browser-speech path never pulls ORT/WASM.

export type PiperVoiceId = "fi_FI-harri-medium" | "fi_FI-harri-low" | "fi_FI-asmo-medium";

export interface PiperVoiceOption {
  id: PiperVoiceId;
  label: string;
  backend: "vits" | "custom";
}

/** Drives the settings dropdown. Order = display order. */
export const PIPER_VOICES: PiperVoiceOption[] = [
  { id: "fi_FI-harri-medium", label: "Harri – laadukas (~60 MB)", backend: "vits" },
  { id: "fi_FI-harri-low", label: "Harri – kevyt (~20 MB)", backend: "vits" },
  { id: "fi_FI-asmo-medium", label: "Asmo – laadukas (~60 MB)", backend: "custom" },
];

export interface PiperProgress { url: string; total: number; loaded: number; }
type ProgressCb = (p: PiperProgress) => void;

function backendOf(id: string): "vits" | "custom" {
  return PIPER_VOICES.find((v) => v.id === id)?.backend ?? "vits";
}

// ── vits-web backend (harri) ────────────────────────────────────────────────

let vitsMod: typeof import("@diffusionstudio/vits-web") | null = null;
async function vits(): Promise<typeof import("@diffusionstudio/vits-web")> {
  return (vitsMod ??= await import("@diffusionstudio/vits-web"));
}

// ── custom backend (asmo) ───────────────────────────────────────────────────

// Match the exact versions vits-web pins: ORT 1.18.0 wasm and piper-wasm 1.0.0,
// so the custom path and the vits path share one consistent ORT runtime.
const ONNX_WASM_BASE = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/";
const PHONEMIZER_JS = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js";
const PHONEMIZER_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const CACHE_NAME = "pesis-piper-custom-v1";

interface CustomModel { onnx: string; json: string; }
const CUSTOM_MODELS: Record<string, CustomModel> = {
  "fi_FI-asmo-medium": {
    onnx: "https://huggingface.co/AsmoKoskinen/Piper_Finnish_Model/resolve/main/fi_FI-asmo-medium.onnx",
    json: "https://huggingface.co/AsmoKoskinen/Piper_Finnish_Model/resolve/main/fi_FI-asmo-medium.onnx.json",
  },
};

// onnxruntime-web, configured once and shared.
let ortMod: any = null;
async function ort(): Promise<any> {
  if (!ortMod) {
    ortMod = await import("onnxruntime-web");
    ortMod.env.allowLocalModels = false;
    // Single-threaded: no SharedArrayBuffer / cross-origin isolation needed
    // (GitHub Pages can't set COOP/COEP). ORT also auto-falls back, but be explicit.
    ortMod.env.wasm.numThreads = 1;
    ortMod.env.wasm.wasmPaths = ONNX_WASM_BASE;
  }
  return ortMod;
}

// The Emscripten phonemizer ships as a UMD script that sets a global factory.
// Loading it via <script> (the way it's designed) sidesteps bundler interop,
// and the wasm/data load from the same CDN as the script.
let phonemizeFactory: ((opts: unknown) => Promise<any>) | null = null;
function loadPhonemizer(): Promise<(opts: unknown) => Promise<any>> {
  if (phonemizeFactory) return Promise.resolve(phonemizeFactory);
  const w = window as unknown as { createPiperPhonemize?: (opts: unknown) => Promise<any> };
  if (w.createPiperPhonemize) return Promise.resolve((phonemizeFactory = w.createPiperPhonemize));
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PHONEMIZER_JS;
    s.onload = () => {
      if (w.createPiperPhonemize) resolve((phonemizeFactory = w.createPiperPhonemize));
      else reject(new Error("piper-wasm: factory not found after load"));
    };
    s.onerror = () => reject(new Error("piper-wasm: script load failed"));
    document.head.appendChild(s);
  });
}

/** Text → espeak phoneme ids, via the piper phonemizer. */
async function phonemize(text: string, espeakVoice: string): Promise<number[]> {
  const factory = await loadPhonemizer();
  return new Promise<number[]>((resolve, reject) => {
    factory({
      print: (line: string) => {
        try { resolve(JSON.parse(line).phoneme_ids as number[]); }
        catch (e) { reject(e); }
      },
      printErr: (line: string) => reject(new Error(line)),
      locateFile: (file: string) =>
        file.endsWith(".wasm") ? `${PHONEMIZER_BASE}.wasm`
          : file.endsWith(".data") ? `${PHONEMIZER_BASE}.data`
            : file,
    }).then((mod: any) => {
      mod.callMain([
        "-l", espeakVoice,
        "--input", JSON.stringify([{ text: text.trim() }]),
        "--espeak_data", "/espeak-ng-data",
      ]);
    }).catch(reject);
  });
}

/** Fetch with progress, returning the body as a Blob. */
async function fetchBlobProgress(url: string, onProgress?: ProgressCb): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const total = +(res.headers.get("Content-Length") ?? 0);
  const reader = res.body?.getReader();
  if (!reader) return res.blob();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ url, total, loaded });
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get("Content-Type") ?? undefined });
}

/** Cache-API-backed fetch (model files are large and immutable). */
async function getCachedFile(url: string, onProgress?: ProgressCb): Promise<Blob> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) return hit.blob();
  const blob = await fetchBlobProgress(url, onProgress);
  await cache.put(url, new Response(blob));
  return blob;
}

// One ORT session + config per custom voice, kept in memory after first load.
const customSessions = new Map<string, { session: any; config: any }>();

async function customSynth(text: string, voiceId: string): Promise<Blob> {
  const o = await ort();
  let entry = customSessions.get(voiceId);
  if (!entry) {
    const m = CUSTOM_MODELS[voiceId];
    if (!m) throw new Error(`unknown custom voice ${voiceId}`);
    const config = JSON.parse(await (await getCachedFile(m.json)).text());
    const modelBuf = await (await getCachedFile(m.onnx)).arrayBuffer();
    const session = await o.InferenceSession.create(modelBuf);
    entry = { session, config };
    customSessions.set(voiceId, entry);
  }
  const { session, config } = entry;
  const ids = await phonemize(text, config.espeak.voice);
  const idsI64 = BigInt64Array.from(ids, (v) => BigInt(v));
  const feeds: Record<string, any> = {
    input: new o.Tensor("int64", idsI64, [1, ids.length]),
    input_lengths: new o.Tensor("int64", BigInt64Array.from([BigInt(ids.length)])),
    scales: new o.Tensor("float32", Float32Array.from([
      config.inference.noise_scale,
      config.inference.length_scale,
      config.inference.noise_w,
    ])),
  };
  if (Object.keys(config.speaker_id_map ?? {}).length) {
    feeds.sid = new o.Tensor("int64", BigInt64Array.from([0n]));
  }
  const result = await session.run(feeds);
  const pcm = result.output.data as Float32Array;
  return new Blob([floatPcmToWav(pcm, config.audio.sample_rate)], { type: "audio/x-wav" });
}

/** Mono float32 PCM → 16-bit WAV (matches vits-web's encoder). */
function floatPcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const channels = 1;
  const headerLen = 44;
  const buf = new ArrayBuffer(samples.length * channels * 2 + headerLen);
  const view = new DataView(buf);
  view.setUint32(0, 0x46464952, true);            // "RIFF"
  view.setUint32(4, buf.byteLength - 8, true);
  view.setUint32(8, 0x45564157, true);            // "WAVE"
  view.setUint32(12, 0x20746d66, true);           // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                    // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x61746164, true);           // "data"
  view.setUint32(40, samples.length * 2, true);
  let off = headerLen;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s >= 1) view.setInt16(off, 32767, true);
    else if (s <= -1) view.setInt16(off, -32768, true);
    else view.setInt16(off, (s * 32768) | 0, true);
    off += 2;
  }
  return buf;
}

// ── Public API (backend-agnostic) ───────────────────────────────────────────

/** Synthesize one utterance to a WAV Blob. */
export async function piperSynthesize(text: string, voiceId: string): Promise<Blob> {
  if (backendOf(voiceId) === "vits") {
    return (await vits()).predict({ text, voiceId: voiceId as never });
  }
  return customSynth(text, voiceId);
}

/** Pre-download a voice's model(s) into persistent cache. */
export async function piperDownload(voiceId: string, onProgress?: ProgressCb): Promise<void> {
  if (backendOf(voiceId) === "vits") {
    await (await vits()).download(voiceId as never, onProgress);
    return;
  }
  const m = CUSTOM_MODELS[voiceId];
  if (!m) throw new Error(`unknown custom voice ${voiceId}`);
  await getCachedFile(m.json);
  await getCachedFile(m.onnx, onProgress);
}

/** Which voices are already downloaded (so we can skip the download step). */
export async function piperStored(): Promise<string[]> {
  const out: string[] = [];
  try {
    out.push(...(await (await vits()).stored()));
  } catch { /* vits-web unavailable; ignore */ }
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const [id, m] of Object.entries(CUSTOM_MODELS)) {
      if ((await cache.match(m.onnx)) && (await cache.match(m.json))) out.push(id);
    }
  } catch { /* Cache API unavailable; ignore */ }
  return out;
}
