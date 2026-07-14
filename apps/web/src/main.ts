import {
  BrowserWatcher,
  type WatcherConfig,
  type MatchSnapshot,
  type FeedType,
} from "./watcher.js";
import {
  loadPronunciations,
  savePronunciations,
  type PronunciationRule,
} from "./pronunciation.js";
import { fetchTodayMatches } from "@pesisselostaja/core";
import { PIPER_VOICES, piperStored, piperDownload } from "./piper.js";
import { debugLog } from "./debuglog.js";
import type { LiveMatchSummary } from "@pesisselostaja/core";

const DEFAULT_API_BASE = "https://api.pesistulokset.fi/api/v1";
const DEFAULT_API_KEY = "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";
const REPO_URL = "https://github.com/midnight-builds/pesisselostaja";
const CREDITS_URL = `${REPO_URL}/blob/main/CREDITS.md`;
const SITE_URL = "https://www.pesistulokset.fi";
const MATCH_PAGE_BASE = `${SITE_URL}/ottelut`;
const LS_SETTINGS = "pesisselostaja-v2-settings";
const LS_FAVS = "pesisselostaja-v2-favs";
const LS_FAV_TEAMS = "pesisselostaja-v2-fav-teams";

interface Settings {
  apiKey: string;
  apiBase: string;
  pollInterval: number;
  announceBatterChanges: boolean;
  voiceName: string;
  voiceEngine: "browser" | "piper" | "elevenlabs";
  piperVoiceId: string;
  elevenLabsApiKey: string;
  volumeBoost: boolean;
  keepScreenOn: boolean;
}

const DEFAULT_PIPER_VOICE = "fi_FI-harri-medium";

interface FeedEntry {
  id: number;
  type: FeedType;
  text: string;
  time: string;
}

// ── Persistence ─────────────────────────────────────────────────────────────

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
        voiceName: p.voiceName ?? "",
        voiceEngine: p.voiceEngine === "piper" || p.voiceEngine === "elevenlabs" ? p.voiceEngine : "browser",
        piperVoiceId: p.piperVoiceId ?? DEFAULT_PIPER_VOICE,
        elevenLabsApiKey: p.elevenLabsApiKey ?? "",
        volumeBoost: p.volumeBoost ?? false,
        keepScreenOn: p.keepScreenOn ?? true,
      };
    }
  } catch { /* ignore */ }
  return { apiKey: DEFAULT_API_KEY, apiBase: DEFAULT_API_BASE, pollInterval: 6, announceBatterChanges: true, voiceName: "", voiceEngine: "browser", piperVoiceId: DEFAULT_PIPER_VOICE, elevenLabsApiKey: "", volumeBoost: false, keepScreenOn: true };
}

function saveSettings(): void {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
}

function loadFavs(): number[] {
  try {
    const raw = localStorage.getItem(LS_FAVS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(Number).filter((n) => !Number.isNaN(n)) : [];
  } catch { return []; }
}

function saveFavs(): void {
  localStorage.setItem(LS_FAVS, JSON.stringify(favs));
}

function loadFavTeams(): string[] {
  try {
    const raw = localStorage.getItem(LS_FAV_TEAMS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
  } catch { return []; }
}

function saveFavTeams(): void {
  localStorage.setItem(LS_FAV_TEAMS, JSON.stringify(favTeams));
}

// ── App state ───────────────────────────────────────────────────────────────

let settings: Settings = loadSettings();
let pronunciations: PronunciationRule[] = loadPronunciations();
let favs: number[] = loadFavs();
let favTeams: string[] = loadFavTeams();

let view: "list" | "match" = "list";
let filter: "all" | "fav" = "all";
let scope: "live" | "all" = "live";
let todayMatches: LiveMatchSummary[] = [];
let matchesLoaded = false;

let watcher: BrowserWatcher | null = null;
let openId: number | null = null;
let listening = false;
let snapshot: MatchSnapshot | null = null;
let feed: FeedEntry[] = [];
let freshId = -1;
let feedSeq = 0;
let speakingActive = false;
let speakingTimer: number | undefined;
let matchError: string | null = null;

let settingsOpen = false;
let advancedOpen = false;
let toastTimer: number | undefined;

const root = document.getElementById("root") as HTMLDivElement;

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function teamColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 40%)`;
}

function badgeText(shorthand: string, name: string): string {
  const src = (shorthand || name || "?").trim();
  return src.slice(0, 3).toUpperCase();
}

function periodLabel(period: number): string {
  switch (period) {
    case 0: return "1. jakso";
    case 1: return "2. jakso";
    case 2: return "Supervuoro";
    case 3: return "Kotiutus";
    default: return `${period + 1}. jakso`;
  }
}

function nowClock(): string {
  return new Date().toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
}

function todayLabel(): string {
  return new Date().toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric" });
}

const FEED_ICON: Record<FeedType, string> = {
  run: "diamond", out: "x", period: "flag", bat: "bat",
  summary: "info", info: "info", end: "trophy",
};

function icon(name: string, size = 20, stroke = 2): string {
  const open = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">`;
  switch (name) {
    case "ball": return `${open}<circle cx="12" cy="12" r="9"/><path d="M5 8c4 1 10 1 14 0M5 16c4-1 10-1 14 0"/></svg>`;
    case "star-fill": return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>`;
    case "star": return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>`;
    case "gear": return `${open}<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1A2 2 0 1 1 7 4.6l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z"/></svg>`;
    case "back": return `${open}<path d="M15 5l-7 7 7 7"/></svg>`;
    case "bat": return `${open}<path d="M19 5l-9 9M6 18l3-3M5 19l1-1"/><circle cx="6.5" cy="17.5" r="1.4"/></svg>`;
    case "speaker": return `${open}<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12"/></svg>`;
    case "headset": return `${open}<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2.5" y="13" width="4" height="7" rx="1.5"/><rect x="17.5" y="13" width="4" height="7" rx="1.5"/></svg>`;
    case "refresh": return `${open}<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>`;
    case "diamond": return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l9 9-9 9-9-9z"/></svg>`;
    case "x": return `${open}<path d="M6 6l12 12M18 6L6 18"/></svg>`;
    case "flag": return `${open}<path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>`;
    case "trophy": return `${open}<path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M9 17h6M10 17v-2M14 17v-2M8 21h8"/></svg>`;
    case "info": return `${open}<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`;
    case "sun": return `${open}<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
    case "share": return `${open}<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/></svg>`;
    case "external": return `${open}<path d="M14 4h6v6M20 4l-8 8M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>`;
    default: return "";
  }
}

function toast(msg: string): void {
  const existing = root.querySelector(".toast");
  if (existing) existing.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  root.appendChild(t);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 2200);
}

// ── Audio unlock (browsers require a user gesture before TTS) ────────────────

let audioUnlocked = false;
let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  return (audioCtx ??= new Ctx());
}

// Must run inside a user gesture. Unlocks both Web Speech and the Piper audio
// path (resuming an AudioContext + playing a silent buffer counts as user
// activation for later HTMLAudioElement.play() calls on iOS).
function unlockAudio(): void {
  if (audioUnlocked) return;
  debugLog("unlock-audio");
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance("");
    u.lang = "fi-FI";
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
  const ctx = getAudioCtx();
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  }
  audioUnlocked = true;
}

// ── Screen wake lock ─────────────────────────────────────────────────────────
// Keep the screen awake while watching a match — when the phone screen sleeps,
// the browser suspends the page and speech stops.

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

let wakeLock: WakeLockSentinelLike | null = null;

async function requestWakeLock(): Promise<void> {
  const nav = navigator as Navigator & WakeLockNavigator;
  if (!nav.wakeLock) return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await nav.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => { /* ignore */ });
  wakeLock = null;
}

// The OS drops the lock when the page is hidden; re-acquire on return if the
// user still wants the screen kept on while in a match.
function onVisibilityChange(): void {
  debugLog("visibilitychange", {
    state: document.visibilityState,
    view,
    listening,
    audioCtxState: audioCtx?.state ?? null,
  });
  if (document.visibilityState === "visible") {
    if (settings.keepScreenOn && view === "match") void requestWakeLock();
    // iOS Safari pauses speechSynthesis and suspends the AudioContext while the
    // tab is hidden; nudge everything back to life so speech resumes on return.
    if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
    watcher?.resumeAudio();
  }
}

// ── Live match list ───────────────────────────────────────────────────────────

async function refreshTodayMatches(): Promise<void> {
  try {
    todayMatches = await fetchTodayMatches({ apiBase: settings.apiBase, apiKey: settings.apiKey });
  } catch {
    todayMatches = [];
  }
  matchesLoaded = true;
  if (view === "list") render();
}

function matchById(id: number): LiveMatchSummary | undefined {
  return todayMatches.find((m) => m.id === id);
}

function isMatchFav(m: LiveMatchSummary): boolean {
  if (favs.includes(m.id)) return true;
  for (const t of favTeams) {
    const tl = t.toLowerCase();
    if (
      m.home.shorthand.toLowerCase() === tl || m.away.shorthand.toLowerCase() === tl ||
      m.home.name.toLowerCase().includes(tl) || m.away.name.toLowerCase().includes(tl)
    ) return true;
  }
  return false;
}

function groupBySeries(list: LiveMatchSummary[]): [string, LiveMatchSummary[]][] {
  const map = new Map<string, LiveMatchSummary[]>();
  for (const m of list) {
    const key = m.seriesName || "Ottelut";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  return [...map.entries()];
}

// ── Watcher lifecycle ───────────────────────────────────────────────────────

function openMatch(id: number, withListen: boolean): void {
  stopWatcher();
  openId = id;
  view = "match";
  // Give the match its own shareable URL (#ottelu/<id>). pushState doesn't fire
  // hashchange/popstate, so this won't re-enter the router.
  const target = `#ottelu/${id}`;
  if (location.hash !== target) history.pushState(null, "", target);
  snapshot = null;
  feed = [];
  freshId = -1;
  matchError = null;
  listening = withListen;
  speakingActive = false;

  const config: WatcherConfig = {
    pollInterval: settings.pollInterval,
    announceBatterChanges: settings.announceBatterChanges,
    apiKey: settings.apiKey,
    apiBase: settings.apiBase,
  };

  watcher = new BrowserWatcher(config, {
    onLog: () => { /* feed + state cover the UI; log is for debugging */ },
    onMatchInfo: () => { /* names come via snapshot */ },
    onState: (snap) => {
      // emitState fires every poll; re-render only when something actually
      // changed, otherwise the full innerHTML rebuild flickers the page.
      const changed = !snapshot || JSON.stringify(snapshot) !== JSON.stringify(snap);
      snapshot = snap;
      if (changed && view === "match" && openId === id) deferredRender();
    },
    onFeed: (item) => {
      const entry: FeedEntry = { id: feedSeq++, type: item.type, text: item.text, time: nowClock() };
      feed.push(entry);
      if (feed.length > 200) feed.shift();
      freshId = entry.id;
      if (listening) flashSpeaking();
      if (view === "match" && openId === id) deferredRender();
    },
    onFinished: () => {
      if (view === "match" && openId === id) render();
    },
    onError: (err) => {
      matchError = err;
      if (view === "match" && openId === id) render();
    },
  });

  watcher.setPronunciations(pronunciations);
  watcher.setAudioContext(getAudioCtx());
  applyVoiceEngine();
  watcher.setMuted(!withListen);
  if (withListen) { unlockAudio(); watcher.markAudioUnlocked(); }
  if (settings.voiceEngine === "piper") void ensurePiperModel(settings.piperVoiceId);
  if (settings.keepScreenOn) void requestWakeLock();
  watcher.start(String(id));
  render();
}

function stopWatcher(): void {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  window.clearTimeout(speakingTimer);
  speakingActive = false;
  releaseWakeLock();
}

function backToList(): void {
  stopWatcher();
  listening = false;
  view = "list";
  openId = null;
  // Drop the match hash so the URL reflects the list again.
  if (matchIdFromUrl() != null) history.pushState(null, "", location.pathname + location.search);
  render();
}

// ── URL routing (each match is #ottelu/<id>, shareable) ─────────────────────

function matchIdFromUrl(): number | null {
  const m = /#ottelu\/(\d+)/.exec(location.hash);
  return m ? Number(m[1]) : null;
}

// Reconcile the view with the current URL. Runs on load and on back/forward.
function syncFromUrl(): void {
  const id = matchIdFromUrl();
  if (id == null) {
    if (view === "match") backToList();
    return;
  }
  if (view === "match" && openId === id) return;
  openMatch(id, false);
}

async function shareMatch(): Promise<void> {
  if (openId == null) return;
  const url = `${location.origin}${location.pathname}#ottelu/${openId}`;
  const sel = matchById(openId);
  const title = sel ? `${sel.home.shorthand} – ${sel.away.shorthand}` : "Pesisselostaja";
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    toast("Linkki kopioitu");
  } catch { /* user cancelled share, or clipboard blocked */ }
}

function toggleListen(): void {
  if (!watcher) return;
  debugLog("toggle-listen", { from: listening, audioCtxState: audioCtx?.state ?? null });
  if (listening) {
    listening = false;
    watcher.setMuted(true);
    window.clearTimeout(speakingTimer);
    speakingActive = false;
  } else {
    listening = true;
    unlockAudio();
    watcher.markAudioUnlocked();
    watcher.setMuted(false);
    watcher.announceSituation();
    flashSpeaking();
  }
  render();
}

function flashSpeaking(): void {
  speakingActive = true;
  window.clearTimeout(speakingTimer);
  speakingTimer = window.setTimeout(() => {
    speakingActive = false;
    if (view === "match") {
      const nowEl = root.querySelector<HTMLElement>(".now-speaking");
      if (nowEl) nowEl.innerHTML = nowSpeakingHtml();
      root.querySelectorAll<HTMLElement>(".fi.speaking").forEach(el => el.classList.remove("speaking"));
    }
  }, 2600);
}

function toggleFav(id: number): void {
  favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
  saveFavs();
  render();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render(): void {
  const prevScroll = root.querySelector<HTMLElement>(".scroll")?.scrollTop ?? 0;
  root.innerHTML = view === "list" ? listScreen() : matchScreen();
  bindCommon();
  if (view === "list") bindList(); else bindMatch();
  if (settingsOpen) { root.insertAdjacentHTML("beforeend", settingsSheet()); bindSettings(); }
  const sc = root.querySelector<HTMLElement>(".scroll");
  if (sc) sc.scrollTop = prevScroll;
}

let renderPending = false;
function deferredRender(): void {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}

// ── List screen ───────────────────────────────────────────────────────────────

function formatStartTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Helsinki" });
}

function teamLine(name: string, shorthand: string): string {
  return `<div class="trow">
      <div class="badge-sm" style="background:${teamColor(name)}">${esc(badgeText(shorthand, name))}</div>
      <span class="nm">${esc(name)}</span>
    </div>`;
}

function matchRow(m: LiveMatchSummary): string {
  const isFav = favs.includes(m.id);
  let metaHtml: string;
  let listenBtn: string;
  if (m.matchStatus === "live") {
    metaHtml = `<span class="live-mini"><span class="dot"></span>Live</span>`;
    listenBtn = `<button class="listen-fab" data-listen="${m.id}" aria-label="Kuuntele: ${esc(m.home.name)} vastaan ${esc(m.away.name)}">${icon("speaker", 22)}</button>`;
  } else if (m.matchStatus === "upcoming") {
    const time = m.startTime ? formatStartTime(m.startTime) : "";
    metaHtml = `<span class="upcoming-mini">${time ? `<span class="utime">${esc(time)}</span>` : ""}Tulossa</span>`;
    listenBtn = `<button class="listen-fab" data-listen="${m.id}" aria-label="Kuuntele: ${esc(m.home.name)} vastaan ${esc(m.away.name)}">${icon("speaker", 22)}</button>`;
  } else {
    metaHtml = `<span class="ended-mini">Päättynyt</span>`;
    listenBtn = ``;
  }
  return `<div class="mrow" data-open="${m.id}">
    <button class="lead-star${isFav ? " on" : ""}" data-fav="${m.id}" aria-label="Seuraa">${icon(isFav ? "star-fill" : "star", 18)}</button>
    <div class="teams">
      ${teamLine(m.home.name, m.home.shorthand)}
      ${teamLine(m.away.name, m.away.shorthand)}
    </div>
    <div class="mrow-meta">${metaHtml}</div>
    ${listenBtn}
  </div>`;
}

function listScreen(): string {
  const liveMatches = todayMatches.filter((m) => m.live);
  const scopeMatches = scope === "live" ? liveMatches : todayMatches;
  const shown = filter === "fav" ? scopeMatches.filter(isMatchFav) : scopeMatches;
  const favCount = scopeMatches.filter(isMatchFav).length;
  const groups = groupBySeries(shown);
  const liveCount = liveMatches.length;

  let body = "";
  if (!matchesLoaded) {
    body = `<div class="empty">Ladataan otteluita…</div>`;
  } else if (scope === "live" && liveCount === 0) {
    body = `<div class="empty"><div class="big">${icon("ball", 34)}</div>Ei live-otteluita juuri nyt.<br/>Päivitä myöhemmin uudelleen.</div>`;
  } else if (scope === "all" && todayMatches.length === 0) {
    body = `<div class="empty"><div class="big">${icon("ball", 34)}</div>Ei otteluita tänään.<br/>Päivitä myöhemmin uudelleen.</div>`;
  } else if (filter === "fav" && shown.length === 0) {
    body = `<div class="empty"><div class="big">${icon("star", 34)}</div>Et seuraa vielä yhtään ottelua.<br/>Merkitse ottelu tähdellä tai <span class="link" data-settings="1">aseta suosikkijoukkue asetuksissa</span>.<br/><span class="link" data-allfilter="1">Näytä kaikki ottelut</span></div>`;
  } else {
    for (const [label, list] of groups) {
      body += `<div class="group-label">${esc(label)}<span class="cnt">${list.length}</span></div>
        <div class="mlist">${list.map(matchRow).join("")}</div>`;
    }
  }

  return `<div class="app"><div class="app-screen">
    <div class="safe-top"></div>
    <div class="scroll">
      <div class="topbar">
        <div class="mark">${icon("ball", 22, 1.8)}</div>
        <div class="wordmark"><span class="b">Pesisselostaja</span><span class="s">Kuuntele ottelut suorana</span></div>
        <span class="spacer"></span>
        <button class="icon-btn" data-refresh="1" aria-label="Päivitä">${icon("refresh", 19)}</button>
        <button class="icon-btn" data-settings="1" aria-label="Asetukset">${icon("gear", 19)}</button>
      </div>
      <div class="daterow">
        <span class="d">Tänään · ${esc(todayLabel())}</span>
        <div class="scope-seg">
          <button class="${scope === "live" ? "on" : ""}" data-scope="live"><span class="dot"></span>Live${liveCount > 0 ? ` (${liveCount})` : ""}</button>
          <button class="${scope === "all" ? "on" : ""}" data-scope="all">Kaikki tänään</button>
        </div>
      </div>
      <div class="seg">
        <button class="${filter === "all" ? "on" : ""}" data-filter="all">Kaikki ottelut</button>
        <button class="${filter === "fav" ? "on" : ""}" data-filter="fav">Suosikit${favCount > 0 ? ` (${favCount})` : ""}</button>
      </div>
      ${body}
      <div class="foot-note">Sovellus käyttää pesistulokset.fi-palvelun otteludataa. Tämä projekti on itsenäinen, eikä se ole pesistulokset.fi:n tekemä, hyväksymä tai sponsoroima.<br/><a href="${SITE_URL}" target="_blank" rel="noopener">${icon("external", 13)} pesistulokset.fi</a> · <a href="${REPO_URL}" target="_blank" rel="noopener">Lähdekoodi GitHubissa</a> · <a href="${CREDITS_URL}" target="_blank" rel="noopener">Äänet ja lisenssit</a></div>
    </div>
  </div></div>`;
}

// ── Match screen ────────────────────────────────────────────────────────────


function scoreboardTeam(side: "home" | "away", s: MatchSnapshot): string {
  const name = side === "home" ? s.homeName : s.awayName;
  const short = side === "home" ? s.homeShort : s.awayShort;
  const runs = side === "home" ? s.homeRuns : s.awayRuns;
  const won = side === "home" ? s.homePeriodsWon : s.awayPeriodsWon;
  const batting = s.battingSide === side;
  const pips = [0, 1].map((i) => `<span class="jpip${i < won ? " on" : ""}"></span>`).join("");
  return `<div class="sb-team${batting ? " batting" : ""}">
    <div class="sb-badge" style="background:${teamColor(name)}">${esc(badgeText(short, name))}</div>
    <div class="nm">${esc(name)}</div>
    <div class="sb-run num">${runs}</div>
    <div class="jpips">${pips}</div>
    ${batting ? `<span class="bat-flag">${icon("bat", 12)}Lyö</span>` : ""}
  </div>`;
}

function scoreboardHtml(): string {
  const sel = openId != null ? matchById(openId) : undefined;
  const s = snapshot;
  const period = s ? periodLabel(s.period) : "—";
  const palot = s ? s.palot : 0;
  const homeName = s?.homeName ?? sel?.home.name ?? "Koti";
  const awayName = s?.awayName ?? sel?.away.name ?? "Vieras";
  const homeShort = s?.homeShort ?? sel?.home.shorthand ?? "";
  const awayShort = s?.awayShort ?? sel?.away.shorthand ?? "";

  const view: MatchSnapshot = s ?? {
    homeName, awayName, homeShort, awayShort, seriesName: sel?.seriesName ?? null,
    period: 0, inning: 0, batTurn: 0, homeRuns: 0, awayRuns: 0, homePeriodsWon: 0, awayPeriodsWon: 0,
    palot: 0, battingSide: null, finished: false,
  };

  const numDots = Math.max(3, palot);
  const paloDots = Array.from({length: numDots}, (_, i) => `<span class="palo${i < palot ? " on" : ""}"></span>`).join("");

  const vuoropariText = s ? `${view.inning + 1}. vuoropari, ${view.batTurn === 0 ? "aloittava" : "lopettava"}` : "";

  return `<div class="scoreboard">
    <div class="sb-head">
      <span class="period">${esc(period)}${vuoropariText ? ` · ${esc(vuoropariText)}` : ""}</span>
      <span class="spacer"></span>
      <span class="live-tag"><span class="dot"></span>${view.finished ? "PÄÄTTYI" : "LIVE"}</span>
    </div>
    <div class="sb-body">
      ${scoreboardTeam("home", view)}
      <div class="sb-mid"><span class="vs">–</span></div>
      ${scoreboardTeam("away", view)}
    </div>
    <div class="sb-palot"><span class="lbl">Palot</span>${paloDots}</div>
  </div>`;
}

function feedHtml(): string {
  if (feed.length === 0) {
    return `<div class="feed-empty">Odotetaan ottelun tapahtumia…<br/>Tuoreet juoksut, palot ja vuoronvaihdot ilmestyvät tähän.</div>`;
  }
  const items = [...feed].reverse().map((ev) => {
    const fresh = ev.id === freshId ? " fresh" : "";
    const speaking = speakingActive && ev.id === freshId ? " speaking" : "";
    return `<div class="fi ${ev.type}${fresh}${speaking}">
      <div class="fi-rail"><div class="fi-ic">${icon(FEED_ICON[ev.type] || "info", 15)}</div><div class="fi-line"></div></div>
      <div class="fi-body"><div class="fi-text">${esc(ev.text)}</div><div class="fi-time">${esc(ev.time)}</div></div>
    </div>`;
  }).join("");
  return `<div class="feed">${items}</div>`;
}

function nowSpeakingHtml(): string {
  if (!listening) return `Ääni pois — paina kuunnellaksesi selostuksen`;
  if (speakingActive) return `${icon("speaker", 14)}<span class="live-text">Selostetaan…</span>`;
  return `${icon("headset", 14)}Odotetaan seuraavaa tapahtumaa…`;
}

function matchScreen(): string {
  const sel = openId != null ? matchById(openId) : undefined;
  const s = snapshot;
  const homeShort = s?.homeShort ?? sel?.home.shorthand ?? "";
  const awayShort = s?.awayShort ?? sel?.away.shorthand ?? "";
  const series = s?.seriesName ?? sel?.seriesName ?? "Pesäpallo";

  const listenBtn = listening
    ? `<span class="eq"><i></i><i></i><i></i><i></i></span>Kuunnellaan — hiljennä`
    : `${icon("speaker", 21)}Kuuntele ottelua`;

  const errorHtml = matchError
    ? `<div class="situation" style="background:#FBE3DC;border-color:#F0C2B6;color:#8A2B16"><span class="ic">${icon("info", 17)}</span><span>${esc(matchError)}</span></div>`
    : "";

  return `<div class="app"><div class="app-screen">
    <div class="safe-top"></div>
    <div class="lm-bar">
      <button class="back-btn" data-back="1" aria-label="Takaisin">${icon("back", 20)}</button>
      <div class="t">
        <div class="s1">${esc(homeShort)} – ${esc(awayShort)}</div>
        <div class="s2">${esc(series)}</div>
      </div>
      <span class="spacer"></span>
      <button class="icon-btn" data-share="1" aria-label="Jaa ottelu" title="Jaa ottelu">${icon("share", 18)}</button>
      <button class="icon-btn keepawake-btn${settings.keepScreenOn ? " on" : ""}" data-keepawake="1" aria-label="Pidä ruutu päällä" aria-pressed="${settings.keepScreenOn}" title="Pidä ruutu päällä">${icon("sun", 19)}</button>
      <button class="icon-btn" data-settings="1" aria-label="Asetukset">${icon("gear", 19)}</button>
    </div>
    <div class="scroll">
      ${scoreboardHtml()}
      <div class="listen-wrap">
        <button class="listen-btn${listening ? " on" : ""}" data-togglelisten="1">${listenBtn}</button>
        <div class="now-speaking">${nowSpeakingHtml()}</div>
      </div>
      ${errorHtml}
      <div class="feed-label">Tapahtumat</div>
      ${feedHtml()}
      ${openId != null ? `<div class="foot-note"><a href="${MATCH_PAGE_BASE}/${openId}" target="_blank" rel="noopener">${icon("external", 13)} Ottelun tilastot pesistulokset.fi:ssä</a></div>` : ""}
    </div>
  </div></div>`;
}

// ── Settings sheet ──────────────────────────────────────────────────────────

function getVoiceByName(name: string): SpeechSynthesisVoice | null {
  if (!name || !("speechSynthesis" in window)) return null;
  return window.speechSynthesis.getVoices().find((v) => v.name === name) ?? null;
}

function voiceSelectHtml(): string {
  if (!("speechSynthesis" in window)) return "";
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return "";
  const fi = voices.filter((v) => v.lang.startsWith("fi"));
  const other = voices.filter((v) => !v.lang.startsWith("fi"));
  const opt = (v: SpeechSynthesisVoice) =>
    `<option value="${esc(v.name)}"${settings.voiceName === v.name ? " selected" : ""}>${esc(v.name)} (${v.lang})</option>`;
  const fiOpts = fi.map(opt).join("");
  const otherOpts = other.length
    ? `<optgroup label="Muut kielet">${other.map(opt).join("")}</optgroup>`
    : "";
  const defaultSel = settings.voiceName === "" ? " selected" : "";
  return `<div class="adv-field" style="border-top:1px solid var(--line)">
    <div class="a">Puheääni</div>
    <select id="voice-select">
      <option value=""${defaultSel}>Selaimen oletusääni</option>
      ${fiOpts ? `<optgroup label="Suomi">${fiOpts}</optgroup>` : ""}
      ${otherOpts}
    </select>
  </div>`;
}

// Voice-engine area: a toggle for the advanced Piper voice, and either the
// browser-voice picker or the Piper model picker + download status.
function voiceEngineHtml(): string {
  const piper = settings.voiceEngine === "piper";
  const row = `<div class="set-row">
      <div class="ic">${icon("speaker", 18)}</div>
      <div class="lab"><div class="a">Edistynyt ääni (Piper)</div><div class="b">Luonnollisempi suomenkielinen ääni, vaatii kertalatauksen</div></div>
      <div class="switch${piper ? " on" : ""}" data-toggle="voiceEngine"><div class="knob"></div></div>
    </div>`;
  if (!piper) return row + voiceSelectHtml();
  const opts = PIPER_VOICES.map((v) =>
    `<option value="${esc(v.id)}"${settings.piperVoiceId === v.id ? " selected" : ""}>${esc(v.label)}</option>`
  ).join("");
  // The boost runs through Web Audio, so it only exists on the Piper path —
  // browser speechSynthesis caps at volume 1.0 and can't be amplified.
  const boostRow = `<div class="set-row">
      <div class="ic">${icon("speaker", 18)}</div>
      <div class="lab"><div class="a">Kaiutintila</div><div class="b">Vahvistaa selostusta kovemmalle, esim. ulkona kännykän kaiuttimesta</div></div>
      <div class="switch${settings.volumeBoost ? " on" : ""}" data-toggle="volumeBoost"><div class="knob"></div></div>
    </div>`;
  return row + boostRow + `<div class="adv-field" style="border-top:1px solid var(--line)">
    <div class="a">Piper-ääni</div>
    <select id="piper-voice-select">${opts}</select>
    <div id="piper-status" class="b" style="margin-top:6px"></div>
    ${voiceCreditsHtml()}
  </div>`;
}

// Attribution for the neural voices. CC BY-NC 4.0 (Asmo) requires crediting the
// author; CC0 (Harri) doesn't but we credit it too. One row per distinct source.
function voiceCreditsHtml(): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const v of PIPER_VOICES) {
    if (seen.has(v.sourceUrl)) continue;
    seen.add(v.sourceUrl);
    const nc = v.nonCommercial ? " · epäkaupallinen" : "";
    rows.push(`<div>${esc(v.name)} — ${esc(v.author)} (<a href="${esc(v.sourceUrl)}" target="_blank" rel="noopener">${esc(v.license)}${nc}</a>)</div>`);
  }
  return `<div class="b voice-credits" style="margin-top:8px;line-height:1.5">
    Äänimallit: ${rows.join("")}
    <div style="margin-top:4px"><a href="${esc(CREDITS_URL)}" target="_blank" rel="noopener">Äänet ja lisenssit</a></div>
  </div>`;
}

function setPiperStatus(msg: string): void {
  const el = root.querySelector<HTMLElement>("#piper-status");
  if (el) el.textContent = msg;
}

// Ensure the selected Piper model is downloaded, surfacing progress in the
// settings sheet. Cached models report "ready" instantly.
let piperStatusBusy = false;
async function ensurePiperModel(voiceId: string): Promise<void> {
  piperStatusBusy = true;
  try {
    const stored = await piperStored();
    if (stored.includes(voiceId)) { setPiperStatus("Ääni valmis ✓"); return; }
    setPiperStatus("Ladataan ääntä… 0 %");
    await piperDownload(voiceId, (p) => {
      const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
      setPiperStatus(`Ladataan ääntä… ${pct} %`);
    });
    setPiperStatus("Ääni valmis ✓");
  } catch {
    setPiperStatus("Lataus epäonnistui — käytetään selaimen ääntä");
  } finally {
    piperStatusBusy = false;
  }
}

// Reflect whether the selected model is already cached, without downloading.
// Skips while a download is in flight so it can't clobber the progress text.
function reflectPiperStatus(): void {
  if (piperStatusBusy) return;
  piperStored().then((s) => {
    if (piperStatusBusy) return;
    setPiperStatus(s.includes(settings.piperVoiceId) ? "Ääni valmis ✓" : "Ei vielä ladattu");
  }).catch(() => { /* ignore */ });
}

// Push the current voice settings into the watcher.
function applyVoiceEngine(): void {
  watcher?.setVoiceEngine(settings.voiceEngine);
  watcher?.setVolumeBoost(settings.volumeBoost);
  if (settings.voiceEngine === "piper") {
    watcher?.setPiperVoice(settings.piperVoiceId);
  } else {
    watcher?.setVoice(getVoiceByName(settings.voiceName));
  }
}

function settingsSheet(): string {
  const adv = advancedOpen ? `
    <div class="adv-field">
      <div class="a">API-osoite</div>
      <input id="set-apibase" type="text" spellcheck="false" value="${esc(settings.apiBase)}" />
    </div>
    <div class="adv-field">
      <div class="a">Päivitysväli (s)</div>
      <input id="set-poll" type="number" min="1" max="60" value="${settings.pollInterval}" />
    </div>
    <div class="adv-field">
      <div class="a">Ääntämiskorjaukset</div>
      <div id="pron-list">${pronRowsHtml()}</div>
      <div class="pron-actions">
        <button class="btn-soft" id="pron-add">+ Lisää rivi</button>
        <button class="btn-soft primary" id="adv-save">Tallenna</button>
      </div>
    </div>` : "";

  return `<div class="sheet-back" data-sheetclose="1">
    <div class="sheet" data-sheetstop="1">
      <div class="grab"></div>
      <h3>Asetukset</h3>
      <p class="sub">Säädä, mitä selostus kertoo. Oletukset sopivat useimmille.</p>
      <div class="set-row">
        <div class="ic">${icon("bat", 18)}</div>
        <div class="lab"><div class="a">Kerro lyöjänvaihdot</div><div class="b">Ilmoittaa, kuka on lyöntivuorossa</div></div>
        <div class="switch${settings.announceBatterChanges ? " on" : ""}" data-toggle="announceBatterChanges"><div class="knob"></div></div>
      </div>
      ${voiceEngineHtml()}
      <div class="adv-field" style="border-top:1px solid var(--line)">
        <div class="a">Suosikkijoukkueet</div>
        <input id="set-fav-teams" type="text" spellcheck="false" placeholder="IPV, KiPa, Roihu EP, …" value="${esc(favTeams.join(', '))}" />
      </div>
      <div class="adv-link" data-advtoggle="1">${advancedOpen ? "Piilota lisäasetukset" : "Lisäasetukset (kehittäjille)"}</div>
      ${adv}
      <div class="set-foot">
        <a href="${REPO_URL}" target="_blank" rel="noopener">Pesisselostaja GitHubissa</a>
        · <a href="${CREDITS_URL}" target="_blank" rel="noopener">Äänet ja lisenssit</a>
      </div>
    </div>
  </div>`;
}

function pronRowsHtml(): string {
  if (pronunciations.length === 0) return "";
  return pronunciations.map((p, i) => `<div class="pron-row">
    <input class="pron-from" data-i="${i}" type="text" value="${esc(p.from)}" placeholder="Termi" />
    <span class="arrow">→</span>
    <input class="pron-to" data-i="${i}" type="text" value="${esc(p.to)}" placeholder="Ääntämys" />
    <button class="pron-del" data-del="${i}" aria-label="Poista">✕</button>
  </div>`).join("");
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindCommon(): void {
  root.querySelectorAll<HTMLElement>("[data-settings]").forEach((b) => {
    b.onclick = () => { settingsOpen = true; advancedOpen = false; render(); };
  });
}

function bindList(): void {
  root.querySelectorAll<HTMLElement>("[data-scope]").forEach((b) => {
    b.onclick = () => { scope = b.dataset.scope as "live" | "all"; render(); };
  });
  root.querySelectorAll<HTMLElement>("[data-filter]").forEach((b) => {
    b.onclick = () => { filter = b.dataset.filter as "all" | "fav"; render(); };
  });
  const allLink = root.querySelector<HTMLElement>("[data-allfilter]");
  if (allLink) allLink.onclick = () => { filter = "all"; render(); };

  root.querySelectorAll<HTMLElement>("[data-refresh]").forEach((b) => {
    b.onclick = () => { matchesLoaded = false; render(); refreshTodayMatches(); };
  });

  root.querySelectorAll<HTMLElement>("[data-fav]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); toggleFav(Number(b.dataset.fav)); };
  });
  root.querySelectorAll<HTMLElement>("[data-listen]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openMatch(Number(b.dataset.listen), true); };
  });
  root.querySelectorAll<HTMLElement>("[data-open]").forEach((row) => {
    row.onclick = () => openMatch(Number(row.dataset.open), false);
  });
}

function bindMatch(): void {
  const back = root.querySelector<HTMLElement>("[data-back]");
  if (back) back.onclick = backToList;
  const tl = root.querySelector<HTMLElement>("[data-togglelisten]");
  if (tl) tl.onclick = toggleListen;
  const ka = root.querySelector<HTMLElement>("[data-keepawake]");
  if (ka) ka.onclick = toggleKeepScreenOn;
  const share = root.querySelector<HTMLElement>("[data-share]");
  if (share) share.onclick = () => { void shareMatch(); };
}

function toggleKeepScreenOn(): void {
  settings.keepScreenOn = !settings.keepScreenOn;
  saveSettings();
  if (settings.keepScreenOn) void requestWakeLock();
  else releaseWakeLock();
  toast(settings.keepScreenOn ? "Ruutu pidetään päällä" : "Ruutu voi sammua");
  render();
}

function bindSettings(): void {
  const close = root.querySelector<HTMLElement>("[data-sheetclose]");
  if (close) close.onclick = () => { closeSettings(); };
  const sheet = root.querySelector<HTMLElement>("[data-sheetstop]");
  if (sheet) sheet.onclick = (e) => e.stopPropagation();

  const toggle = root.querySelector<HTMLElement>('[data-toggle="announceBatterChanges"]');
  if (toggle) toggle.onclick = () => {
    settings.announceBatterChanges = !settings.announceBatterChanges;
    saveSettings();
    render();
  };

  const engineToggle = root.querySelector<HTMLElement>('[data-toggle="voiceEngine"]');
  if (engineToggle) engineToggle.onclick = () => {
    settings.voiceEngine = settings.voiceEngine === "piper" ? "browser" : "piper";
    saveSettings();
    applyVoiceEngine();
    render();
    if (settings.voiceEngine === "piper") void ensurePiperModel(settings.piperVoiceId);
  };

  const boostToggle = root.querySelector<HTMLElement>('[data-toggle="volumeBoost"]');
  if (boostToggle) boostToggle.onclick = () => {
    settings.volumeBoost = !settings.volumeBoost;
    saveSettings();
    watcher?.setVolumeBoost(settings.volumeBoost);
    render();
  };

  const voiceSel = root.querySelector<HTMLSelectElement>("#voice-select");
  if (voiceSel) {
    voiceSel.onchange = () => {
      settings.voiceName = voiceSel.value;
      saveSettings();
      watcher?.setVoice(getVoiceByName(settings.voiceName));
    };
  }

  const piperSel = root.querySelector<HTMLSelectElement>("#piper-voice-select");
  if (piperSel) {
    reflectPiperStatus();
    piperSel.onchange = () => {
      settings.piperVoiceId = piperSel.value;
      saveSettings();
      watcher?.setPiperVoice(settings.piperVoiceId);
      void ensurePiperModel(settings.piperVoiceId);
    };
  }

  const favTeamsEl = root.querySelector<HTMLInputElement>("#set-fav-teams");
  if (favTeamsEl) {
    favTeamsEl.onchange = () => {
      favTeams = favTeamsEl.value.split(",").map(s => s.trim()).filter(Boolean);
      saveFavTeams();
      toast("Tallennettu");
    };
  }

  const advLink = root.querySelector<HTMLElement>("[data-advtoggle]");
  if (advLink) advLink.onclick = () => { advancedOpen = !advancedOpen; render(); };

  // advanced fields
  root.querySelectorAll<HTMLInputElement>(".pron-from").forEach((inp) => {
    inp.oninput = () => { pronunciations[Number(inp.dataset.i)].from = inp.value; };
  });
  root.querySelectorAll<HTMLInputElement>(".pron-to").forEach((inp) => {
    inp.oninput = () => { pronunciations[Number(inp.dataset.i)].to = inp.value; };
  });
  root.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => {
    b.onclick = () => {
      pronunciations.splice(Number(b.dataset.del), 1);
      savePronunciations(pronunciations);
      watcher?.setPronunciations(pronunciations);
      render();
    };
  });
  const add = root.querySelector<HTMLElement>("#pron-add");
  if (add) add.onclick = () => { pronunciations.push({ from: "", to: "" }); render(); };
  const save = root.querySelector<HTMLElement>("#adv-save");
  if (save) save.onclick = () => saveAdvanced();
}

function saveAdvanced(): void {
  const apibase = root.querySelector<HTMLInputElement>("#set-apibase");
  const poll = root.querySelector<HTMLInputElement>("#set-poll");
  if (apibase) settings.apiBase = apibase.value.trim() || DEFAULT_API_BASE;
  if (poll) settings.pollInterval = Math.min(60, Math.max(1, parseInt(poll.value, 10) || 6));
  saveSettings();
  savePronunciations(pronunciations);
  pronunciations = loadPronunciations();
  watcher?.setPronunciations(pronunciations);
  toast("Tallennettu");
  render();
}

function closeSettings(): void {
  settingsOpen = false;
  render();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function init(): void {
  // iOS Safari ignores user-scalable=no — block pinch zoom via touch events
  document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
  document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
  document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("popstate", syncFromUrl);
  window.addEventListener("hashchange", syncFromUrl);

  render();
  syncFromUrl();   // honour a shared #ottelu/<id> link on cold load
  refreshTodayMatches();
  window.setInterval(() => { if (view === "list") refreshTodayMatches(); }, 30000);
}

init();
