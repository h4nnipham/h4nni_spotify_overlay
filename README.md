# h4nni's Lyrics Overlay for Spotify

A floating real-time lyrics overlay for Spotify on Windows. Displays synced lyrics on top of any window using the Spotify dealer WebSocket for instant, rate-limit-free updates.

![Version](https://img.shields.io/badge/version-1.3.1-1DB954?style=flat-square) ![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-white?style=flat-square)

---

## Features

- Real-time synced lyrics via Spotify's dealer WebSocket — no polling, no rate limits
- Click any lyric line to seek to that position
- Draggable seek bar and volume control
- Shuffle and repeat controls (off / queue / track)
- Dark and light themes with custom accent colour
- 8 font choices, adjustable sizes and weights, custom lyric colours
- Mini mode — just album art, track name and current lyric
- Keyboard shortcuts for play/pause, next, prev and click-through toggle (all manually set)
- Click-through mode so the overlay doesn't block mouse input
- Plain/unsynced lyrics fallback when no synced version is available
- Lyrics sharing — generate and copy/save a card image with the current line
- Settings saved between sessions, with export/import/reset
- Window position and size remembered between sessions
- Active device display and no-device indicator

---

## Download

Grab the latest installer from [Releases](../../releases/latest). Run the `.exe` and you're good to go — no setup needed, just connect your Spotify account on first launch.

---

## Building from source

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A Spotify developer account

### 1. Clone the repo

```bash
git clone https://github.com/h4nnipham/h4nni_spotify_overlay.git
cd YOUR_REPO_NAME
```

### 2. Set up Spotify credentials

Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create a new app.

- Set the redirect URI to `http://127.0.0.1:8888/callback`
- Copy your Client ID and Client Secret

Then in the `src/` folder:

```bash
cp src/config.example.js src/config.js
```

Open `src/config.js` and paste your credentials:

```js
module.exports = {
  SPOTIFY_CLIENT_ID:     'your_client_id_here',
  SPOTIFY_CLIENT_SECRET: 'your_client_secret_here',
};
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run in development

```bash
npm start
```

### 5. Build installer

```bash
npm run build
```

The installer and unpacked app will be in the `dist/` folder.

> **Note:** Building requires symlink permissions on Windows. Either run the terminal as administrator or enable Developer Mode in Settings → System → For developers.

---

## Usage

1. Launch the app — a login screen will appear
2. Click **Connect with Spotify** and sign in through the browser
3. Play something on Spotify — lyrics will appear automatically
4. Drag the overlay anywhere on screen
5. Press your click-through shortcut (set in Settings) to make the overlay non-interactive

### Settings

Open settings with the gear icon in the top bar. All settings are saved automatically.

| Setting | Description |
|---|---|
| Theme | Dark or light |
| Accent colour | Changes highlights, active lyric glow and border |
| Background opacity | Also controls the border opacity |
| Font | 8 options including Syne, Inter, Playfair Display |
| Hide opacity/playback controls | Clean up the bottom bar |
| Keyboard shortcuts | Set keys for play/pause, next, prev, click-through |
| Export / Import / Reset | Back up or share your settings |

---

## Lyric sources

Lyrics are fetched in this order:
1. **LRCLIB** (exact match) — synced LRC lyrics
2. **LRCLIB** (search fallback) — broader search if exact match fails
3. **lyrics.ovh** — plain lyrics fallback for older/popular tracks

---

## Known limitations

- **Exclusive fullscreen games** — works best when games run in borderless windowed mode.

---

## License

MIT — do whatever you want with it.
