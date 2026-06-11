const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotify', {
  // Auth
  login: () => ipcRenderer.send('login'),

  // Window
  closeOverlay:    () => ipcRenderer.send('close-overlay'),
  minimizeOverlay: () => ipcRenderer.send('minimize-overlay'),
  setOpacity:      (v) => ipcRenderer.send('set-opacity', v),
  setIgnoreMouse:  (b) => ipcRenderer.send('set-ignore-mouse', b),

  // Settings
  getSettings:    () => ipcRenderer.sendSync('get-settings'),
  saveSettings:   (s) => ipcRenderer.send('save-settings', s),
  exportSettings: () => ipcRenderer.send('export-settings'),
  importSettings: () => ipcRenderer.send('import-settings'),
  resetSettings:  () => ipcRenderer.send('reset-settings'),

  // Click-through
  toggleClickThrough:  () => ipcRenderer.send('toggle-click-through'),
  getClickThroughKey:  () => ipcRenderer.sendSync('get-click-through-key'),

  // Playback
  playbackPlay:    () => ipcRenderer.send('playback-play'),
  playbackPause:   () => ipcRenderer.send('playback-pause'),
  playbackNext:    () => ipcRenderer.send('playback-next'),
  playbackPrevious:() => ipcRenderer.send('playback-previous'),
  seek:            (ms)    => ipcRenderer.send('seek', ms),
  setVolume:       (pct)   => ipcRenderer.send('set-volume', pct),
  setShuffle:      (state) => ipcRenderer.send('set-shuffle', state),
  setRepeat:       (state) => ipcRenderer.send('set-repeat', state),

  // Events
  onAuthSuccess:         (cb) => ipcRenderer.on('auth-success',         (_, d) => cb(d)),
  onTrackChanged:        (cb) => ipcRenderer.on('track-changed',        (_, d) => cb(d)),
  onPlaybackUpdate:      (cb) => ipcRenderer.on('playback-update',      (_, d) => cb(d)),
  onSeekAck:             (cb) => ipcRenderer.on('seek-ack',             (_, d) => cb(d)),
  onClickThroughChanged: (cb) => ipcRenderer.on('click-through-changed',(_, d) => cb(d)),
  onModeChanged:         (cb) => ipcRenderer.on('mode-changed',         (_, d) => cb(d)),
  onSettingsImported:    (cb) => ipcRenderer.on('settings-imported',    (_, d) => cb(d)),
  onNoDevice:            (cb) => ipcRenderer.on('no-device',            ()     => cb()),
});
