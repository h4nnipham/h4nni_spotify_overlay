const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog } = require('electron');
const path = require('path');
const http = require('http');
const url  = require('url');
const fs   = require('fs');
const { transliterateLines } = require('./transliterate');

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = require('./config');
const REDIRECT_URI          = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state streaming';

// --- Persistence ---------------------------------------------------------------
const DATA_DIR      = path.join(app.getPath('userData'), 'h4nnis-overlay');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STATE_FILE    = path.join(DATA_DIR, 'windowstate.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadJSON(file, defaults) {
  try { if (fs.existsSync(file)) return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  return { ...defaults };
}
function saveJSON(file, data) {
  try { ensureDataDir(); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

const defaultSettings = {
  bgOpacity: 96, accentColor: '#1DB954',
  font: "'Syne', sans-serif", activeFontSize: 16, inactiveFontSize: 12,
  activeWeight: '800', colorActive: '#FFFFFF', colorUpcoming: '#B3B3B3',
  colorInactive: '#535353', lyricsOnly: false, showProgress: true,
  clickThroughKey: null, playPauseKey: null, nextKey: null, prevKey: null,
  theme: 'dark', hideOpacitySlider: false, hidePlaybackControls: false,
  miniMode: false, fullscreenMode: false, alwaysOnTop: true,
};

let settings    = loadJSON(SETTINGS_FILE, defaultSettings);
let windowState = loadJSON(STATE_FILE, { x: null, y: null, width: 320, height: 520 });

// --- App state -----------------------------------------------------------------
let overlayWindow  = null;
let authWindow     = null;
let authServer     = null;
let accessToken    = null;
let refreshToken   = null;
let tokenExpiresAt = 0;
let clickThrough   = false;
let lastTrackId    = null;
let cachedLyrics   = [];

// --- Auth -----------------------------------------------------------------------
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT_URI, scope: SCOPES,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCode(code) {
  const body  = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return r.json();
}

// Only one refresh at a time, concurrent callers share the same promise
let refreshPromise = null;
function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = doRefreshAccessToken().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function doRefreshAccessToken() {
  if (!refreshToken) return false;
  const body  = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  try {
    const r = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await r.json();
    if (data.access_token) {
      accessToken    = data.access_token;
      tokenExpiresAt = Date.now() + data.expires_in * 1000;
      if (data.refresh_token) refreshToken = data.refresh_token;
      return true;
    }
  } catch (e) { console.error('Token refresh failed:', e.message); }
  return false;
}

async function getValidToken() {
  if (!accessToken) return null;
  if (Date.now() > tokenExpiresAt - 60000) await refreshAccessToken();
  return accessToken;
}

// --- HTTP helpers --------------------------------------------------------------
const fetch = require('node-fetch');

async function fetchWithTimeout(resource, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Spotify REST API ----------------------------------------------------------
// Spotify limits each app's requests over a rolling 30-second window. Going over
// returns 429 with a Retry-After that can be hours long, during which the app
// gets nothing, so we stay well under it:
//  * a rate-limit ban is respected for *all* requests and remembered across
//    restarts (reopening the app shouldn't keep hitting Spotify during a ban)
//  * background requests share a budget per 30s window; user actions don't
const RATE_FILE          = path.join(DATA_DIR, 'ratelimit.json');
const BG_BUDGET          = 8;      // background requests per 30s
const BG_WINDOW_MS       = 30000;
let rateLimitedUntil     = loadJSON(RATE_FILE, { until: 0 }).until || 0;
const bgRequestTimes     = [];

function sendRateLimitStatus() {
  if (!overlayWindow) return;
  const until = rateLimitedUntil > Date.now() ? rateLimitedUntil : 0;
  overlayWindow.webContents.send('rate-limited', { until });
}

function bgBudgetWaitMs() {
  const now = Date.now();
  while (bgRequestTimes.length && now - bgRequestTimes[0] > BG_WINDOW_MS) bgRequestTimes.shift();
  return bgRequestTimes.length < BG_BUDGET ? 0 : BG_WINDOW_MS - (now - bgRequestTimes[0]) + 50;
}

// Returns { ok, status, data }. status 0 = network error / not authed.
// opts.background: counts against the background budget (polling, prefetch)
async function spotifyRequest(endpoint, method = 'GET', bodyData = null, isRetry = false, background = false) {
  if (Date.now() < rateLimitedUntil) return { ok: false, status: 429, data: null };
  if (background && !isRetry) {
    if (bgBudgetWaitMs() > 0) return { ok: false, status: 429, data: null, budget: true };
    bgRequestTimes.push(Date.now());
  }
  const token = await getValidToken();
  if (!token) return { ok: false, status: 0, data: null };
  try {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (bodyData) opts.body = JSON.stringify(bodyData);
    const response = await fetchWithTimeout(`https://api.spotify.com/v1${endpoint}`, opts, 6000);
    if (response.status === 204 || response.status === 202) return { ok: true, status: response.status, data: null };
    if (response.status === 401 && !isRetry) {
      await refreshAccessToken();
      return spotifyRequest(endpoint, method, bodyData, true, background);
    }
    if (response.status === 429) {
      const wait = Math.max(1, parseInt(response.headers.get('retry-after') || '5', 10)) * 1000;
      rateLimitedUntil = Date.now() + wait;
      saveJSON(RATE_FILE, { until: rateLimitedUntil });
      console.warn(`Spotify rate limit: pausing all requests for ${formatDuration(wait)} (until ${new Date(rateLimitedUntil).toLocaleTimeString()})`);
      sendRateLimitStatus();
      return { ok: false, status: 429, data: null };
    }
    if (!response.ok) return { ok: false, status: response.status, data: null };
    const text = await response.text();
    return { ok: true, status: response.status, data: text.trim() ? JSON.parse(text) : null };
  } catch (err) {
    console.error(`spotifyFetch [${endpoint}]:`, err.message);
    return { ok: false, status: 0, data: null };
  }
}

async function spotifyFetch(endpoint, method = 'GET', bodyData = null) {
  return (await spotifyRequest(endpoint, method, bodyData)).data;
}

const playbackPlay     = ()    => spotifyFetch('/me/player/play',     'PUT');
const playbackPause    = ()    => spotifyFetch('/me/player/pause',    'PUT');
const playbackNext     = ()    => spotifyFetch('/me/player/next',     'POST');
const playbackPrevious = ()    => spotifyFetch('/me/player/previous', 'POST');
const seekToPosition   = (ms)  => spotifyFetch(`/me/player/seek?position_ms=${Math.round(ms)}`, 'PUT');
const setVolume        = (pct) => spotifyFetch(`/me/player/volume?volume_percent=${Math.round(pct)}`, 'PUT');
const setShuffle       = (s)   => spotifyFetch(`/me/player/shuffle?state=${s}`, 'PUT');
const setRepeat        = (s)   => spotifyFetch(`/me/player/repeat?state=${s}`,  'PUT');
const getPlaybackState = ()    => spotifyFetch('/me/player');
const getQueue         = async () => (await spotifyRequest('/me/player/queue', 'GET', null, false, true)).data;

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// --- Lyrics --------------------------------------------------------------------
const LYRICS_UA          = 'h4nnis-lyrics-overlay (https://github.com/h4nnipham/h4nni_spotify_overlay)';
const LYRICS_CACHE_FILE  = path.join(DATA_DIR, 'lyrics-cache.json');
const LYRICS_CACHE_MAX   = 500;
const LYRICS_MISS_TTL_MS = 6 * 60 * 60 * 1000;   // retry "not found" after 6h
const LYRICS_PLAIN_TTL_MS = 3 * 24 * 60 * 60 * 1000; // re-check plain-only for synced after 3 days

let lyricsCache = {};
try { if (fs.existsSync(LYRICS_CACHE_FILE)) lyricsCache = JSON.parse(fs.readFileSync(LYRICS_CACHE_FILE, 'utf8')) || {}; } catch { lyricsCache = {}; }
let lyricsCacheSaveTimer = null;
const lyricsInflight = new Map(); // trackId -> Promise

function saveLyricsCacheSoon() {
  if (lyricsCacheSaveTimer) return;
  lyricsCacheSaveTimer = setTimeout(() => {
    lyricsCacheSaveTimer = null;
    const entries = Object.entries(lyricsCache);
    if (entries.length > LYRICS_CACHE_MAX) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      lyricsCache = Object.fromEntries(entries.slice(0, LYRICS_CACHE_MAX));
    }
    try { ensureDataDir(); fs.writeFile(LYRICS_CACHE_FILE, JSON.stringify(lyricsCache), () => {}); } catch {}
  }, 2000);
}

function getCachedLyrics(trackId) {
  const hit = lyricsCache[trackId];
  if (!hit) return null;
  const age = Date.now() - (hit.ts || 0);
  if (!hit.lrc && !hit.plain && !hit.instrumental && age > LYRICS_MISS_TTL_MS) return null;
  if (!hit.lrc && hit.plain && age > LYRICS_PLAIN_TTL_MS) return null;
  return hit;
}

// Normalise text for comparisons: lowercase, strip accents & punctuation
function normText(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const A = normText(a), B = normText(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.85;
  const ta = new Set(A.split(' ')), tb = new Set(B.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

// "Song (feat. X) - Remastered 2011" → ["Song (feat. X) - Remastered 2011", "Song"]
const VERSION_WORDS = /(remaster|remastered|live|version|edit|mix|mono|stereo|radio|bonus|demo|acoustic|deluxe|explicit|clean|instrumental|single|anniversary|re-?recorded|taylor'?s|from|feat|ft\.|with|sped up|slowed|reverb)/i;
function titleVariants(name) {
  const out = [name];
  let t = name;
  t = t.replace(/\s*[\(\[]\s*(feat\.?|ft\.?|with)\s[^\)\]]*[\)\]]/gi, '');   // (feat. X)
  out.push(t.trim());
  t = t.replace(/\s+-\s+.*$/, (m) => (VERSION_WORDS.test(m) ? '' : m));      // - Remastered 2011
  t = t.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, (m) => (VERSION_WORDS.test(m) ? '' : m)); // (Live at ...)
  out.push(t.trim());
  return [...new Set(out.filter(Boolean))];
}

// Returns parsed JSON, null for "not found", or undefined if the provider was unreachable
async function lyricsGetJSON(urlStr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchWithTimeout(urlStr, { headers: { 'User-Agent': LYRICS_UA } }, 8000);
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) return null;
    } catch { /* network error / timeout — retry */ }
    await sleep(400 * (attempt + 1));
  }
  return undefined;
}

function scoreCandidate(c, title, artists, durationSec) {
  if (!c || (!c.syncedLyrics && !c.plainLyrics && !c.instrumental)) return -Infinity;
  const titleSim  = Math.max(...titleVariants(title).map((t) => similarity(c.trackName || c.name, t)));
  const artistSim = Math.max(...artists.map((a) => similarity(c.artistName, a)));
  if (titleSim < 0.5 || artistSim < 0.3) return -Infinity;
  let score = titleSim * 40 + artistSim * 30;
  if (durationSec && c.duration) {
    const dd = Math.abs(c.duration - durationSec);
    if (dd > 8) return -Infinity;
    score -= dd * 3;
  }
  if (c.syncedLyrics) score += 25;
  else if (c.plainLyrics) score += 5;
  return score;
}

function resultFromLrclib(c, source) {
  if (!c) return null;
  if (c.syncedLyrics) return { lrc: c.syncedLyrics, plain: c.plainLyrics || null, source };
  if (c.plainLyrics)  return { lrc: null, plain: c.plainLyrics, source };
  if (c.instrumental) return { lrc: null, plain: null, instrumental: true, source };
  return null;
}

async function fetchLyricsUncached(track) {
  const title       = track.name;
  const artists     = (track.artists || []).map((a) => a.name).filter(Boolean);
  const artist      = artists[0] || '';
  const album       = track.album?.name || '';
  const durationSec = Math.round((track.duration_ms || 0) / 1000);
  const variants    = titleVariants(title);
  const clean       = variants[variants.length - 1];

  // Track whether any provider actually answered, so a network outage isn't
  // cached as "no lyrics for this song"
  let anyReached = false;
  const get = async (u) => { const r = await lyricsGetJSON(u); if (r !== undefined) anyReached = true; return r ?? null; };

  let plainFallback = null;
  const consider = (res) => {
    if (!res) return null;
    if (res.lrc) return res;
    if (!plainFallback && (res.plain || res.instrumental)) plainFallback = res;
    return null;
  };

  // 1. Exact LRCLIB match + structured search, in parallel
  const exactParams = new URLSearchParams({ track_name: title, artist_name: artist, album_name: album, duration: durationSec });
  const searchParams = new URLSearchParams({ track_name: clean, artist_name: artist });
  const [exact, searchRes] = await Promise.all([
    get(`https://lrclib.net/api/get?${exactParams}`),
    get(`https://lrclib.net/api/search?${searchParams}`),
  ]);
  let hit = consider(resultFromLrclib(exact, 'lrclib'));
  if (hit) return hit;

  const pickBest = (list) => {
    if (!Array.isArray(list)) return null;
    let best = null, bestScore = -Infinity;
    for (const c of list) {
      const s = scoreCandidate(c, title, artists, durationSec);
      if (s > bestScore) { best = c; bestScore = s; }
    }
    return best;
  };

  hit = consider(resultFromLrclib(pickBest(searchRes), 'lrclib-search'));
  if (hit) return hit;

  // 2. Exact match with the cleaned-up title (no album — album names often differ)
  if (clean !== title) {
    const p = new URLSearchParams({ track_name: clean, artist_name: artist, duration: durationSec });
    hit = consider(resultFromLrclib(await get(`https://lrclib.net/api/get?${p}`), 'lrclib'));
    if (hit) return hit;
  }

  // 3. Free-text search (catches artist-name differences, transliterations etc.)
  const q = new URLSearchParams({ q: `${clean} ${artist}` });
  hit = consider(resultFromLrclib(pickBest(await get(`https://lrclib.net/api/search?${q}`)), 'lrclib-search'));
  if (hit) return hit;

  if (plainFallback) return plainFallback;

  // 4. Lyrics.ovh (plain text only)
  const ovh = await get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(clean)}`);
  if (ovh?.lyrics) return { lrc: null, plain: ovh.lyrics.trim(), source: 'lyrics.ovh' };

  if (!anyReached) throw new Error('lyrics providers unreachable');
  return { lrc: null, plain: null, source: null };
}

// Cached + de-duplicated lyrics lookup
function getLyrics(track) {
  const cached = getCachedLyrics(track.id);
  if (cached) return Promise.resolve(cached);
  if (lyricsInflight.has(track.id)) return lyricsInflight.get(track.id);
  const p = fetchLyricsUncached(track)
    .catch((e) => { console.error('Lyrics fetch error:', e.message); return { lrc: null, plain: null, source: null, failed: true }; })
    .then((res) => {
      if (!res.failed) {
        lyricsCache[track.id] = { ...res, ts: Date.now() };
        saveLyricsCacheSoon();
      }
      return res;
    })
    .finally(() => lyricsInflight.delete(track.id));
  lyricsInflight.set(track.id, p);
  return p;
}

// Warm the cache for the next song in the queue so lyrics show instantly
let lastPrefetchFor = null;
async function prefetchNextLyrics(currentId) {
  if (lastPrefetchFor === currentId) return;
  if (bgBudgetWaitMs() > 0 || bgRequestTimes.length >= BG_BUDGET - 2) return; // polling matters more
  lastPrefetchFor = currentId;
  try {
    const q = await getQueue();
    const next = q?.queue?.find((t) => t && t.type === 'track' && t.id && t.id !== currentId);
    if (next) getLyrics(next).catch(() => {});
  } catch {}
}

function parseLRC(lrc) {
  if (!lrc) return [];
  let offset = 0;
  const offMatch = lrc.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  if (offMatch) offset = parseInt(offMatch[1], 10) || 0;

  const parsed = [];
  const timeRx = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lrc.split(/\r?\n/)) {
    timeRx.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = timeRx.exec(line)) !== null) {
      const frac = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
      stamps.push((parseInt(match[1], 10) * 60 + parseInt(match[2], 10)) * 1000 + frac);
    }
    if (!stamps.length) continue; // metadata tags like [ar:], [ti:]
    const raw  = line.replace(/\[[^\]]*\]/g, '');
    const text = raw.replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').replace(/\s+/g, ' ').trim();
    // Enhanced LRC: <mm:ss.xx> before each word gives real word timings
    let words = null;
    if (stamps.length === 1 && /<\d+:\d+(?:[.:]\d+)?>/.test(raw)) {
      words = [];
      const wordRx = /<(\d+):(\d+)(?:[.:](\d{1,3}))?>([^<]*)/g;
      let wm;
      while ((wm = wordRx.exec(raw)) !== null) {
        const frac = wm[3] ? parseInt(wm[3].padEnd(3, '0'), 10) : 0;
        const wt   = Math.max(0, (parseInt(wm[1], 10) * 60 + parseInt(wm[2], 10)) * 1000 + frac - offset);
        for (const w of wm[4].trim().split(/\s+/).filter(Boolean)) words.push({ time: wt, text: w });
      }
      if (words.length !== text.split(' ').filter(Boolean).length) words = null;
    }
    for (const t of stamps) parsed.push(words ? { time: Math.max(0, t - offset), text, words } : { time: Math.max(0, t - offset), text });
  }
  parsed.sort((a, b) => a.time - b.time);

  // Keep empty lines only as instrumental gaps (≥ 4s), collapse duplicates
  const out = [];
  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];
    if (!cur.text) {
      const next = parsed[i + 1];
      const gap  = next ? next.time - cur.time : Infinity;
      if (gap < 4000 || !out.length || !out[out.length - 1].text) continue;
      if (!next) continue; // trailing blank
      out.push({ time: cur.time, text: '', gap: true });
      continue;
    }
    out.push(cur.words ? { time: cur.time, text: cur.text, words: cur.words } : { time: cur.time, text: cur.text });
  }
  return out;
}

// --- Track / playback state ----------------------------------------------------
let trackChangeSeq = 0;
let lastKnown = null; // { id, duration, progress, at, playing }

function estimatedRemainingMs() {
  if (!lastKnown || !lastKnown.duration) return null;
  const elapsed = lastKnown.playing ? Date.now() - lastKnown.at : 0;
  return lastKnown.duration - (lastKnown.progress + elapsed);
}

async function handleTrackChange(track, progressMs, isPlaying, shuffleState, repeatState, volume, deviceName) {
  if (!overlayWindow || !track?.id) return;
  if (track.id === lastTrackId) return;
  lastTrackId  = track.id;
  cachedLyrics = [];
  const seq = ++trackChangeSeq;

  // Show the new track immediately — lyrics follow in a separate message
  const cached = getCachedLyrics(track.id);
  const cachedSynced = cached ? parseLRC(cached.lrc) : null;
  overlayWindow.webContents.send('track-changed', {
    id:         track.id,
    name:       track.name,
    artist:     (track.artists || []).map((a) => a.name).join(', '),
    album:      track.album?.name || '',
    art:        track.album?.images?.[0]?.url || null,
    duration:   track.duration_ms,
    progress:   progressMs,
    playing:    isPlaying,
    shuffle:    shuffleState,
    repeat:     repeatState,
    volume:     volume,
    device:     deviceName || null,
    lyricsLoading: !cached,
    lyrics:       cachedSynced || [],
    plainLyrics:  cached?.plain || null,
    instrumental: !!cached?.instrumental,
    lyricsSource: cached?.source || null,
  });

  if (!cached) {
    const res = await getLyrics(track);
    if (seq !== trackChangeSeq || !overlayWindow) return; // track changed again meanwhile
    const synced = parseLRC(res.lrc);
    cachedLyrics = synced;
    overlayWindow.webContents.send('lyrics-loaded', {
      id:           track.id,
      lyrics:       synced,
      plainLyrics:  res.plain || null,
      instrumental: !!res.instrumental,
      lyricsSource: res.source,
      failed:       !!res.failed,
    });
    if (res.failed) lastTrackId = null; // allow retry on next poll
  } else {
    cachedLyrics = cachedSynced;
  }

  prefetchNextLyrics(track.id);
}

function sendPlaybackUpdate(progressMs, isPlaying, deviceName) {
  if (!overlayWindow) return;
  overlayWindow.webContents.send('playback-update', {
    id:       lastTrackId,
    progress: progressMs,
    playing:  isPlaying,
    device:   deviceName || null,
  });
}

// --- Adaptive polling ----------------------------------------------------------
let pollTimer    = null;
let pollInFlight = null;

// Lyrics are animated from a local clock between polls, so polls only need to
// catch pauses, seeks and skips made outside the overlay.
const POLL_PLAYING_MS   = 5000;
const POLL_PAUSED_MS    = 10000;
const POLL_IDLE_MS      = 20000;  // nothing playing / no device
const POLL_HIDDEN_MULT  = 3;      // overlay minimised

function schedulePoll(delay) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!accessToken) return;
  if (delay == null) {
    const playing = lastKnown?.playing;
    delay = !lastKnown ? POLL_IDLE_MS : playing ? POLL_PLAYING_MS : POLL_PAUSED_MS;
    if (overlayWindow && overlayWindow.isMinimized()) delay *= POLL_HIDDEN_MULT;
    // Wake up right as the song should end so the next one shows promptly
    const remaining = estimatedRemainingMs();
    if (playing && remaining != null && remaining > -2000) delay = Math.min(delay, Math.max(remaining + 600, 500));
  }
  delay = Math.max(delay, bgBudgetWaitMs());
  const rl = rateLimitedUntil - Date.now();
  if (rl > 0) delay = Math.max(delay, rl + 1000);
  else if (rateLimitedUntil) { rateLimitedUntil = 0; saveJSON(RATE_FILE, { until: 0 }); sendRateLimitStatus(); }
  pollTimer = setTimeout(fetchAndSendCurrentState, Math.max(250, delay));
}

function fetchAndSendCurrentState() {
  if (pollInFlight) return pollInFlight;
  pollInFlight = doFetchState().finally(() => { pollInFlight = null; schedulePoll(); });
  return pollInFlight;
}

async function doFetchState() {
  if (!overlayWindow) return;
  try {
    const t0  = Date.now();
    const res = await spotifyRequest('/me/player', 'GET', null, false, true);
    const rtt = Date.now() - t0;
    if (!res.ok) return; // transient error — keep showing what we have
    const data = res.data;
    if (!data || !data.item) {
      lastKnown = null;
      overlayWindow.webContents.send('no-device');
      return;
    }
    // Compensates for half the request round-trip so lyrics aren't late
    const progress = data.is_playing ? Math.min(data.progress_ms + Math.round(rtt / 2), data.item.duration_ms) : data.progress_ms;
    lastKnown = { id: data.item.id, duration: data.item.duration_ms, progress, at: Date.now(), playing: data.is_playing };

    const isNewTrack = data.item.id !== lastTrackId;
    const trackPromise = handleTrackChange(
      data.item,
      progress,
      data.is_playing,
      data.shuffle_state,
      data.repeat_state,
      data.device?.volume_percent ?? 100,
      data.device?.name || null,
    );
    if (!isNewTrack) sendPlaybackUpdate(progress, data.is_playing, data.device?.name || null);
    // Don't block polling on the lyrics lookup
    trackPromise.catch((e) => console.error('handleTrackChange:', e.message));
  } catch (e) { console.error('fetchAndSendCurrentState:', e.message); }
}

function startFallbackPoll() {
  schedulePoll(0);
}

// --- Click-through & shortcuts -------------------------------------------------
function toggleClickThrough() {
  clickThrough = !clickThrough;
  if (overlayWindow) {
    overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    overlayWindow.webContents.send('click-through-changed', clickThrough);
  }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const register = (key, fn, label) => {
    if (!key) return;
    try {
      const ok = globalShortcut.register(key, fn);
      if (ok) console.log(`Shortcut registered: ${key} -> ${label}`);
      else    console.warn(`Could not register: ${key}`);
    } catch (e) { console.error(`Shortcut error (${key}):`, e.message); }
  };
  register(settings.clickThroughKey, toggleClickThrough, 'click-through');
  register(settings.playPauseKey,    async () => { const s = await getPlaybackState(); s?.is_playing ? await playbackPause() : await playbackPlay(); schedulePoll(400); }, 'play/pause');
  register(settings.nextKey,         async () => { await playbackNext();     schedulePoll(700); }, 'next');
  register(settings.prevKey,         async () => { await playbackPrevious(); schedulePoll(700); }, 'prev');
}

// --- Window --------------------------------------------------------------------
function getWindowBounds(mode) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  if (mode === 'fullscreen') return { width: sw, height: sh, x: 0, y: 0, resizable: false };
  if (mode === 'mini')       return { width: 300, height: 120, x: windowState.x ?? sw - 320, y: windowState.y ?? sh - 140, resizable: false };
  return {
    width:  windowState.width  || 320,
    height: windowState.height || 520,
    x: windowState.x ?? sw - 340,
    y: windowState.y ?? sh - 560,
    resizable: true,
  };
}

function createOverlayWindow() {
  const mode   = settings.fullscreenMode ? 'fullscreen' : settings.miniMode ? 'mini' : 'normal';
  const bounds = getWindowBounds(mode);

  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false, transparent: true, alwaysOnTop: settings.alwaysOnTop !== false,
    skipTaskbar: false, hasShadow: false,
    minWidth: 240, minHeight: 100,
    maxWidth: 1920, maxHeight: 1080,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });

  overlayWindow.setAlwaysOnTop(settings.alwaysOnTop !== false, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  const saveWinState = () => {
    if (!overlayWindow || settings.fullscreenMode || settings.miniMode) return;
    const [x, y]   = overlayWindow.getPosition();
    const [w, h]   = overlayWindow.getSize();
    windowState = { x, y, width: w, height: h };
    saveJSON(STATE_FILE, windowState);
  };
  overlayWindow.on('moved',   saveWinState);
  overlayWindow.on('resized', saveWinState);
  overlayWindow.on('closed',  () => { overlayWindow = null; });
  overlayWindow.on('restore', () => { if (accessToken) schedulePoll(300); });
}

function applyWindowMode(mode) {
  if (!overlayWindow) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  if (mode === 'fullscreen') {
    overlayWindow.setResizable(false);
    overlayWindow.setBounds({ x: 0, y: 0, width: sw, height: sh });
  } else if (mode === 'mini') {
    overlayWindow.setResizable(false);
    overlayWindow.setSize(300, 120);
  } else {
    overlayWindow.setResizable(true);
    overlayWindow.setBounds({
      x: windowState.x ?? sw - 340, y: windowState.y ?? sh - 560,
      width: windowState.width || 320, height: windowState.height || 520,
    });
  }
}

// --- OAuth server --------------------------------------------------------------
function startAuthServer() {
  if (authServer && authServer.listening) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    authServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname === '/callback' && parsed.query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:sans-serif;background:#121212;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✓ Connected! You can close this tab.</h2></body></html>`);
        try {
          const tokens   = await exchangeCode(parsed.query.code);
          accessToken    = tokens.access_token;
          refreshToken   = tokens.refresh_token;
          tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
          console.log('Auth successful');
        } catch (e) { console.error('Token exchange error:', e.message); }
        if (authWindow) { authWindow.close(); authWindow = null; }
        authServer.close(); authServer = null;

        // The first poll (right below) fills in track, shuffle, repeat and volume
        if (overlayWindow) overlayWindow.webContents.send('auth-success', { settings });
        sendRateLimitStatus();
        startFallbackPoll();
      }
    });
    authServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        authServer = null;
        setTimeout(() => startAuthServer().then(resolve).catch(reject), 1000);
      } else reject(err);
    });
    authServer.listen(8888, '127.0.0.1', () => {
      console.log('Auth server listening on 127.0.0.1:8888');
      resolve(true);
    });
  });
}

// --- IPC -----------------------------------------------------------------------
ipcMain.on('login', async () => {
  try {
    await startAuthServer();
    authWindow = new BrowserWindow({ width: 500, height: 700, autoHideMenuBar: true });
    authWindow.loadURL(getAuthUrl());
    authWindow.on('closed', () => { authWindow = null; });
  } catch (e) { console.error('Login error:', e.message); }
});

ipcMain.on('get-settings', (e) => { e.returnValue = settings; });

// Romanization of non-Latin lyrics (Japanese, Korean, Chinese, Cyrillic, …)
ipcMain.handle('transliterate', async (_, lines) => {
  if (!Array.isArray(lines)) return { lang: null, lines: [] };
  try { return await transliterateLines(lines.slice(0, 2000)); }
  catch (e) { console.error('transliterate:', e.message); return { lang: null, lines: lines.map(() => null) }; }
});

ipcMain.on('save-settings', (_, s) => {
  const prevCTKey = settings.clickThroughKey;
  settings = { ...settings, ...s };
  saveJSON(SETTINGS_FILE, settings);
  // Re-register shortcuts if any key changed
  if (s.clickThroughKey !== undefined || s.playPauseKey !== undefined || s.nextKey !== undefined || s.prevKey !== undefined) {
    registerShortcuts();
  }
  if (s.alwaysOnTop !== undefined && overlayWindow) {
    overlayWindow.setAlwaysOnTop(!!s.alwaysOnTop, 'screen-saver');
  }
  // Apply window mode if changed
  if (s.miniMode !== undefined || s.fullscreenMode !== undefined) {
    const mode = settings.fullscreenMode ? 'fullscreen' : settings.miniMode ? 'mini' : 'normal';
    applyWindowMode(mode);
    if (overlayWindow) overlayWindow.webContents.send('mode-changed', mode);
  }
});

ipcMain.on('toggle-click-through', () => toggleClickThrough());
ipcMain.on('get-click-through-key', (e) => { e.returnValue = settings.clickThroughKey || null; });

ipcMain.on('playback-play',     async () => { await playbackPlay();  schedulePoll(400); });
ipcMain.on('playback-pause',    async () => { await playbackPause(); schedulePoll(400); });
ipcMain.on('playback-next',     async () => { await playbackNext();     schedulePoll(700); });
ipcMain.on('playback-previous', async () => { await playbackPrevious(); schedulePoll(700); });
ipcMain.on('seek',              async (_, ms) => {
  await seekToPosition(ms);
  if (lastKnown) { lastKnown.progress = ms; lastKnown.at = Date.now(); }
  if (overlayWindow) overlayWindow.webContents.send('seek-ack', ms);
  schedulePoll(800);
});
ipcMain.on('set-volume',  async (_, pct)   => { await setVolume(pct); });
ipcMain.on('set-shuffle', async (_, state) => { await setShuffle(state); });
ipcMain.on('set-repeat',  async (_, state) => { await setRepeat(state); });

ipcMain.on('set-opacity',      (_, v) => { if (overlayWindow) overlayWindow.setOpacity(v); });
ipcMain.on('set-ignore-mouse', (_, b) => { if (overlayWindow) overlayWindow.setIgnoreMouseEvents(b, { forward: true }); });
ipcMain.on('close-overlay',    ()     => app.quit());

// Manual window dragging (used while the title bar auto-hides, where a native
// drag region would swallow the hover that reveals it). Uses the real cursor
// position so it stays accurate across monitors / DPI scaling.
let dragState = null;
ipcMain.on('drag-window', (_, phase) => {
  if (!overlayWindow) return;
  if (phase === 'start') {
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = overlayWindow.getPosition();
    const [w, h] = overlayWindow.getSize();
    dragState = { cx: cursor.x, cy: cursor.y, x, y, w, h };
  } else if (phase === 'move' && dragState) {
    const cursor = screen.getCursorScreenPoint();
    overlayWindow.setBounds({
      x: dragState.x + cursor.x - dragState.cx,
      y: dragState.y + cursor.y - dragState.cy,
      width: dragState.w, height: dragState.h,
    });
  } else if (phase === 'end') {
    if (dragState) overlayWindow.emit('moved'); // persist the new position
    dragState = null;
  }
});
ipcMain.on('minimize-overlay', ()     => overlayWindow?.minimize());

// Settings export/import
ipcMain.on('export-settings', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(overlayWindow, {
    title: 'Export Settings', defaultPath: 'h4nnis-overlay-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!canceled && filePath) {
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
  }
});

ipcMain.on('import-settings', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(overlayWindow, {
    title: 'Import Settings', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'],
  });
  if (!canceled && filePaths[0]) {
    try {
      const imported = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      settings = { ...defaultSettings, ...imported };
      saveJSON(SETTINGS_FILE, settings);
      registerShortcuts();
      if (overlayWindow) { overlayWindow.setAlwaysOnTop(settings.alwaysOnTop !== false, 'screen-saver'); overlayWindow.webContents.send('settings-imported', settings); }
    } catch (e) { console.error('Import error:', e.message); }
  }
});

ipcMain.on('reset-settings', () => {
  settings = { ...defaultSettings };
  saveJSON(SETTINGS_FILE, settings);
  registerShortcuts();
  if (overlayWindow) { overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.webContents.send('settings-imported', settings); }
});

// --- App lifecycle -------------------------------------------------------------
// One overlay at a time: a second copy would double the requests to Spotify
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!overlayWindow) return;
    if (overlayWindow.isMinimized()) overlayWindow.restore();
    overlayWindow.show();
    overlayWindow.focus();
  });
  app.whenReady().then(() => {
    createOverlayWindow();
    registerShortcuts();
    overlayWindow.webContents.on('did-finish-load', sendRateLimitStatus);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pollTimer)            clearTimeout(pollTimer);
});

app.on('window-all-closed', () => app.quit());
