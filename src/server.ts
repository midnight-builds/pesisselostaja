import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchLiveMatches } from "./api.js";
import type { WatcherController } from "./watcher.js";

const V2_DIST = fileURLToPath(new URL("../v2/dist", import.meta.url));
const DEBUG_LOG_FILE = fileURLToPath(new URL("../debug.log", import.meta.url));
const DEBUG_LOG_MAX_BODY = 8 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

async function serveV2(url: string, res: ServerResponse): Promise<void> {
  // Strip query/hash, drop the "/v2" prefix, default to index.html.
  const rel = url.replace(/[?#].*$/, "").replace(/^\/v2\/?/, "") || "index.html";
  const filePath = normalize(join(V2_DIST, rel));
  if (filePath !== V2_DIST && !filePath.startsWith(V2_DIST + "/")) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch {
    // SPA fallback: unknown paths render the app shell.
    try {
      const buf = await readFile(join(V2_DIST, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": buf.length });
      res.end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("v2 build not found — run `npm run build` in v2/");
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const HTML = `<!DOCTYPE html>
<html lang="fi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Pesisselostaja</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #07070f;
      --bg2: #0b0b18;
      --card: #0d0d1e;
      --card2: #11112a;
      --border: #1c1c3a;
      --accent: #ff4f00;
      --accent-dim: #c03a00;
      --active: #00ff88;
      --active-dim: #00bb66;
      --info: #00cfff;
      --warn: #ffd000;
      --text: #b8b8d8;
      --text-muted: #4a4a7a;
      --text-bright: #e8e8ff;
      --radius: 14px;
      --radius-sm: 8px;
    }

    html, body {
      min-height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 16px;
      line-height: 1.5;
    }

    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px 12px 40px;
      min-height: 100dvh;
      background: radial-gradient(ellipse at 50% 0%, #120820 0%, var(--bg) 70%);
    }

    .app {
      width: 100%;
      max-width: 480px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Header */
    .header {
      text-align: center;
      padding: 24px 0 8px;
    }
    .header h1 {
      font-size: clamp(18px, 5vw, 22px);
      font-weight: 700;
      letter-spacing: 0.05em;
      color: var(--text-bright);
      text-transform: uppercase;
    }
    .header h1 span { color: var(--accent); }
    .header .subtitle {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    /* Status badge */
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 10px 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 100px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--text-muted);
      flex-shrink: 0;
      transition: background 0.3s;
    }
    .status-dot.running {
      background: var(--active);
      box-shadow: 0 0 8px var(--active), 0 0 20px rgba(0,255,136,0.3);
      animation: pulse 2s ease-in-out infinite;
    }
    .status-dot.error {
      background: #ff3366;
      box-shadow: 0 0 8px #ff3366;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--active), 0 0 20px rgba(0,255,136,0.3); }
      50% { opacity: 0.7; box-shadow: 0 0 4px var(--active), 0 0 8px rgba(0,255,136,0.15); }
    }
    .status-text {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--text-muted);
      transition: color 0.3s;
    }
    .status-text.running { color: var(--active); }
    .status-text.error { color: #ff3366; }

    /* Card */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }

    /* Input */
    .input-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .input-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .match-input {
      flex: 1;
      background: var(--bg2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 13px 16px;
      color: var(--text-bright);
      font-size: 15px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      min-width: 0;
    }
    .match-input::placeholder { color: var(--text-muted); }
    .match-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(255,79,0,0.15);
    }
    .match-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Main toggle button */
    .btn-toggle {
      width: 100%;
      padding: 18px;
      border: none;
      border-radius: var(--radius);
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.25s;
      outline: none;
      position: relative;
      overflow: hidden;
    }
    .btn-toggle::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(to bottom, rgba(255,255,255,0.06), transparent);
      pointer-events: none;
    }
    .btn-toggle.start {
      background: var(--accent);
      color: #fff;
      box-shadow: 0 4px 24px rgba(255,79,0,0.35);
    }
    .btn-toggle.start:hover {
      background: #ff6820;
      box-shadow: 0 4px 32px rgba(255,79,0,0.5);
      transform: translateY(-1px);
    }
    .btn-toggle.start:active { transform: translateY(0); }
    .btn-toggle.stop {
      background: var(--card2);
      color: var(--active);
      border: 2px solid var(--active-dim);
      box-shadow: 0 0 20px rgba(0,255,136,0.12);
    }
    .btn-toggle.stop:hover {
      background: rgba(0,255,136,0.08);
      box-shadow: 0 0 28px rgba(0,255,136,0.2);
    }
    .btn-toggle:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    /* Match info */
    .match-info {
      display: none;
      flex-direction: column;
      gap: 6px;
    }
    .match-info.visible { display: flex; }
    .match-teams {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-bright);
      line-height: 1.2;
    }
    .match-meta {
      font-size: 13px;
      color: var(--text-muted);
    }
    .match-meta span {
      display: inline-block;
      margin-right: 12px;
    }
    .match-meta .dot { color: var(--border); margin-right: 12px; }

    /* Live matches */
    .live-matches-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .live-matches-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 2px;
    }
    .live-match-btn {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      background: var(--bg2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 16px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.2s, background 0.2s;
      font-family: inherit;
      color: var(--text-bright);
    }
    .live-match-btn:hover {
      border-color: var(--accent);
      background: rgba(255,79,0,0.06);
    }
    .live-match-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .live-match-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--active);
      box-shadow: 0 0 6px var(--active);
      flex-shrink: 0;
      animation: pulse 2s ease-in-out infinite;
    }
    .live-match-teams {
      font-size: 14px;
      font-weight: 600;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .live-match-series {
      font-size: 11px;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .live-matches-empty {
      font-size: 13px;
      color: var(--text-muted);
      font-style: italic;
      padding: 4px 0;
    }
    .live-matches-loading {
      font-size: 13px;
      color: var(--text-muted);
      padding: 4px 0;
    }
    .live-match-btn.favorite {
      border-color: var(--accent);
      background: rgba(255,79,0,0.07);
    }
    .live-match-btn.favorite:hover {
      background: rgba(255,79,0,0.14);
    }
    .live-match-star {
      color: var(--accent);
      font-size: 11px;
      flex-shrink: 0;
    }
    .favorites-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .favorites-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .favorites-input {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 10px;
      color: var(--text-bright);
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
      min-width: 0;
    }
    .favorites-input::placeholder { color: var(--text-muted); }
    .favorites-input:focus { border-color: var(--accent); }

    /* Dry-run badge */
    .dry-run-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255,208,0,0.1);
      border: 1px solid rgba(255,208,0,0.3);
      color: var(--warn);
      padding: 6px 12px;
      border-radius: 100px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    .dry-run-badge.hidden { display: none; }

    /* Output selector */
    .output-selector {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
    }
    .output-btn {
      flex: 1;
      padding: 10px 8px;
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg2);
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s;
    }
    .output-btn:hover { border-color: var(--accent-dim); color: var(--text); }
    .output-btn.active {
      border-color: var(--accent);
      background: rgba(255,79,0,0.12);
      color: var(--accent);
    }
    .output-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-unlock {
      width: 100%;
      margin-top: 12px;
      padding: 11px;
      border: 1.5px solid var(--info);
      border-radius: var(--radius-sm);
      background: rgba(0,207,255,0.06);
      color: var(--info);
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-unlock:hover { background: rgba(0,207,255,0.14); }
    .btn-unlock.unlocked {
      border-color: var(--active);
      color: var(--active);
      background: rgba(0,255,136,0.06);
      cursor: default;
    }
    .btn-unlock.hidden { display: none; }

    /* Error message */
    .error-msg {
      background: rgba(255,51,102,0.1);
      border: 1px solid rgba(255,51,102,0.3);
      color: #ff6688;
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      display: none;
    }
    .error-msg.visible { display: block; }

    /* Log terminal */
    .log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .log-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .log-clear {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 11px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: inherit;
      transition: color 0.2s;
    }
    .log-clear:hover { color: var(--text); }
    .log-terminal {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px;
      height: 260px;
      overflow-y: auto;
      font-family: "JetBrains Mono", "Fira Code", "Courier New", monospace;
      font-size: 12px;
      line-height: 1.7;
      color: #7878a8;
      scroll-behavior: smooth;
    }
    .log-terminal::-webkit-scrollbar { width: 4px; }
    .log-terminal::-webkit-scrollbar-track { background: transparent; }
    .log-terminal::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .log-line { word-break: break-all; }
    .log-line.speech { color: var(--active); }
    .log-line.error { color: #ff6688; }
    .log-line.info { color: var(--info); }
    .log-line.test { color: var(--warn); }
    .log-empty { color: var(--text-muted); font-style: italic; }

    /* Pronunciation editor */
    .pron-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }
    .pron-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .pron-input {
      flex: 1;
      background: var(--bg2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 9px 12px;
      color: var(--text-bright);
      font-size: 13px;
      font-family: inherit;
      outline: none;
      min-width: 0;
      transition: border-color 0.2s;
    }
    .pron-input:focus { border-color: var(--accent); }
    .pron-arrow { color: var(--text-muted); font-size: 13px; flex-shrink: 0; }
    .pron-del {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 14px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      flex-shrink: 0;
      transition: color 0.2s;
    }
    .pron-del:hover { color: #ff6688; }
    .pron-status { font-size: 12px; color: var(--text-muted); margin-top: 8px; min-height: 16px; }
  </style>
</head>
<body>
  <div class="app">

    <div class="header">
      <h1>Pesis<span>selostaja</span></h1>
      <div class="subtitle">Live-äänikommentaari</div>
    </div>

    <div class="card">
      <label class="input-label">Ääntoisto</label>
      <div class="output-selector">
        <button class="output-btn active" id="outputHA" onclick="selectOutput('ha')">Kotiautomaatio</button>
        <button class="output-btn" id="outputBrowser" onclick="selectOutput('browser')">Tämä laite</button>
      </div>
      <button class="btn-unlock hidden" id="unlockBtn" onclick="unlockAudio()">Avaa ääni ensin</button>
      <label class="input-label" style="margin-top:14px" for="matchInput">Ottelu — URL tai ID</label>
      <div class="input-row">
        <input
          class="match-input"
          id="matchInput"
          type="text"
          placeholder="esim. 140619 tai pesistulokset.fi/…/ottelut/140619"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        >
      </div>
    </div>

    <div id="errorMsg" class="error-msg"></div>

    <button class="btn-toggle start" id="toggleBtn" onclick="handleToggle()">
      Käynnistä seuranta
    </button>

    <div class="card match-info" id="matchInfo">
      <div class="match-teams" id="matchTeams">–</div>
      <div class="match-meta">
        <span id="matchSeries"></span>
        <span class="dot">·</span>
        <span id="matchStadium"></span>
      </div>
    </div>

    <div id="dryRunBadge" class="dry-run-badge hidden">
      ⚠ Testitila — HA ei konfiguroitu
    </div>

    <div class="status-bar">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-text" id="statusText">Ei käynnissä</div>
    </div>

    <div class="card" id="liveMatchesCard">
      <div class="live-matches-section">
        <div class="favorites-row">
          <span class="favorites-label">Suosikit</span>
          <input class="favorites-input" id="favInput" placeholder="esim. Pesä Ysit,IPV" autocomplete="off" spellcheck="false">
        </div>
        <div class="live-matches-label">Käynnissä olevat pelit</div>
        <div id="liveMatchesList"><div class="live-matches-loading">Ladataan…</div></div>
      </div>
    </div>

    <div class="card">
      <div class="log-header">
        <div class="log-title">Ääntäminen</div>
        <button class="log-clear" onclick="addPronRow()">+ Lisää</button>
      </div>
      <div class="pron-hint">Termejä, jotka puhesyntetisaattori lukee väärin. Vasen: teksti, oikea: miten luetaan.</div>
      <div id="pronList"></div>
      <button class="btn-unlock" id="pronSaveBtn" style="margin-top:12px" onclick="savePronunciations()">Tallenna ääntäminen</button>
      <div class="pron-status" id="pronStatus"></div>
    </div>

    <div class="card">
      <div class="log-header">
        <div class="log-title">Loki</div>
        <button class="log-clear" onclick="clearLog()">Tyhjennä</button>
      </div>
      <div class="log-terminal" id="logTerminal">
        <div class="log-empty">Odottaa käynnistystä…</div>
      </div>
    </div>

    <div class="disclaimer" style="margin-top:16px;font-size:12px;line-height:1.5;opacity:0.6;text-align:center">
      Sovellus käyttää pesistulokset.fi-palvelun otteludataa. Tämä projekti on itsenäinen, eikä se ole pesistulokset.fi:n tekemä, hyväksymä tai sponsoroima.
    </div>

  </div>

  <script>
    let lastLogSig = '';
    let isRunning = false;
    let pollTimer = null;
    let selectedOutput = 'ha';
    let sseSource = null;
    let audioUnlocked = false;

    function selectOutput(mode) {
      if (isRunning) return;
      selectedOutput = mode;
      document.getElementById('outputHA').classList.toggle('active', mode === 'ha');
      document.getElementById('outputBrowser').classList.toggle('active', mode === 'browser');
      document.getElementById('unlockBtn').classList.toggle('hidden', mode === 'ha');
    }

    function unlockAudio() {
      const utt = new SpeechSynthesisUtterance('');
      speechSynthesis.speak(utt);
      audioUnlocked = true;
      const btn = document.getElementById('unlockBtn');
      btn.textContent = 'Ääni avattu ✓';
      btn.classList.add('unlocked');
      btn.onclick = null;
      // If a browser-mode watch is already running, the server may be holding the
      // startup speech until the device audio is ready — release it now.
      if (isRunning && selectedOutput === 'browser') signalAudioReady();
    }

    function signalAudioReady() {
      fetch('/api/audio-ready', { method: 'POST' }).catch(() => {});
    }

    function connectSSE() {
      if (sseSource) return;
      sseSource = new EventSource('/api/speech-stream');
      sseSource.onmessage = function(e) {
        const utt = new SpeechSynthesisUtterance(e.data);
        utt.lang = 'fi-FI';
        speechSynthesis.speak(utt);
      };
    }

    function disconnectSSE() {
      if (sseSource) { sseSource.close(); sseSource = null; }
      speechSynthesis.cancel();
    }

    async function fetchStatus() {
      try {
        const r = await fetch('/api/status');
        const s = await r.json();
        updateUI(s);
      } catch (e) {
        console.error('Status fetch failed', e);
      }
    }

    function updateUI(s) {
      const dot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      const btn = document.getElementById('toggleBtn');
      const matchInfo = document.getElementById('matchInfo');
      const matchTeams = document.getElementById('matchTeams');
      const matchSeries = document.getElementById('matchSeries');
      const matchStadium = document.getElementById('matchStadium');
      const input = document.getElementById('matchInput');
      const errorMsg = document.getElementById('errorMsg');
      const dryBadge = document.getElementById('dryRunBadge');

      isRunning = s.running;

      // Status dot & text
      dot.className = 'status-dot' + (s.running ? ' running' : (s.error ? ' error' : ''));
      statusText.className = 'status-text' + (s.running ? ' running' : (s.error ? ' error' : ''));
      statusText.textContent = s.running
        ? 'Seuranta käynnissä'
        : (s.error ? 'Virhe' : 'Ei käynnissä');

      // Button
      if (s.running) {
        btn.className = 'btn-toggle stop';
        btn.textContent = 'Pysäytä seuranta';
        input.disabled = true;
        document.querySelectorAll('.live-match-btn').forEach(b => b.disabled = true);
      } else {
        btn.className = 'btn-toggle start';
        btn.textContent = 'Käynnistä seuranta';
        input.disabled = false;
        document.querySelectorAll('.live-match-btn').forEach(b => b.disabled = false);
      }

      // Match info
      if (s.matchInfo) {
        matchInfo.className = 'card match-info visible';
        matchTeams.textContent = s.matchInfo;
        matchSeries.textContent = s.seriesName || '';
        matchStadium.textContent = s.stadiumName || '';
      } else {
        matchInfo.className = 'card match-info';
      }

      // Dry run badge — hide in browser mode since HA is not used intentionally
      dryBadge.className = 'dry-run-badge' + ((s.dryRun && s.speechMode !== 'browser') ? '' : ' hidden');

      // Output selector sync
      if (s.running) {
        document.getElementById('outputHA').disabled = true;
        document.getElementById('outputBrowser').disabled = true;
        const activeMode = s.speechMode || 'ha';
        document.getElementById('outputHA').classList.toggle('active', activeMode === 'ha');
        document.getElementById('outputBrowser').classList.toggle('active', activeMode === 'browser');
        if (activeMode === 'browser') {
          document.getElementById('unlockBtn').classList.remove('hidden');
          if (!sseSource) connectSSE();
        }
      } else {
        document.getElementById('outputHA').disabled = false;
        document.getElementById('outputBrowser').disabled = false;
        if (sseSource) { sseSource.close(); sseSource = null; speechSynthesis.cancel(); }
      }

      // Error
      if (s.error && !s.running) {
        errorMsg.className = 'error-msg visible';
        errorMsg.textContent = s.error;
      } else {
        errorMsg.className = 'error-msg';
      }

      // Log
      updateLog(s.log);
    }

    function classifyLine(line) {
      if (/Puhe:/.test(line)) return 'speech';
      if (/Virhe|virhe|error/i.test(line)) return 'error';
      if (line.includes('[TESTI]')) return 'test';
      if (/Haetaan|Ohitetaan|Seuranta|pelaaj|Sarja|Kenttä/i.test(line)) return 'info';
      return '';
    }

    function updateLog(lines) {
      if (!lines) return;
      const sig = lines.join('\\n');
      if (sig === lastLogSig) return;
      lastLogSig = sig;
      const terminal = document.getElementById('logTerminal');
      const atBottom = terminal.scrollHeight - terminal.clientHeight <= terminal.scrollTop + 40;
      terminal.innerHTML = lines.length === 0
        ? '<div class="log-empty">Odottaa käynnistystä…</div>'
        : lines.map(l => {
            const cls = classifyLine(l);
            const safe = l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            return \`<div class="log-line \${cls}">\${safe}</div>\`;
          }).join('');
      if (atBottom) terminal.scrollTop = terminal.scrollHeight;
    }

    async function clearLog() {
      await fetch('/api/clear-log', { method: 'POST' });
      lastLogSig = '';
      document.getElementById('logTerminal').innerHTML =
        '<div class="log-empty">Loki tyhjennetty.</div>';
    }

    async function handleToggle() {
      const btn = document.getElementById('toggleBtn');
      btn.disabled = true;

      if (isRunning) {
        await fetch('/api/stop', { method: 'POST' });
        disconnectSSE();
      } else {
        const match = document.getElementById('matchInput').value.trim();
        if (!match) {
          document.getElementById('errorMsg').className = 'error-msg visible';
          document.getElementById('errorMsg').textContent = 'Anna ottelun URL tai ID.';
          btn.disabled = false;
          return;
        }
        const r = await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ match, output: selectedOutput }),
        });
        const data = await r.json();
        if (!data.ok) {
          document.getElementById('errorMsg').className = 'error-msg visible';
          document.getElementById('errorMsg').textContent = data.error || 'Tuntematon virhe';
          btn.disabled = false;
          return;
        }
        document.getElementById('errorMsg').className = 'error-msg';
        lastLogSig = '';
        if (selectedOutput === 'browser') {
          connectSSE();
          // Tell the server the device is ready so it can release the startup speech.
          if (audioUnlocked) signalAudioReady();
        }
      }

      await fetchStatus();
      btn.disabled = false;
    }

    // Enter key on input
    document.getElementById('matchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isRunning) handleToggle();
    });

    const FAV_KEY = 'pesisselostaja-favorites';
    const FAV_DEFAULT = 'Pesä Ysit,IPV';

    function getFavorites() {
      return (localStorage.getItem(FAV_KEY) ?? FAV_DEFAULT)
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    function isFavorite(m, favs) {
      const names = [m.home.shorthand, m.home.name, m.away.shorthand, m.away.name]
        .filter(Boolean).map(s => s.toLowerCase());
      return favs.some(fav => names.some(n => n.includes(fav)));
    }

    function initFavInput() {
      const input = document.getElementById('favInput');
      input.value = localStorage.getItem(FAV_KEY) ?? FAV_DEFAULT;
      input.addEventListener('change', () => {
        localStorage.setItem(FAV_KEY, input.value);
        renderMatches(window._lastMatches);
      });
    }

    window._lastMatches = [];

    function renderMatches(matches) {
      window._lastMatches = matches || [];
      const list = document.getElementById('liveMatchesList');
      if (!matches || matches.length === 0) {
        list.innerHTML = '<div class="live-matches-empty">Ei käynnissä olevia pelejä.</div>';
        return;
      }
      const favs = getFavorites();
      const sorted = [...matches].sort((a, b) => {
        return (isFavorite(b, favs) ? 1 : 0) - (isFavorite(a, favs) ? 1 : 0);
      });
      list.innerHTML = sorted.map(m => {
        const fav = isFavorite(m, favs);
        const series = m.seriesName || '';
        const teams = \`\${m.home.shorthand || m.home.name} — \${m.away.shorthand || m.away.name}\`;
        const cls = fav ? 'live-match-btn favorite' : 'live-match-btn';
        const star = fav ? '<span class="live-match-star">★</span>' : '';
        return \`<button class="\${cls}" onclick="selectMatch(\${m.id})">
          \${star}
          <span class="live-match-dot"></span>
          <span class="live-match-teams">\${teams}</span>
          \${series ? \`<span class="live-match-series">\${series}</span>\` : ''}
        </button>\`;
      }).join('');
    }

    async function loadLiveMatches(attempt = 0) {
      const list = document.getElementById('liveMatchesList');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        let matches;
        try {
          const r = await fetch('/api/live-matches', { signal: ctrl.signal });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          matches = await r.json();
        } finally {
          clearTimeout(timer);
        }
        if (!Array.isArray(matches)) throw new Error('bad response');
        renderMatches(matches);
      } catch {
        if (attempt < 3) {
          list.innerHTML = '<div class="live-matches-loading">Ladataan…</div>';
          setTimeout(() => loadLiveMatches(attempt + 1), 2000);
          return;
        }
        list.innerHTML = '<div class="live-matches-empty">Ei voitu ladata pelejä. <a href="#" onclick="loadLiveMatches(0);return false;">Yritä uudelleen</a></div>';
      }
    }

    function selectMatch(id) {
      if (isRunning) return;
      document.getElementById('matchInput').value = String(id);
      document.getElementById('errorMsg').className = 'error-msg';
    }

    // ── Pronunciation editor ──────────────────────────────────────────────
    function addPronRow(from, to) {
      const list = document.getElementById('pronList');
      const row = document.createElement('div');
      row.className = 'pron-row';

      const f = document.createElement('input');
      f.className = 'pron-input pron-from';
      f.placeholder = 'KPL';
      f.value = from || '';

      const arrow = document.createElement('span');
      arrow.className = 'pron-arrow';
      arrow.textContent = '→';

      const t = document.createElement('input');
      t.className = 'pron-input pron-to';
      t.placeholder = 'Koo Pee Äl';
      t.value = to || '';

      const del = document.createElement('button');
      del.className = 'pron-del';
      del.textContent = '✕';
      del.title = 'Poista';
      del.onclick = () => row.remove();

      row.appendChild(f);
      row.appendChild(arrow);
      row.appendChild(t);
      row.appendChild(del);
      list.appendChild(row);
    }

    function renderPronList(rules) {
      const list = document.getElementById('pronList');
      list.innerHTML = '';
      if (!rules || rules.length === 0) {
        addPronRow();
        return;
      }
      rules.forEach(r => addPronRow(r.from, r.to));
    }

    async function loadPronunciations() {
      try {
        const r = await fetch('/api/pronunciations');
        const rules = await r.json();
        renderPronList(Array.isArray(rules) ? rules : []);
      } catch {
        renderPronList([]);
      }
    }

    async function savePronunciations() {
      const rows = document.querySelectorAll('#pronList .pron-row');
      const rules = [];
      rows.forEach(row => {
        const from = row.querySelector('.pron-from').value.trim();
        const to = row.querySelector('.pron-to').value.trim();
        if (from && to) rules.push({ from, to });
      });
      const status = document.getElementById('pronStatus');
      status.textContent = 'Tallennetaan…';
      try {
        const r = await fetch('/api/pronunciations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rules),
        });
        const data = await r.json();
        if (data.ok) {
          status.textContent = 'Tallennettu ✓';
          renderPronList(data.pronunciations || rules);
        } else {
          status.textContent = data.error || 'Tallennus epäonnistui';
        }
      } catch {
        status.textContent = 'Tallennus epäonnistui';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    }

    // Poll every 2 seconds
    fetchStatus();
    setInterval(fetchStatus, 2000);

    // Load live matches once on startup (no active refresh)
    initFavInput();
    loadLiveMatches();
    loadPronunciations();
  </script>
</body>
</html>`;

export function startServer(watcher: WatcherController, port: number): void {
  const sseClients = new Set<ServerResponse>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (url === "/" && method === "GET") {
      const buf = Buffer.from(HTML, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
      res.end(buf);
      return;
    }

    if (url === "/api/status" && method === "GET") {
      json(res, watcher.getStatus());
      return;
    }

    if (url === "/api/speech-stream" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(":ok\n\n");
      sseClients.add(res);
      const keepalive = setInterval(() => { res.write(":ping\n\n"); }, 20000);
      req.on("close", () => { clearInterval(keepalive); sseClients.delete(res); });
      return;
    }

    if (url === "/api/start" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        if (typeof body.match !== "string" || !body.match.trim()) {
          json(res, { ok: false, error: "match-kenttä puuttuu" }, 400);
          return;
        }
        const speechMode = body.output === "browser" ? "browser" : "ha";
        const onSpeech = speechMode === "browser"
          ? (text: string) => {
              const safe = text.replace(/\n/g, " ");
              for (const client of sseClients) client.write(`data: ${safe}\n\n`);
            }
          : undefined;
        watcher.start(body.match, { speechMode, onSpeech });
        json(res, { ok: true });
      } catch (err) {
        json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    }

    if (url === "/api/stop" && method === "POST") {
      watcher.stop();
      json(res, { ok: true });
      return;
    }

    if (url === "/api/clear-log" && method === "POST") {
      watcher.clearLog();
      json(res, { ok: true });
      return;
    }

    if (url === "/api/audio-ready" && method === "POST") {
      watcher.markBrowserReady();
      json(res, { ok: true });
      return;
    }

    if (url === "/api/debug-log" && method === "POST") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.slice(0, DEBUG_LOG_MAX_BODY));
        const line = JSON.stringify({ receivedAt: new Date().toISOString(), ...body });
        await appendFile(DEBUG_LOG_FILE, line + "\n", "utf-8");
      } catch { /* malformed entry — drop it, logging must never break the client */ }
      json(res, { ok: true });
      return;
    }

    if (url === "/api/pronunciations" && method === "GET") {
      json(res, watcher.getPronunciations());
      return;
    }

    if (url === "/api/pronunciations" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body)) {
          json(res, { ok: false, error: "Odotettiin taulukkoa" }, 400);
          return;
        }
        const rules = body
          .filter((r) => r && typeof r.from === "string" && typeof r.to === "string")
          .map((r) => ({ from: String(r.from).trim(), to: String(r.to) }))
          .filter((r) => r.from);
        watcher.setPronunciations(rules);
        json(res, { ok: true, pronunciations: rules });
      } catch (err) {
        json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return;
    }

    if (url === "/api/live-matches" && method === "GET") {
      try {
        const matches = await fetchLiveMatches({
          apiBase: watcher.config.apiBase,
          apiKey: watcher.config.apiKey,
        });
        json(res, matches);
      } catch {
        json(res, { error: "fetch-failed" }, 503);
      }
      return;
    }

    if (url === "/v2" && method === "GET") {
      res.writeHead(301, { Location: "/v2/" });
      res.end();
      return;
    }

    if (url.startsWith("/v2/") && method === "GET") {
      await serveV2(url, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`UI: http://localhost:${port}`);
  });
}
