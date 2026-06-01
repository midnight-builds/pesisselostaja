import { BrowserWatcher, type WatcherConfig } from "./watcher.js";
import {
  loadPronunciations,
  savePronunciations,
  type PronunciationRule,
} from "./pronunciation.js";
import { fetchLiveMatches } from "./api.js";
import type { LiveMatchSummary } from "./types.js";

const DEFAULT_API_BASE = "https://api.pesistulokset.fi/api/v1";
const DEFAULT_API_KEY = "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";
const LS_FAVORITES = "pesistulokset-v2-favorites";
const LS_SETTINGS = "pesistulokset-v2-settings";

interface Settings {
  apiKey: string;
  apiBase: string;
  pollInterval: number;
  announceBatterChanges: boolean;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        apiKey: p.apiKey ?? DEFAULT_API_KEY,
        apiBase: p.apiBase ?? DEFAULT_API_BASE,
        pollInterval: p.pollInterval ?? 6,
        announceBatterChanges: p.announceBatterChanges ?? true,
      };
    }
  } catch { /* ignore */ }
  return { apiKey: DEFAULT_API_KEY, apiBase: DEFAULT_API_BASE, pollInterval: 6, announceBatterChanges: true };
}

function saveSettings(s: Settings): void {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

// ── Favorites ─────────────────────────────────────────────────────────────────

function getFavorites(): string[] {
  try {
    const raw = localStorage.getItem(LS_FAVORITES);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveFavorites(favs: string[]): void {
  localStorage.setItem(LS_FAVORITES, JSON.stringify(favs));
}

function isFavorite(match: LiveMatchSummary, favs: string[]): boolean {
  return favs.some((f) =>
    match.home.name.toLowerCase().includes(f.toLowerCase()) ||
    match.away.name.toLowerCase().includes(f.toLowerCase())
  );
}

// ── App state ─────────────────────────────────────────────────────────────────

let watcher: BrowserWatcher | null = null;
let pronunciations: PronunciationRule[] = loadPronunciations();
let settings: Settings = loadSettings();
let liveMatches: LiveMatchSummary[] = [];
let selectedMatchId: string = "";
let showAllMatches = false;

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusDot = el<HTMLDivElement>("status-dot");
const statusText = el<HTMLSpanElement>("status-text");
const matchInput = el<HTMLInputElement>("match-input");
const toggleBtn = el<HTMLButtonElement>("toggle-btn");
const unlockBtn = el<HTMLButtonElement>("unlock-btn");
const logEl = el<HTMLDivElement>("log");
const matchListEl = el<HTMLDivElement>("match-list");
const matchInfoEl = el<HTMLDivElement>("match-info");
const errorEl = el<HTMLDivElement>("error-msg");

// ── Log ───────────────────────────────────────────────────────────────────────

const logLines: string[] = [];

function appendLog(msg: string): void {
  logLines.push(msg);
  if (logLines.length > 300) logLines.shift();
  const div = document.createElement("div");
  div.className = "log-line";
  div.textContent = msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Status ────────────────────────────────────────────────────────────────────

function setRunning(running: boolean): void {
  statusDot.className = "dot " + (running ? "running" : "stopped");
  statusText.textContent = running ? "Seuranta käynnissä" : "Ei seurantaa";
  toggleBtn.textContent = running ? "Pysäytä" : "Käynnistä";
  toggleBtn.className = "btn " + (running ? "btn-stop" : "btn-start");
  unlockBtn.style.display = running ? "inline-flex" : "none";
  matchInput.disabled = running;
}

function showError(msg: string | null): void {
  if (msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }
}

// ── Live matches ──────────────────────────────────────────────────────────────

async function refreshLiveMatches(): Promise<void> {
  try {
    liveMatches = await fetchLiveMatches({
      apiBase: settings.apiBase,
      apiKey: settings.apiKey,
    });
  } catch {
    liveMatches = [];
  }
  renderMatchList();
}

function renderMatchList(): void {
  const favs = getFavorites();
  const shown = showAllMatches
    ? liveMatches
    : liveMatches.filter((m) => isFavorite(m, favs));

  if (liveMatches.length === 0) {
    matchListEl.innerHTML = '<p class="no-matches">Ei live-otteluita tänään</p>';
    return;
  }

  if (!showAllMatches && shown.length === 0) {
    matchListEl.innerHTML = `
      <p class="no-matches">Suosikkeja ei pelissä.
        <button class="link-btn" id="show-all-btn">Näytä kaikki (${liveMatches.length})</button>
      </p>`;
    el("show-all-btn").onclick = () => { showAllMatches = true; renderMatchList(); };
    return;
  }

  matchListEl.innerHTML = "";
  if (!showAllMatches && liveMatches.length > shown.length) {
    const allBtn = document.createElement("button");
    allBtn.className = "link-btn";
    allBtn.textContent = `+ Näytä kaikki (${liveMatches.length})`;
    allBtn.onclick = () => { showAllMatches = true; renderMatchList(); };
    matchListEl.appendChild(allBtn);
  }

  for (const m of shown) {
    const btn = document.createElement("button");
    btn.className = "match-btn" + (selectedMatchId === String(m.id) ? " selected" : "");
    const series = m.seriesName ? `<span class="series">${m.seriesName}</span> ` : "";
    btn.innerHTML = `${series}<strong>${m.home.shorthand}</strong> vs <strong>${m.away.shorthand}</strong>`;
    btn.onclick = () => selectMatch(m);
    matchListEl.appendChild(btn);
  }
}

function selectMatch(m: LiveMatchSummary): void {
  selectedMatchId = String(m.id);
  matchInput.value = String(m.id);
  renderMatchList();
}

// ── Toggle start/stop ─────────────────────────────────────────────────────────

function toggle(): void {
  showError(null);
  if (watcher?.running) {
    watcher.stop();
    watcher = null;
    setRunning(false);
    return;
  }

  const input = matchInput.value.trim();
  if (!input) {
    showError("Syötä ottelun ID tai URL.");
    return;
  }

  const config: WatcherConfig = {
    pollInterval: settings.pollInterval,
    announceBatterChanges: settings.announceBatterChanges,
    apiKey: settings.apiKey,
    apiBase: settings.apiBase,
  };

  watcher = new BrowserWatcher(config, {
    onLog: appendLog,
    onMatchInfo: ({ matchInfo, seriesName, stadiumName }) => {
      matchInfoEl.innerHTML = `<strong>${matchInfo}</strong>` +
        (seriesName ? ` · ${seriesName}` : "") +
        ` · ${stadiumName}`;
      matchInfoEl.style.display = "block";
    },
    onFinished: () => {
      setRunning(false);
      watcher = null;
    },
    onError: (err) => {
      showError(err);
      setRunning(false);
      watcher = null;
    },
  });

  watcher.setPronunciations(pronunciations);
  watcher.start(input);
  setRunning(true);
  appendLog(`Käynnistetään seuranta: ${input}`);
}

// ── Audio unlock ──────────────────────────────────────────────────────────────

function unlockAudio(): void {
  // iOS/Android require a user gesture before speechSynthesis works.
  // Speak an empty utterance to unlock the audio context.
  const utt = new SpeechSynthesisUtterance("");
  utt.lang = "fi-FI";
  utt.volume = 0;
  window.speechSynthesis.speak(utt);
  watcher?.markAudioUnlocked();
  unlockBtn.textContent = "Ääni käynnistetty";
  unlockBtn.disabled = true;
}

// ── Settings panel ────────────────────────────────────────────────────────────

function initSettings(): void {
  el<HTMLInputElement>("setting-api-key").value = settings.apiKey;
  el<HTMLInputElement>("setting-api-base").value = settings.apiBase;
  el<HTMLInputElement>("setting-poll-interval").value = String(settings.pollInterval);
  el<HTMLInputElement>("setting-batter-changes").checked = settings.announceBatterChanges;
}

function saveSettingsFromForm(): void {
  settings = {
    apiKey: el<HTMLInputElement>("setting-api-key").value.trim() || DEFAULT_API_KEY,
    apiBase: el<HTMLInputElement>("setting-api-base").value.trim() || DEFAULT_API_BASE,
    pollInterval: Math.max(1, parseInt(el<HTMLInputElement>("setting-poll-interval").value) || 6),
    announceBatterChanges: el<HTMLInputElement>("setting-batter-changes").checked,
  };
  saveSettings(settings);
  appendLog("Asetukset tallennettu.");
}

// ── Pronunciation editor ──────────────────────────────────────────────────────

function renderPronunciations(): void {
  const container = el<HTMLDivElement>("pronunciation-list");
  container.innerHTML = "";
  for (let i = 0; i < pronunciations.length; i++) {
    const row = document.createElement("div");
    row.className = "pron-row";
    row.innerHTML = `
      <input class="pron-from" type="text" value="${escHtml(pronunciations[i].from)}" placeholder="Termi" />
      <span>→</span>
      <input class="pron-to" type="text" value="${escHtml(pronunciations[i].to)}" placeholder="Ääntämys" />
      <button class="btn btn-sm btn-danger pron-del" data-i="${i}">✕</button>`;
    container.appendChild(row);
  }
  container.querySelectorAll<HTMLInputElement>(".pron-from").forEach((inp, i) => {
    inp.oninput = () => { pronunciations[i].from = inp.value; };
  });
  container.querySelectorAll<HTMLInputElement>(".pron-to").forEach((inp, i) => {
    inp.oninput = () => { pronunciations[i].to = inp.value; };
  });
  container.querySelectorAll<HTMLButtonElement>(".pron-del").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.i ?? "0");
      pronunciations.splice(idx, 1);
      savePronunciations(pronunciations);
      watcher?.setPronunciations(pronunciations);
      renderPronunciations();
    };
  });
}

function addPronunciationRow(): void {
  pronunciations.push({ from: "", to: "" });
  renderPronunciations();
}

function saveProns(): void {
  savePronunciations(pronunciations);
  watcher?.setPronunciations(pronunciations);
  appendLog("Ääntämiskorjaukset tallennettu.");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Collapsible sections ──────────────────────────────────────────────────────

function initCollapsibles(): void {
  document.querySelectorAll<HTMLElement>(".collapsible-header").forEach((header) => {
    header.onclick = () => {
      const content = header.nextElementSibling as HTMLElement;
      const isOpen = content.style.display !== "none";
      content.style.display = isOpen ? "none" : "block";
      header.classList.toggle("open", !isOpen);
    };
  });
}

// ── Favorites management ──────────────────────────────────────────────────────

function renderFavoritesEditor(): void {
  const favs = getFavorites();
  const container = el<HTMLDivElement>("favorites-list");
  container.innerHTML = "";
  for (const f of favs) {
    const chip = document.createElement("span");
    chip.className = "fav-chip";
    chip.textContent = f;
    const del = document.createElement("button");
    del.className = "fav-del";
    del.textContent = "✕";
    del.onclick = () => {
      const updated = getFavorites().filter((x) => x !== f);
      saveFavorites(updated);
      renderFavoritesEditor();
      renderMatchList();
    };
    chip.appendChild(del);
    container.appendChild(chip);
  }
}

function addFavorite(): void {
  const inp = el<HTMLInputElement>("fav-input");
  const val = inp.value.trim();
  if (!val) return;
  const favs = getFavorites();
  if (!favs.includes(val)) {
    favs.push(val);
    saveFavorites(favs);
    renderFavoritesEditor();
    renderMatchList();
  }
  inp.value = "";
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function init(): void {
  setRunning(false);
  initSettings();
  initCollapsibles();
  renderPronunciations();
  renderFavoritesEditor();
  refreshLiveMatches();

  toggleBtn.onclick = toggle;
  unlockBtn.onclick = unlockAudio;

  el("save-settings-btn").onclick = saveSettingsFromForm;
  el("add-pron-btn").onclick = addPronunciationRow;
  el("save-pron-btn").onclick = saveProns;
  el("refresh-matches-btn").onclick = () => refreshLiveMatches();
  el("add-fav-btn").onclick = addFavorite;
  el<HTMLInputElement>("fav-input").onkeydown = (e) => { if (e.key === "Enter") addFavorite(); };

  // Refresh match list every 30s
  setInterval(refreshLiveMatches, 30000);
}

document.addEventListener("DOMContentLoaded", init);
