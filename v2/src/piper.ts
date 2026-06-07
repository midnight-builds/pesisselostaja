// Piper neural TTS in the browser.
//
// One pipeline for every voice: espeak phonemizer (@diffusionstudio/piper-wasm,
// loaded from jsDelivr) → onnxruntime-web inference → WAV. This mirrors what
// vits-web does internally, but we run it ourselves so we can:
//   - reach community voices (asmo) that live outside vits-web's hardcoded list,
//   - cache models in IndexedDB instead of OPFS/Cache, which (unlike OPFS and the
//     Cache API) work in a NON-secure context — i.e. plain http:// over a LAN/
//     Tailscale IP, which is how this app is tested. OPFS would silently fail to
//     persist there, re-downloading the model every time and breaking synthesis.
//
// onnxruntime-web (the only bundled heavy dep) is dynamically imported so the
// default browser-speech path never pulls it. Models/phonemizer load from CDN.

export interface PiperVoiceOption {
  id: string;
  label: string;
  /** Display name of the voice (without the quality/size suffix). */
  name: string;
  /** Who made the model / dataset, for attribution. */
  author: string;
  /** Short license label, e.g. "CC0 1.0" or "CC BY-NC 4.0". */
  license: string;
  /** Where the model and its license live (HuggingFace page). */
  sourceUrl: string;
  /** True for non-commercial-only licenses; surfaced in the UI. */
  nonCommercial?: boolean;
}

// Attribution + licensing lives here next to the model URLs so the UI, the
// README and CREDITS.md can all draw from one source. See CREDITS.md.
const HARRI_SOURCE = "https://huggingface.co/rhasspy/piper-voices/tree/main/fi/fi_FI/harri";
const ASMO_SOURCE = "https://huggingface.co/AsmoKoskinen/Piper_Finnish_Model";

/** Drives the settings dropdown. Order = display order. */
export const PIPER_VOICES: PiperVoiceOption[] = [
  { id: "fi_FI-harri-medium", label: "Harri – laadukas (~60 MB)", name: "Harri", author: "rhasspy / Piper (Finnish Single Speaker Speech Dataset)", license: "CC0 1.0", sourceUrl: HARRI_SOURCE },
  { id: "fi_FI-harri-low", label: "Harri – kevyt (~20 MB)", name: "Harri", author: "rhasspy / Piper (Finnish Single Speaker Speech Dataset)", license: "CC0 1.0", sourceUrl: HARRI_SOURCE },
  { id: "fi_FI-asmo-medium", label: "Asmo – laadukas (~60 MB)", name: "Asmo", author: "AsmoKoskinen", license: "CC BY-NC 4.0", sourceUrl: ASMO_SOURCE, nonCommercial: true },
];

export interface PiperProgress { url: string; total: number; loaded: number; }
type ProgressCb = (p: PiperProgress) => void;

interface VoiceFiles { onnx: string; json: string; }

const HARRI_BASE = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main/fi/fi_FI/harri";
const ASMO_BASE = "https://huggingface.co/AsmoKoskinen/Piper_Finnish_Model/resolve/main";

const VOICE_FILES: Record<string, VoiceFiles> = {
  "fi_FI-harri-medium": { onnx: `${HARRI_BASE}/medium/fi_FI-harri-medium.onnx`, json: `${HARRI_BASE}/medium/fi_FI-harri-medium.onnx.json` },
  "fi_FI-harri-low": { onnx: `${HARRI_BASE}/low/fi_FI-harri-low.onnx`, json: `${HARRI_BASE}/low/fi_FI-harri-low.onnx.json` },
  "fi_FI-asmo-medium": { onnx: `${ASMO_BASE}/fi_FI-asmo-medium.onnx`, json: `${ASMO_BASE}/fi_FI-asmo-medium.onnx.json` },
};

// Pin ORT wasm to the version onnxruntime-web (1.18.0) expects, and piper-wasm 1.0.0.
const ONNX_WASM_BASE = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/";
const PHONEMIZER_JS = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js";
const PHONEMIZER_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";

function filesFor(voiceId: string): VoiceFiles {
  const f = VOICE_FILES[voiceId];
  if (!f) throw new Error(`unknown piper voice ${voiceId}`);
  return f;
}

// ── IndexedDB model cache (works in non-secure contexts) ────────────────────

const DB_NAME = "pesis-piper";
const STORE = "models";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  return openDB().then((db) => new Promise<ArrayBuffer | undefined>((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as ArrayBuffer | undefined);
    r.onerror = () => reject(r.error);
  }));
}

function idbHas(key: string): Promise<boolean> {
  return openDB().then((db) => new Promise<boolean>((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).getKey(key);
    r.onsuccess = () => resolve(r.result !== undefined);
    r.onerror = () => reject(r.error);
  }));
}

function idbPut(key: string, val: ArrayBuffer): Promise<void> {
  return openDB().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function fetchArrayBufferProgress(url: string, onProgress?: ProgressCb): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const total = +(res.headers.get("Content-Length") ?? 0);
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ url, total, loaded });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/** Fetch a file once, then serve from IndexedDB on later loads. */
async function getModelBytes(url: string, onProgress?: ProgressCb): Promise<ArrayBuffer> {
  const hit = await idbGet(url);
  if (hit) return hit;
  const buf = await fetchArrayBufferProgress(url, onProgress);
  await idbPut(url, buf);
  return buf;
}

// ── onnxruntime-web (configured once, shared) ───────────────────────────────

let ortMod: any = null;
async function ort(): Promise<any> {
  if (!ortMod) {
    ortMod = await import("onnxruntime-web");
    ortMod.env.allowLocalModels = false;
    // Single-threaded: no SharedArrayBuffer / cross-origin isolation required.
    ortMod.env.wasm.numThreads = 1;
    ortMod.env.wasm.wasmPaths = ONNX_WASM_BASE;
  }
  return ortMod;
}

// ── espeak phonemizer (UMD Emscripten module, loaded via CDN <script>) ──────

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

/** Text → espeak phoneme ids. */
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

// ── Inference ───────────────────────────────────────────────────────────────

// One ORT session + config per voice, kept in memory after first load.
const sessions = new Map<string, { session: any; config: any }>();

async function getSession(voiceId: string, onProgress?: ProgressCb): Promise<{ session: any; config: any }> {
  let entry = sessions.get(voiceId);
  if (entry) return entry;
  const o = await ort();
  const f = filesFor(voiceId);
  const config = JSON.parse(new TextDecoder().decode(await getModelBytes(f.json)));
  const modelBytes = await getModelBytes(f.onnx, onProgress);
  const session = await o.InferenceSession.create(new Uint8Array(modelBytes));
  entry = { session, config };
  sessions.set(voiceId, entry);
  return entry;
}

/** Synthesize one utterance to a WAV Blob. */
export async function piperSynthesize(text: string, voiceId: string): Promise<Blob> {
  const o = await ort();
  const { session, config } = await getSession(voiceId);
  const ids = await phonemize(text, config.espeak.voice);
  const feeds: Record<string, any> = {
    input: new o.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
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

/** Pre-download a voice's model into IndexedDB. */
export async function piperDownload(voiceId: string, onProgress?: ProgressCb): Promise<void> {
  const f = filesFor(voiceId);
  await getModelBytes(f.json);
  await getModelBytes(f.onnx, onProgress);
}

/** Which voices are already cached (so the download step can be skipped). */
export async function piperStored(): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const [id, f] of Object.entries(VOICE_FILES)) {
      if ((await idbHas(f.onnx)) && (await idbHas(f.json))) out.push(id);
    }
  } catch { /* IndexedDB unavailable; ignore */ }
  return out;
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
