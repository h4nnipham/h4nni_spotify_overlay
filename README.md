# h4nni's Lyrics Overlay for Spotify

A floating, always-on-top lyrics overlay for Spotify on Windows. It follows what you're playing through the Spotify Web API and shows smooth, synced lyrics over any window, with romanization for non-English songs.

![Version](https://img.shields.io/badge/version-1.5.0-1DB954?style=flat-square) ![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-white?style=flat-square)

---

## Features

### Lyrics
- **Synced lyrics** that scroll smoothly with the song. The current line is centered and animated at a steady 60fps
- **Fast track changes.** The overlay polls adaptively and wakes up right as each song ends, so the next song's lyrics appear straight away
- **Reliable matching.** Search results are checked against the title, artist and song length, so covers and wrong versions are skipped
- **Instant repeats.** Lyrics are cached, and the next song in your queue is fetched ahead of time
- **Click any line** to jump to that point in the song. Scroll with the mouse wheel to look around (it snaps back after 3 seconds)
- **Lyrics timing** offset if a song's lyrics feel early or late
- **Plain lyrics fallback** when no synced version exists, and a ♪ marker during instrumental breaks

### Romanization
Turn non-English lyrics into Latin letters with the **translate button** in the title bar:

| Language | Output | Example |
|---|---|---|
| Japanese | Hepburn romaji | 二人だけの空 → *futari dake no sora* |
| Korean | Revised Romanization | 사랑해요 → *saranghaeyo* |
| Chinese | Pinyin with tone marks | 我爱你 → *wǒ ài nǐ* |
| Cyrillic, Greek, Arabic, Hebrew, Thai, Hindi and more | Latin transliteration | Я тебя люблю → *Ya tebya lyublyu* |

Choose **Replace original** or **Show below original** in Settings. English words in mixed lines are left as they are.

### Look & feel
- **Background effects:** blurred album art, ambient colors from the album cover, or an accent glow
- **Accent color from album art,** so the highlights change color with each song
- **Dark and light themes,** with a custom accent color and background opacity
- **16 fonts,** sizes up to 56px, weights, line and letter spacing, alignment, text case and a readability shadow
- **Current line style:** pill, glow or plain, plus animation speed and blurring of distant lines
- **Window options:** always on top, show or hide the title bar (it appears when you hover at the top edge), border and corner radius

### Controls
- Play/pause, next, previous, a draggable seek bar, volume, shuffle and repeat (off / queue / track)
- **Mini mode:** just album art, the track name and the current lyric
- **Lyrics-only mode:** hide everything except the lyrics
- **Click-through mode,** so the overlay doesn't block your mouse
- **Global keyboard shortcuts** for play/pause, next, previous and click-through
- **Share card:** copy or save an image of the current line with the album art
- Shows the active device, with a warning when nothing is playing

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A free Spotify developer app (step 2)

### 1. Clone the repo

```bash
git clone https://github.com/h4nnipham/h4nni_spotify_overlay.git
```
```bash
cd h4nni_spotify_overlay
```

### 2. Set up Spotify credentials

Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app.

- Set the redirect URI to `http://127.0.0.1:8888/callback`
- Tick **Web API**
- Copy your Client ID and Client Secret

Copy the example config:

```bash
cp src/config.example.js src/config.js
```

Open `src/config.js` and paste in your credentials:

```js
module.exports = {
  SPOTIFY_CLIENT_ID:     'your_client_id_here',
  SPOTIFY_CLIENT_SECRET: 'your_client_secret_here',
};
```

`src/config.js` is git-ignored, so your keys are never committed.

### 3. Install dependencies

```bash
npm install
```

Run this again whenever you pull an update. New versions may add libraries (for example, the romanization libraries in 1.5.0).

### 4. Run

```bash
npm start
```

Or double-click `launch.bat`. Use `npm run dev` to see logs in the terminal.

### 5. Build an installer (optional)

```bash
npm run build
```

The installer and unpacked app are written to the `dist/` folder.

> **Note:** Building needs symlink permissions on Windows. Either run the terminal as administrator, or turn on Developer Mode in Settings → System → For developers.

---

## Usage

1. Launch the app and click **Connect with Spotify**, then sign in through the browser
2. Play something on Spotify. Lyrics appear automatically
3. Drag the overlay by its title bar and resize it from the edges
4. Open **Settings** with the gear icon. Changes are saved automatically

### Title bar buttons

| Button | What it does |
|---|---|
| — (first) | Mini mode |
| ≡▸ | Lyrics-only mode |
| 文A | Romanization on/off |
| Share | Make a share card of the current line |
| ⚙ | Settings |
| — / ✕ | Minimize / close |

### Settings

| Section | What's in it |
|---|---|
| **Show / hide** | Track info, progress bar, volume & shuffle, opacity slider, title bar, window border. Every switch: on = shown |
| **Window** | Always on top, background opacity, corner radius |
| **Colors & background** | Theme, accent color, accent from album art, background effect and strength |
| **Lyrics text** | Font, current and other line sizes and weights, line and letter spacing, alignment, text case, text shadow |
| **Current line & motion** | Line style, glow, animation speed, blur for distant lines, lyrics timing |
| **Romanization** | Off / Replace original / Show below original |
| **Lyric colors** | Current, upcoming, and past & distant lines |
| **Keyboard shortcuts** | Click a field and press a key. Right-click to clear |
| **Settings data** | Export, import or reset to defaults |

---

## Lyric sources

Spotify's Web API doesn't provide lyrics, so they come from free, community-run databases. They're tried in this order, and synced lyrics are always preferred over plain:

1. **LRCLIB, exact match:** title, artist, album and duration
2. **LRCLIB, structured search:** results are scored by title, artist and duration
3. **LRCLIB, cleaned title:** without suffixes like "- Remastered 2011" or "(feat. …)"
4. **LRCLIB, free-text search**
5. **lyrics.ovh:** plain lyrics for older or popular tracks

Results are cached in `lyrics-cache.json` in the app's data folder. Network failures are retried and never cached as "no lyrics", so a song isn't stuck without lyrics after a connection drop.

If a song has no lyrics, or the wrong ones, you can add or fix them at [lrclib.net](https://lrclib.net), and the overlay picks them up.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Romanization needs its libraries" message | Run `npm install` in the app folder, then restart |
| "Romanization needs the updated preload.js" | Make sure all files in `src/` are from the same version |
| "No active Spotify device" | Start playing on any device. The overlay follows whatever is active on your account |
| Lyrics feel early or late | Adjust **Lyrics timing** in Settings → Current line & motion |
| Wrong lyrics or none | The song may be missing or mismatched on LRCLIB. You can add it there |
| Overlay hidden behind a game | Run the game in borderless windowed mode |

---

## Known limitations

- **Japanese readings are automatic.** Kanji can be read several ways and songs sometimes use unusual readings, so some romaji may be off. The Japanese dictionary also adds about 50MB to the install and loads the first time a Japanese song plays
- **No word-by-word timing.** LRCLIB lyrics are timed per line
- **Exclusive fullscreen games** can cover the overlay. Borderless windowed mode works best

---

## License

MIT. Do whatever you want with it.
"# h4nni_spotify_overlay" 
