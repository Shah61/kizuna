# 絆刃 · Kizuna Blade

A Demon Slayer–inspired rhythm game for macOS and Windows. Electron + React + Vite.

Four, six, or eight lanes, six breathing styles that each bend the rules, and a Corps rank
ladder from 癸 Mizunoto up to 柱 Hashira.

---

## Running it

```bash
npm install
npm run dev
```

`npm run dev` starts Vite on port 5273 and opens the Electron window against it.
`npm run dev:vite` alone is useful for UI work, but the Electron app is required
to scan and play the local music folder.

## Building installers

```bash
npm run dist:mac     # .dmg + .zip (arm64 + x64)
npm run dist:win     # NSIS installer + portable .exe (x64)
npm run dist:all     # both
```

Output lands in `release/`. The app icon is generated at `build/icon.png`;
electron-builder derives `.icns` and `.ico` from it automatically.

**Building the Windows target from macOS needs Wine** (`brew install --cask wine-stable`).
Without it, build the Windows installer on a Windows machine, or in CI.

Neither target is code-signed. macOS will show a Gatekeeper warning on first
launch — right-click the app and choose Open. To sign properly, add an Apple
Developer ID and set `CSC_LINK` / `CSC_KEY_PASSWORD`.

---

## Music library

The playable library comes exclusively from `.mp3` files in `content/music/`.
There are no synthesized built-in missions and no arbitrary file imports.

- The filename becomes the title shown in song select.
- Every MP3 is analysed for onsets, tempo, energy, and spectral centroid.
- Every difficulty and 4/6/8-lane layout is generated from the same analysis.
- The original MP3 is always the backing music. Hits add blade effects only;
  no synthesized piano melody is layered over the recording.
- Analysis is cached in the app settings and reused on later launches.
- Add or remove MP3 files in `content/music/`, then restart to refresh the list.

### What the analysis is and isn't good at

| | |
| --- | --- |
| Onset placement | Reliable. This is what the notes are built from. |
| Tempo | Good, but blind to octave — a 190 BPM track may read as 95. Cosmetic: it affects the displayed number and the background bar lines, not note placement. |
| Key | Approximate. Retained in cached analysis for future chart features; it does not add synthesized music. |

The `content/music/` folder is copied into packaged builds. Cached analysis,
settings, and scores live in the normal Electron userData folder.

---

## Controls

| Action | Default |
| --- | --- |
| Lanes 1–4 (default) | `D` `F` `J` `K` |
| Eight-lane preset | `A` `S` `D` `F` `G` `H` `J` `K` |
| Breathing Art | `Space` |
| Pause | `Esc` |
| Fullscreen | `F11` |

Settings → Input lets the player choose 4, 6, or 8 lanes, includes layouts for
each field size, and supports per-lane rebinding: click a lane, then press the
key you want. Sustained blades must be held to the tail; gold blades form
two- or three-key chords that land together.

**Calibrate before you play seriously.** Settings → Calibration runs a
metronome; tap `Space` on the beat about sixteen times and apply the measured
offset. The results screen also suggests one if your hits drift.

---

## How it works

```
src/
  audio/
    synth.ts       blade, UI, metronome, and result sound effects
    conductor.ts   song clock, lookahead scheduler, audio/video sync
    analyzer.ts    FFT → onsets → tempo → chart, for music-folder MP3s
    fft.ts         radix-2 FFT
    import.ts      folder scanning, decoding, and caching
  game/
    composer.ts    legacy generated-chart composer (not in the playable library)
    engine.ts      judgement, scoring, combo, gauge, ranks
    renderer.ts    the entire play field, drawn procedurally to canvas
    selection.ts   admits content/music tracks into the playable library
  screens/         title, menu, style select, song select, game, results,
                   settings, records
electron/
  main.js          window, IPC, settings persistence, audio file access
  preload.cjs      the renderer's entire privileged surface
```

Two design decisions worth knowing:

**The recording owns the timing.** Charts are derived from detected onsets in
the MP3. Holds and chord voices reuse those onset timestamps, and the Conductor
uses one audio clock for both playback and judgement.

**Judgement matches the earliest note in the window, not the nearest one.**
Nearest-note matching looks fine until a player drifts late in a sixteenth
stream, where the *next* note is closer than the one they are behind on — the
press steals it and the original is scored as a miss, cascading. Earliest-first
keeps late play merely late.

Nothing is loaded from disk at runtime except the selected music-folder MP3.
Mountains are seeded ridge noise, and the moon and fog are gradients.

---

## Breathing styles

| Style | Perk | Cost |
| --- | --- | --- |
| 水 Water | Timing windows +16ms | Score ×0.94 |
| 炎 Flame | Combo multiplier caps at ×6 | A miss resets it to ×1 |
| 雷 Thunder | Score ×1.18 | Scroll ×1.35, windows −6ms |
| 風 Wind | Gauge fills ×1.85 faster | Shorter Art duration |
| 岩 Stone | A miss-absorbing guard every 40 combo | Slower gauge, score ×0.97 |
| 霞 Mist | Score ×1.30 | Notes invisible for the top 42% of the lane |

Fill the 全集中 concentration gauge and press `Space` for a Breathing Art:
every judgement upgrades one tier and score doubles for 8.5 seconds.

---

## Changelog

### 0.4.0

* **Difficulty now controls how many tiles you get, not how fast they fall.**
  Scroll speed stays a separate setting. Measured across a six-track library:

  | | notes/sec | chord notes | peak/sec | max at once |
  | --- | --- | --- | --- | --- |
  | 癸 Novice | 1.33 | 0% | 4 | 1 |
  | 丙 Adept | 2.53 | 0% | 6 | 1 |
  | 甲 Elite | 5.31 | 48% | 12 | 2 |
  | 柱 Pillar | 9.5 | 74% | 22 | 3 |

* **Chords.** A single musical moment can now fire several lanes. When a kick,
  a snare and a cymbal land together, Pillar plays all three while Novice plays
  only the loudest — which is what actually puts both hands to work rather than
  just speeding the field up.
* **Fixed: every difficulty was receiving an identical chart.** An absolute
  strength floor was discarding 75% of a track's onsets *before* difficulty was
  considered, so all four charts drew from the same 456 of 1802 onsets and
  differed only in their spacing limits. The floor was calibrated against
  synthetic test audio, where strengths cluster high; on real music one loud
  transient sets the maximum and everything else falls beneath it. Density now
  spans 7.1x from Novice to Pillar.
* Detection loosened to supply enough material for the hardest charts, since
  the onset list is cached once per track and shared by all four difficulties.

Verified at 120fps with worst-frame 9.7ms on a Pillar chart.

#### Known limits

* Lane 1 carries ~40% of notes on a four-lane Pillar chart — the kick is
  genuinely the most frequent event in these tracks, so this is honest rather
  than broken, but it is not an even spread.

### 0.3.0

* **Hold notes show that they are held.** Previously the only cue was a
  slightly brighter fill, easy to miss while reading notes further up the
  field. A held tail now pulses, runs energy up the lane, streams sparks off
  the receptor, and carries a remaining-time arc. Completing one fires a ring
  burst; dropping one visibly frays.
* **Onset detection rebuilt** as multi-band SuperFlux. 24 log-spaced bands with
  a max-filtered reference frame, so vibrato no longer reads as a stream of
  false onsets, and quiet instruments are not buried under loud ones. Onsets
  are attributed to the band that actually produced them, so a kick lands in a
  bass lane and cymbals on the right. Timing resolution 5.8ms with parabolic
  peak interpolation, against a 46ms perfect window.
* **Grid snapping cut back.** Snapping detected onsets to an estimated beat
  grid measured *worse* than leaving them alone (17ms vs 8ms error) because the
  grid carries tempo error that accumulates. Notes now sit on the audio.
* **Key detection fixed.** Chroma was histogrammed from linearly-spaced FFT
  bins, which cannot resolve semitones in the low register — every track came
  back as the same key. Now sampled per semitone with interpolation.

Measured on a six-track library: 3.97 onsets/sec detected (previously ~2.4),
no track with an empty lane, and three distinct keys where it had reported one.

#### Known limits

* Band attribution is roughly 48% accurate against synthetic ground truth.
  Broadband percussion genuinely occupies every band, so some of this is a
  labelling question rather than an error, but it is not exact.
* On sparse material the highest difficulties still reach for weaker events to
  approach their density target. Dense mixes — most real music — are unaffected.
* Tempo remains blind to octave; a 190 BPM track may report as 95. Cosmetic,
  since notes come from onsets rather than the grid.

### 0.2.0

* **Piano engine.** Lead voice for the built-in songs — inharmonic partials,
  hammer strike notch, split decay, unison beating. Pre-rendered to wavetables
  at startup, so playback costs one node per note.
* **Import your own audio.** Onset detection, tempo estimation and automatic
  chart generation from any recording you point it at. All four difficulties
  generate from a single analysis.
* **Bundled music.** Anything in `content/music/` ships inside the installer
  and is imported on each player's first launch. Players can also drop files
  into their own music folder after install.
* **Keybind presets** — DFJK, SDKL, ASKL, ZXCV, arrows — plus per-lane rebinding.
* **Fixed: late hits cascaded into misses.** Note matching took the *nearest*
  note rather than the earliest one inside the window. In a sixteenth stream a
  consistently-late player would have the next note stolen by each press,
  scoring the intended one as a miss, over and over. Now matches earliest-first,
  and timing is symmetric in both directions.
* **Fixed: compositor tile memory exhaustion.** `disable-gpu-vsync` and
  `disable-frame-rate-limit` were making Chromium rasterise as fast as it could
  and flooding the log with "tile memory limits exceeded". Both removed —
  timing comes from the audio clock, so uncapping frame rate bought nothing.
  The full-screen grain, the title rays and the canvas backing store were all
  oversized too, and are now budgeted.
* Auto-pause when the window loses focus, so a background tab no longer returns
  you to a wall of misses.

### 0.1.0

First release. Six original songs, six breathing styles, procedural renderer.
