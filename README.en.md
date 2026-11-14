# MarkPlay

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4.svg)](#requirements)
[![Version](https://img.shields.io/badge/version-v1.2.1-green.svg)](#)

[中文](README.md) | **English**

> A video player built for reviewing footage and logging markers.
>
> Scrub with your trackpad, tag moments with `A`–`G`, mark in/out ranges, then cut clips in-app or merge them into one file.
> Export CSV / EDL straight into Premiere or DaVinci Resolve.

<img width="1263" alt="MarkPlay UI" src="https://github.com/user-attachments/assets/016a646d-f396-438e-a08b-6de96b482b48" />

<p align="center"><sub>Sidebar panels, top to bottom: Markers → Ranges → Clip → Export</sub></p>

## The problem it solves

When you review footage, you repeat the same three steps: skim through, note what's usable, then cut it out precisely. A general-purpose player makes that painful —

- Scrubbing a seek bar **overshoots or lands imprecisely**; hunting for a 2-second moment in a two-hour file is miserable.
- To note "this shot is good", you either write timecodes on paper or juggle windows.
- Afterwards you **re-enter every timecode by hand** in your NLE.

MarkPlay turns those three steps into one continuous flow of gestures and shortcuts:

1. **Scrub** — push the trackpad left/right for inertial, frame-accurate scrubbing that never chokes. Slow drags automatically switch to exact seek.
2. **Mark** — hit `A` / `B` / `C` / `D` / `F` / `G` to drop typed markers; the sidebar list updates live.
3. **Cut** — set in/out with `[` `]` to create a range, cut it in-app, or merge several ranges into one file. Or export CSV / EDL for your editor.

## Install

> **The installer is not code-signed yet**, so Windows SmartScreen will warn about an unknown publisher.
> Click **More info → Run anyway**. This is normal for a personal project and doesn't affect functionality.

1. Grab `MarkPlay Setup x.y.z.exe` from [Releases](https://github.com/glowwan/markplay/releases)
2. Run the installer (installs to `%LOCALAPPDATA%\Programs\MarkPlay`, no admin rights needed)
3. Press `O` to open a video, or drag a file into the window

**Requirements:** Windows 10 / 11 x64. No Node.js or other runtime needed — mpv and ffmpeg are bundled.

## Quick start

| Step | Action |
|---|---|
| Open | Press `O`, or drag a file into the window |
| Scrub | Push the trackpad left/right, or `←` `→` to jump 5s |
| Mark | Play to a spot, press `A` (or B/C/D/F/G) |
| Range | Press `[` at the in-point, `]` at the out-point |
| Cut | Pick the range in the Clip panel → Start clip |

## Interface

Sidebar panels, top to bottom: **Markers** → **Ranges** → **Clip** → **Export**.

The control bar sits below the video rather than floating over it — the video surface is mpv's native child window, which HTML can't overlay (see [Known limitations](#known-limitations)).

## Features

**Playback**

- **Universal decoding via mpv** — mpv is embedded as a native child window, so format support is effectively unlimited (MKV, TS, any codec).
- **Inertial trackpad scrubbing** — push to scrub; smoothing is filtered so frames never jump.
- **Trackpad volume** — vertical push adjusts volume.
- **Frame stepping** — `,` / `.` for exact single-frame steps.
- **A–B loop** — `L` loops the selected range; the button shows `A–B 1` and follows range switches.
- **2x speed** — left-click the video for 2x forward, right-click for 2x reverse (reverse is simulated: pause + timed rewind, since mpv doesn't support negative speed).
- **Fullscreen** — `F11` or ⛶, `ESC` to exit.
- **Subtitles** — auto-loads same-named subtitle files; drop a `.srt` / `.ass` / `.vtt` into the window to attach manually.

**Markers & ranges**

- **Typed markers** — six marker types `A`–`G`, each numbered independently.
- **Marker editing** — double-click a label to rename inline; drag a timeline tick to retime; `Delete` to remove; `Ctrl+Z` / `Ctrl+Shift+Z` to undo/redo.
- **Explicit ranges** — `[` sets in, `]` sets out. Rename by double-click, click to jump to in-point, drag either end of the range bar to adjust in/out.
- **Generate ranges** — **A/B pairing** (each A → nearest following B) or **adjacent pairing** (1-2, 3-4…, any marker type).
- **Timeline zoom** — `Ctrl+wheel` / `Ctrl+=` `Ctrl+-` to zoom (works over the video too), `Shift+wheel` to pan, `Ctrl+0` to fit. The playhead auto-follows when it leaves the view.
- **Large lists stay smooth** — marker and range lists are virtualized; thousands of entries won't rebuild the whole DOM.

**Export & cutting**

- **Marker export** — marker CSV / range CSV / EDL (CMX3600) / JSON. Frame numbers and timecode follow the source frame rate (23.976 / 29.97 are no longer computed as 25fps).
- **Clip** — cut the selected range with ffmpeg: `-c copy` (fast, lossless) or re-encode (frame-accurate, bitrate derived from the source file so output size stays close to the original).
- **Batch clip** — one file per range, exported in one go.
- **Merge** — tick "Merge into one file" to concatenate all ranges into a single video.

**Other**

- **Drag to open** — drop a video anywhere in the window.
- **Remembers state** — window geometry, volume, recent files, last folder.
- **Single instance** — opening a second file hands it to the running window instead of spawning a rival process that would fight over the marker file.
- **Logging** — crashes, mpv stderr and ffmpeg failures all land in `logs/markplay.log`; reachable from Help → Open log folder.

## Keyboard shortcuts

| Key | Action |
|------|--------|
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward 5s (configurable in `config.js`) |
| `,` / `.` | Previous / next frame (auto-pauses) |
| `A` / `B` / `C` / `D` / `F` / `G` | Drop a typed marker (`E` is reserved for the export panel) |
| `[` / `]` | Set range in-point / out-point and create the range (physical key detection, works with IME on) |
| `X` | 2x forward / restore (same as left-clicking the video) |
| `Z` | 2x reverse / restore (same as right-clicking the video) |
| `L` | Toggle A–B loop on the selected range |
| `Ctrl+wheel` / `Ctrl+=` / `Ctrl+-` | Zoom timeline (anchored at cursor / playhead) |
| `Ctrl+0` | Fit timeline to the whole video |
| `Shift+wheel` | Pan the timeline |
| `Delete` | Delete the selected marker |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `F11` | Toggle video fullscreen (`ESC` also exits) |
| `O` | Open a video file |
| `E` | Scroll to the export panel |

Single-key shortcuts yield to text input while a text field has focus.

Trackpad: two-finger tap = right click, which over the video triggers 2x reverse. Three-finger tap triggers 2x forward if you've mapped it to middle-click in Windows touchpad settings. Static multi-finger touches (fingers resting without moving) produce no events from Windows at all — that would require a native hook module and isn't implemented.

## Tuning the scrubbing feel

Everything lives in `src/config.js`; restart the app after editing (no rebuild needed):

| Option | Meaning | How to tune |
|------|------|--------|
| `SCRUB_SENSITIVITY` | Seconds of video per pixel of travel | Feel sluggish → raise; feels twitchy → lower |
| `SCRUB_SMOOTHING` | Inertial filter strength | Higher is smoother but laggier; lower if it feels delayed |
| `SCRUB_IDLE_MS` | Grace period after your fingers leave the pad before scrub ends and playback resumes | Raise if you trigger it accidentally; lower if it feels sticky |
| `SCRUB_INERTIA_DECAY` | Fraction of velocity retained per frame after release (0–1) | Lower stops sooner; higher (e.g. 0.96) glides longer |
| `SCRUB_INVERT_X` | `true` = content follows finger (push right → rewind); `false` = scrollbar logic | Flip if the direction feels backwards |
| `SCRUB_KEYFRAME_VELOCITY` | Fast/slow threshold (video-seconds per real-second); below it uses exact seek, above uses keyframes | Lower if slow drags feel imprecise; raise if fast drags stutter |
| `SURFACE_APPLY_DPI_SCALE` | Troubleshooting switch for exotic DPI setups; keep `false` | First thing to check if the video area is misaligned |

Change one value at a time, by 20–30%. Trackpad drivers vary a lot between models — trust your own hands.

**Why it feels responsive:** during a drag we issue `absolute+keyframes` seeks (land on a keyframe, 5–50ms, picture follows continuously). Only slow fine-tuning (<1 video-second per real-second) uses `absolute+exact`, and on release we do one final exact seek to land precisely. An exact seek must decode forward from the previous keyframe (up to ~1200ms on long GOPs), so issuing exact seeks during a drag inevitably backs up and drops frames — that was the original source of stutter. `--hr-seek-framedrop=yes` further speeds up exact seeks.

## Marker file format

- **Sidecar file**: markers and ranges are stored next to the video as `<filename>.markplay.json` (e.g. `trip.mp4` → `trip.mp4.markplay.json`). The extension is *appended* rather than replaced so that `a.mp4` and `a.mkv` don't overwrite each other. Delete it along with the video. If a file contains historical duplicates, they're de-duplicated by id on open and written back clean.
- **Format v2**: `{version:2, video, markers:[...], ranges:[...]}`. Older v1 files (markers only) load fine with an empty range list.
- **Marker CSV columns**: `index,label,kind,time_seconds,timecode,frame,end_seconds,end_tc`
- **Range CSV columns**: `index,name,in_seconds,in_tc,in_frame,out_seconds,out_tc,out_frame,duration_seconds`
- **EDL**: CMX3600 text with `FCM: NON-DROP FRAME`; the record timeline accumulates from `01:00:00:00`. Ranges are used when present, otherwise it falls back to segmenting by markers. Frame numbers follow the source frame rate (read from mpv's `container-fps`; 23.976 → 24, 29.97 → 30, 59.94 → 60 nominal non-drop). A `* MARKPLAY FPS: 24 (source 23.976)` comment records the rate used.
- **Merging** always re-encodes; for lossless output, use batch clip instead and join in your NLE.

## Build from source

**Requirements**: Windows 10 / 11 x64, Node.js 18+ (LTS is fine).

1. Install Node.js: https://nodejs.org/
2. Extract the source anywhere (avoid non-ASCII or spaces in the path)
3. Double-click `build.bat` — it checks Node, runs `npm install`, downloads `mpv.exe` / `ffmpeg.exe`, then packages
4. The installer appears in `dist\`

Or manually:

```powershell
npm install
npm run fetch-bin   # downloads mpv.exe / ffmpeg.exe into resources/bin
npm start           # run in dev mode
npm test            # 47 unit tests, no Electron needed
npm run check:dom   # DOM id / script reference sanity check
npx electron-builder --win --x64
```

If `npm install` is slow, use a mirror:

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## Docs

- [CHANGELOG.md](CHANGELOG.md) — release history
- [REVIEW.md](REVIEW.md) — implementation notes and roadmap (Chinese)
- [docs/RELEASE.md](docs/RELEASE.md) — code signing and release checklist (Chinese)
- [docs/LIBMPV-MIGRATION.md](docs/LIBMPV-MIGRATION.md) — plan for replacing the `--wid` child window with libmpv (Chinese)

## Known limitations

1. **The installer is unsigned** — SmartScreen warns on first run; click More info → Run anyway.
2. **The video surface is a native child window** — HTML can't be drawn on top of it, so the control bar sits below the video instead of floating over it.
3. **Scrubbing feel needs real-device tuning** — trackpad drivers differ widely.
4. **`-c copy` cuts snap to keyframes** — the cut point may be off by a few tenths of a second from your in/out. Re-encoding is frame-accurate, at the cost of a second compression pass.
5. **2x reverse is simulated** — mpv doesn't support negative playback speed.
6. **Undo covers marker/range edits only** — cutting and exporting are not undoable.
7. **EDL is non-drop-frame** — 29.97 footage is counted at a nominal 30fps, giving ~0.1% drift on long timelines.

## License

[MIT](LICENSE) © 2026 glowwan

## Credits

- [mpv](https://mpv.io/) — playback engine
- [FFmpeg](https://ffmpeg.org/) — cutting and encoding
- [Electron](https://www.electronjs.org/) — application shell
- Seek strategy and interaction patterns draw on [mpv's OSC](https://github.com/mpv-player/mpv) and [LosslessCut](https://github.com/mifi/lossless-cut)
