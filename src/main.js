const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog } = require('electron');
const path = require('path');
const http = require('http');
const url  = require('url');
const fs   = require('fs');
const ws   = require('ws');

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = require('./config');
const REDIRECT_URI          = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state streaming';

// ─── Persistence ───────────────────────────────────────────────────────────────
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
  miniMode: false, fullscreenMode: false,
};

let settings    = loadJSON(SETTINGS_FILE, defaultSettings);
let windowState = loadJSON(STATE_FILE, { x: null, y: null, width: 320, height: 520 });

// ─── App state ─────────────────────────────────────────────────────────────────
let overlayWindow  = null;
let authWindow     = null;
let authServer     = null;
let accessToken    = null;
let refreshToken   = null;
let tokenExpiresAt = 0;
let clickThrough   = false;
let dealer         = null;      // WebSocket connection to Spotify dealer
let dealerPingTimer = null;
let dealerReconnectTimer = null;
let dealerFetchTimeout = null;
let lastTrackId    = null;
let cachedLyrics   = [];
let fallbackPollInterval = null; // safety net poll if WS drops

// ─── Auth ───────────────────────────────────────────────────────────────────────
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT_URI, scope: SCOPES,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCode(code) {
  const fetch = require('node-fetch');
  const body  = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return r.json();
}

async function refreshAccessToken() {
  const fetch = require('node-fetch');
  const body  = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await r.json();
  if (data.access_token) {
    accessToken    = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    // Reconnect dealer with fresh token
    connectDealer();
  }
}

async function getValidToken() {
  if (!accessToken) return null;
  if (Date.now() > tokenExpiresAt - 60000) await refreshAccessToken();
  return accessToken;
}

// ─── Spotify REST API ──────────────────────────────────────────────────────────
async function spotifyFetch(endpoint, method = 'GET', bodyData = null) {
  const token = await getValidToken();
  if (!token) return null;
  const fetch = require('node-fetch');
  try {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (bodyData) opts.body = JSON.stringify(bodyData);
    const response = await fetch(`https://api.spotify.com/v1${endpoint}`, opts);
    if (response.status === 204 || response.status === 202) return null;
    if (response.status === 401) { await refreshAccessToken(); return null; }
    if (response.status === 429) {
      const wait = parseInt(response.headers.get('retry-after') || '10') * 1000;
      console.warn(`Rate limited ${wait / 1000}s`);
      return null;
    }
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch (err) { console.error(`spotifyFetch [${endpoint}]:`, err.message); return null; }
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
const getCurrentlyPlaying = () => spotifyFetch('/me/player/currently-playing');

// ─── Lyrics ────────────────────────────────────────────────────────────────────
async function fetchLyrics(trackName, artistName, albumName, durationMs) {
  const fetch = require('node-fetch');

  // 1. Try LRCLIB for synced lyrics
  try {
    const params = new URLSearchParams({
      track_name: trackName, artist_name: artistName,
      album_name: albumName, duration: Math.round(durationMs / 1000),
    });
    const r = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { 'User-Agent': 'SpotifyLyricsOverlay/1.3.1' },
    });
    if (r.ok) {
      const data = await r.json();
      if (data.syncedLyrics) return { lrc: data.syncedLyrics, plain: data.plainLyrics || null, source: 'lrclib' };
      if (data.plainLyrics)  return { lrc: null, plain: data.plainLyrics, source: 'lrclib' };
    }
  } catch {}

  // 2. Fallback: search LRCLIB by query
  try {
    const params = new URLSearchParams({ q: `${trackName} ${artistName}` });
    const r = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { 'User-Agent': 'SpotifyLyricsOverlay/1.3.1' },
    });
    if (r.ok) {
      const results = await r.json();
      if (results.length > 0) {
        const best = results[0];
        if (best.syncedLyrics) return { lrc: best.syncedLyrics, plain: best.plainLyrics || null, source: 'lrclib-search' };
        if (best.plainLyrics)  return { lrc: null, plain: best.plainLyrics, source: 'lrclib-search' };
      }
    }
  } catch {}

  // 3. Fallback: Lyrics.ovh (good for older/popular tracks)
  try {
    const artist = encodeURIComponent(artistName);
    const title  = encodeURIComponent(trackName);
    const r = await fetch(`https://api.lyrics.ovh/v1/${artist}/${title}`);
    if (r.ok) {
      const data = await r.json();
      if (data.lyrics) return { lrc: null, plain: data.lyrics, source: 'lyrics.ovh' };
    }
  } catch {}

  return { lrc: null, plain: null, source: null };
}

function parseLRC(lrc) {
  if (!lrc) return [];
  const parsed = [];
  const timeRx = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;
  for (const line of lrc.split('\n')) {
    const text = line.replace(/\[.*?\]/g, '').trim();
    if (!text) continue;
    timeRx.lastIndex = 0;
    let match;
    while ((match = timeRx.exec(line)) !== null) {
      const ms = (parseInt(match[1]) * 60 + parseInt(match[2])) * 1000 + parseInt(match[3].padEnd(3, '0'));
      parsed.push({ time: ms, text });
    }
  }
  return parsed.sort((a, b) => a.time - b.time);
}

// ─── Handle track change (called from WS event or fallback poll) ───────────────
async function handleTrackChange(track, progressMs, isPlaying, shuffleState, repeatState, volume, deviceName) {
  if (!overlayWindow) return;
  if (track.id === lastTrackId) return;
  lastTrackId  = track.id;
  cachedLyrics = [];

  const { lrc, plain, source } = await fetchLyrics(
    track.name, track.artists[0].name, track.album.name, track.duration_ms
  );
  const synced = parseLRC(lrc);
  cachedLyrics = synced;

  overlayWindow.webContents.send('track-changed', {
    id:         track.id,
    name:       track.name,
    artist:     track.artists[0].name,
    album:      track.album.name,
    art:        track.album.images[0]?.url || null,
    duration:   track.duration_ms,
    progress:   progressMs,
    playing:    isPlaying,
    shuffle:    shuffleState,
    repeat:     repeatState,
    volume:     volume,
    device:     deviceName || null,
    lyrics:     synced,
    plainLyrics: plain || null,
    lyricsSource: source,
  });
}

function sendPlaybackUpdate(progressMs, isPlaying, deviceName) {
  if (!overlayWindow) return;
  overlayWindow.webContents.send('playback-update', {
    progress: progressMs,
    playing:  isPlaying,
    device:   deviceName || null,
  });
}

// ─── Spotify Dealer WebSocket ──────────────────────────────────────────────────
async function connectDealer() {
  if (dealer) {
    try { dealer.close(); } catch {}
    dealer = null;
  }
  if (dealerPingTimer)     { clearInterval(dealerPingTimer);   dealerPingTimer = null; }
  if (dealerReconnectTimer){ clearTimeout(dealerReconnectTimer); dealerReconnectTimer = null; }

  const token = await getValidToken();
  if (!token) return;

  console.log('Connecting to Spotify dealer WebSocket…');

  try {
    dealer = new ws.WebSocket(`wss://dealer.spotify.com/?access_token=${token}`, {
      headers: {
        'Origin': 'https://open.spotify.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    });
  } catch (e) {
    console.error('Dealer WS create error:', e.message);
    scheduleReconnect();
    return;
  }

  dealer.on('open', () => {
    console.log('Dealer WebSocket connected — waiting for connection ID…');
    // Ping every 30s to keep alive
    dealerPingTimer = setInterval(() => {
      if (dealer && dealer.readyState === ws.WebSocket.OPEN) {
        dealer.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  });

  dealer.on('message', async (raw) => {
    const str = raw.toString();
    let msg;
    try { msg = JSON.parse(str); } catch { console.log('Dealer non-JSON frame, ignoring'); return; }
    try {
      // First message contains the connection_id — use it to subscribe
      if (msg.headers?.['Spotify-Connection-Id']) {
        const connId = msg.headers['Spotify-Connection-Id'];
        await registerDealerSubscriptions(connId);
        // Now safe to fetch initial state
        fetchAndSendCurrentState();
        return;
      }


      // Any message with payloads means playback state may have changed
      // Since payloads are protobuf (not JSON), we just trigger a REST fetch
      if (msg.payloads && msg.payloads.length > 0) {
        // Debounce — avoid hammering REST if multiple messages arrive at once
        if (dealerFetchTimeout) clearTimeout(dealerFetchTimeout);
        dealerFetchTimeout = setTimeout(async () => { await fetchAndSendCurrentState(); setTimeout(fetchAndSendCurrentState, 1500); }, 700);
      }
    } catch (e) { /* ignore parse errors */ }
  });

  dealer.on('close', (code) => {
    console.warn(`Dealer WS closed (${code}), reconnecting…`);
    if (dealerPingTimer) { clearInterval(dealerPingTimer); dealerPingTimer = null; }
    dealer = null;
    scheduleReconnect();
  });

  dealer.on('error', (err) => {
    console.error('Dealer WS error:', err.message);
    // close handler will trigger reconnect
  });
}

async function registerDealerSubscriptions(connId) {
  const fetch = require('node-fetch');
  const token = await getValidToken();
  if (!token) { console.error('No valid token for dealer subscription'); return; }
  try {
    const r = await fetch(
      `https://api.spotify.com/v1/me/notifications/player?connection_id=${encodeURIComponent(connId)}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('Dealer subscription status:', r.status, r.statusText);
    if (r.ok || r.status === 204) console.log('Dealer subscriptions registered ✓');
    else console.error('Dealer subscription failed:', r.status);
  } catch (e) {
    console.error('Dealer sub error:', e.message);
  }
}

async function handleDealerPayload(payload) {
  let data;

  // Payloads arrive as strings — try plain JSON first, then base64
  if (typeof payload === 'string') {
    try { data = JSON.parse(payload); } catch {
      try { data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch { return; }
    }
  } else if (Buffer.isBuffer(payload)) {
    try { data = JSON.parse(payload.toString('utf8')); } catch { return; }
  } else if (typeof payload === 'object') {
    data = payload;
  } else { return; }

  // Navigate possible nesting
  const cluster     = data?.cluster || data;
  const playerState = cluster?.player_state || data?.player_state;
  if (!playerState) return;

  const trackUri  = playerState?.track?.uri;
  if (!trackUri) return;

  const trackId   = trackUri.split(':').pop();
  const isPlaying = !playerState.is_paused;
  const progressMs = parseInt(playerState.position_as_of_timestamp || playerState.position || '0');

  // Device name from cluster
  const activeDeviceId = cluster?.active_device_id;
  const deviceName = activeDeviceId && cluster?.devices
    ? (cluster.devices[activeDeviceId]?.name || null)
    : null;

  sendPlaybackUpdate(progressMs, isPlaying, deviceName);

  if (trackId !== lastTrackId) {
    // Fetch full state from REST to get track metadata, shuffle, repeat, volume
    const fullState = await getPlaybackState();
    if (fullState?.item) {
      await handleTrackChange(
        fullState.item,
        fullState.progress_ms,
        fullState.is_playing,
        fullState.shuffle_state,
        fullState.repeat_state,
        fullState.device?.volume_percent ?? 100,
        fullState.device?.name || null,
      );
    }
  }
}

function scheduleReconnect(delay = 5000) {
  if (dealerReconnectTimer) return;
  dealerReconnectTimer = setTimeout(async () => {
    dealerReconnectTimer = null;
    await connectDealer();
  }, delay);
}

// ─── Fallback poll (fires every 30s as a safety net if WS is silent) ──────────
async function fetchAndSendCurrentState() {
  if (!overlayWindow) return;
  try {
    const data = await getPlaybackState();
    if (!data || !data.item) {
      overlayWindow.webContents.send('no-device');
      return;
    }
    await handleTrackChange(
      data.item,
      data.progress_ms,
      data.is_playing,
      data.shuffle_state,
      data.repeat_state,
      data.device?.volume_percent ?? 100,
      data.device?.name || null,
    );
    sendPlaybackUpdate(data.progress_ms, data.is_playing, data.device?.name || null);
  } catch (e) { console.error('fetchAndSendCurrentState:', e.message); }
}

function startFallbackPoll() {
  if (fallbackPollInterval) clearInterval(fallbackPollInterval);
  fallbackPollInterval = setInterval(fetchAndSendCurrentState, 30000);
}

// ─── Click-through & shortcuts ─────────────────────────────────────────────────
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
      if (ok) console.log(`Shortcut registered: ${key} → ${label}`);
      else    console.warn(`Could not register: ${key}`);
    } catch (e) { console.error(`Shortcut error (${key}):`, e.message); }
  };
  register(settings.clickThroughKey, toggleClickThrough, 'click-through');
  register(settings.playPauseKey,    async () => { const s = await getPlaybackState(); s?.is_playing ? await playbackPause() : await playbackPlay(); }, 'play/pause');
  register(settings.nextKey,         async () => { await playbackNext();     setTimeout(fetchAndSendCurrentState, 800); }, 'next');
  register(settings.prevKey,         async () => { await playbackPrevious(); setTimeout(fetchAndSendCurrentState, 800); }, 'prev');
}

// ─── Window ────────────────────────────────────────────────────────────────────
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
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: false, hasShadow: false,
    minWidth: 240, minHeight: 100,
    maxWidth: 1920, maxHeight: 1080,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
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

// ─── OAuth server ──────────────────────────────────────────────────────────────
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

        const playbackData = await getPlaybackState();
        if (overlayWindow) {
          overlayWindow.webContents.send('auth-success', {
            shuffle:  playbackData?.shuffle_state ?? false,
            repeat:   playbackData?.repeat_state  ?? 'off',
            volume:   playbackData?.device?.volume_percent ?? 100,
            device:   playbackData?.device?.name || null,
            settings,
          });
        }
        // Start WS + fallback poll
        await connectDealer();
        startFallbackPoll();
        fetchAndSendCurrentState();
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

// ─── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.on('login', async () => {
  try {
    await startAuthServer();
    authWindow = new BrowserWindow({ width: 500, height: 700, autoHideMenuBar: true });
    authWindow.loadURL(getAuthUrl());
    authWindow.on('closed', () => { authWindow = null; });
  } catch (e) { console.error('Login error:', e.message); }
});

ipcMain.on('get-settings', (e) => { e.returnValue = settings; });

ipcMain.on('save-settings', (_, s) => {
  const prevCTKey = settings.clickThroughKey;
  settings = { ...settings, ...s };
  saveJSON(SETTINGS_FILE, settings);
  // Re-register shortcuts if any key changed
  if (s.clickThroughKey !== undefined || s.playPauseKey !== undefined || s.nextKey !== undefined || s.prevKey !== undefined) {
    registerShortcuts();
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

ipcMain.on('playback-play',     async () => { await playbackPlay(); });
ipcMain.on('playback-pause',    async () => { await playbackPause(); });
ipcMain.on('playback-next',     async () => { await playbackNext();     setTimeout(fetchAndSendCurrentState, 800); });
ipcMain.on('playback-previous', async () => { await playbackPrevious(); setTimeout(fetchAndSendCurrentState, 800); });
ipcMain.on('seek',              async (_, ms) => {
  await seekToPosition(ms);
  if (overlayWindow) overlayWindow.webContents.send('seek-ack', ms);
});
ipcMain.on('set-volume',  async (_, pct)   => { await setVolume(pct); });
ipcMain.on('set-shuffle', async (_, state) => { await setShuffle(state); });
ipcMain.on('set-repeat',  async (_, state) => { await setRepeat(state); });

ipcMain.on('set-opacity',      (_, v) => { if (overlayWindow) overlayWindow.setOpacity(v); });
ipcMain.on('set-ignore-mouse', (_, b) => { if (overlayWindow) overlayWindow.setIgnoreMouseEvents(b, { forward: true }); });
ipcMain.on('close-overlay',    ()     => app.quit());
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
      if (overlayWindow) overlayWindow.webContents.send('settings-imported', settings);
    } catch (e) { console.error('Import error:', e.message); }
  }
});

ipcMain.on('reset-settings', () => {
  settings = { ...defaultSettings };
  saveJSON(SETTINGS_FILE, settings);
  registerShortcuts();
  if (overlayWindow) overlayWindow.webContents.send('settings-imported', settings);
});

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createOverlayWindow();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (dealer)               { try { dealer.close(); } catch {} }
  if (dealerPingTimer)      clearInterval(dealerPingTimer);
  if (dealerReconnectTimer) clearTimeout(dealerReconnectTimer);
  if (dealerFetchTimeout)   clearTimeout(dealerFetchTimeout);
  if (fallbackPollInterval) clearInterval(fallbackPollInterval);
});

app.on('window-all-closed', () => app.quit());
