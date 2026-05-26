# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Maestro C3 is firmware for a single ESP32-C3 that turns a roomful of phones into
a **wireless orchestra**. Phones join an open WiFi soft-AP ("Maestro",
`192.168.4.1`); each phone becomes an *instrument*. One device claims `/admin`
and conducts: it picks one of 5 public-domain classical pieces and one of 4 game
modes. PlatformIO + Arduino framework; web UI served from a LittleFS partition.

It is a sibling of `../quizhub` and deliberately reuses its proven plumbing
(soft-AP + captive portal, the `/ws` broadcast-snapshot pattern, NVS profiles,
the admin-seat grace logic). If something here looks like QuizHub, it is — read
QuizHub's CLAUDE.md for the captive-portal war stories.

## Commands

```bash
pio run                  # compile firmware
pio run -t upload        # flash firmware over USB
pio run -t uploadfs      # upload data/ → LittleFS (HTML/CSS/JS/scores)
pio device monitor       # serial monitor @ 115200 (expect "AP up — IP 192.168.4.1")

# Regenerate the score JSON after editing the symbolic melodies:
cd data/scores && ./make-scores.py     # then `pio run -t uploadfs`
```

There is no test suite. After changing anything under `data/`, you must
`uploadfs` (not just `upload`). C++ changes need `upload`. No linter.
DevKitM reflash dance if upload fails: hold BOOT, tap RESET, release BOOT, retry.

## The big idea: audio is in the browser, not on the chip

The ESP32-C3 cannot synthesize and stream audio to 16 phones, so it doesn't try.
**Each phone synthesizes its own instrument** with the Web Audio API. To make a
tap sound instantly, every phone **precomputes one `AudioBuffer` per pitch** for
its instrument at launch (`data/js/instruments.js`, additive synthesis + ADSR)
and caches them; a tap then just fires a buffer source.

The chip's only jobs are: hold authoritative session state and broadcast it as a
snapshot, and own the **master transport clock** so all phones start together.
Sheet music is static JSON under `/scores/` — fetched over HTTP and cached per
browser — so it never travels over the WebSocket.

`instruments.js` does additive synthesis with quality touches (per-partial phase
accumulation for true vibrato, ensemble detune, breath noise, and partials above
Nyquist dropped to avoid aliasing). Notes are **loudness-equalized** — each is
normalized to a common RMS with a peak ceiling, so timbres match regardless of
envelope — and all playback routes through a shared limiter (`master()`), so the
organ can't saturate and stacked notes never clip. `play(..., durMs)` cuts a note
to its scored length with a short release.

### Clock sync (easy to get wrong)

The transport start time is expressed in the server's `millis()` clock. Each
client runs an NTP-style handshake (`tsync` in `data/js/common.js`): it sends its
clock, the server echoes back with its own, and the client keeps the offset from
the lowest-RTT probe. `conn.serverNow()` then returns estimated server-ms, and
`scorePos = serverNow() - transport.startAtMs` is the shared timeline position
(negative during the lead-in countdown). LAN RTT is sub-50 ms, well inside the
±500 ms (ALONG) / ±300 ms (DRIVEN) judging windows.

## Architecture

Everything runs on one chip (`src/main.cpp` `setup()`): soft-AP + wildcard
captive DNS on UDP/53 + mDNS (`maestro.local`) + `ESPAsyncWebServer` on :80 with
a single WebSocket at `/ws`. `loop()` pumps DNS, reaps sockets, and calls
`WsHub::tick()`.

It is a **broadcast-snapshot state machine** (same shape as QuizHub):
- `src/GameState` holds all authoritative state — the 16-slot musician table,
  the session `Mode` (LOBBY/FREE/ALONG/DRIVEN), the selected `scoreId`, the
  transport (`running`/`startAtMs`/`introMs`), and which clientId conducts.
  `g_game` is a global.
- On every state change the server broadcasts a full `state` JSON snapshot. The
  musician and conductor UIs are **pure projections** of the latest snapshot, so
  a hard refresh from any browser is always safe.
- `src/WsHub.cpp` parses incoming frames by their `t` discriminator, calls into
  `g_game`, then rebroadcasts. `src/WebRoutes.cpp` serves static files, the
  `/scores/*` tree, the filtered `/scores/manifest.json`, and the captive portal.
- `src/Persistence` wraps NVS: per-clientId profiles `{name,color,instrument}`.

`WebRoutes.cpp` ports QuizHub's current **CAPPORT (RFC 8908)** captive flow, kept
in sync with it. Per-IP state (`s_captive`) tracks `validated` + a one-time
`code`. While UNVALIDATED, every connectivity probe and off-host request 302s to
`/portal` (so the OS auto-pops its "Sign in" sheet showing a "Connected →
Continue" page with the coded `/?k=` link); opening the app URL `captiveValidate`s
the client, after which the same probes return the OS-expected "online" payload
and the sheet is dismissed. `/captive-api` exposes the same `captive` flag as
RFC 8908 JSON. If you change a probe/redirect rule, mirror it across `probeReply`
and the `onNotFound` off-host branch.

The high-frequency `play` and `tsync` messages are **edge events** that do NOT
trigger a full-state rebroadcast (the hot path stays tiny). Per-player hit/miss
counters in `state` therefore only refresh on structural changes; the conductor
UI tallies live from `note` events instead.

### The WebSocket protocol is a frozen contract

`src/WsHub.h` is the single source of truth for the `/ws` JSON protocol. It is
shared across three layers: the server FSM (`GameState`/`WsHub`), the musician UI
(`data/js/player.js`), and the conductor UI (`data/js/admin.js`). **Do not
rename or reshape a field in one layer without updating all three and the
comment block in `WsHub.h`.** Receivers must ignore unknown `t` values.

### The four modes

- **FREE ("Test Play")** — each musician picks an instrument (the list is derived
  from the selected score's voices) and taps a button to play a **random
  4th-octave** note. A sound-check / warm-up. Purely local; the server only fans
  out `note` events for the shared visualization.
- **FREEPLAY ("Free Play")** — a multi-touch falling-note *instrument*
  (`player.js` canvas, no score/transport). The lane is a row of labelled pitch
  columns (one chromatic octave, C4..B4). A pointer-down spawns a note in that
  column; the note's sounding duration tracks how long the touch is held;
  dragging to another column finalizes the current note and starts a new one.
  Each note falls over `FP_LEAD` (1.5 s) and **sounds when it crosses the gate**.
  Every pointer is tracked independently (`setPointerCapture`, `touch-action:
  none`), so multiple fingers play in parallel. Entirely client-side; broadcasts
  `note` events for the shared visualization.
- **ALONG** — the conductor assigns musicians to score voices and starts the
  transport. The conductor *device* plays the piece as an audible guide for
  `introMs` (10 s), then fades out (scheduled through a Web Audio fade bus in
  `admin.js`); musicians then carry it by tapping. A tap within ±500 ms of a
  scheduled note plays the **correct** pitch and length, else a random note. The
  conductor sees a live cue of who plays what ~1.5 s ahead.
- **DRIVEN** — per-musician falling notes (`player.js` canvas) descend a lane to
  a gate over a 3 s lookahead; a note's **horizontal position encodes its pitch**
  (the part's range mapped low→left / high→right), so the dots trace the melodic
  contour. Tapping within ±300 ms of the gate plays the correct pitch/length,
  else random. No audible guide (`introMs` = 0).

**Auto-play empty parts** (conductor toggle, `admin.js`, both timed modes): the
podium performs every voice with no assigned online musician — full piece,
correct pitch/length — through its own bus, so a small group can still cover a
multi-part score. It partitions cleanly with the ALONG lead-in guide (assigned
voices get the fading guide; empty voices get the full auto-fill).

Pieces loop to ≥60 s; the conductor presses Stop to end early. Per-musician
hit/miss counters in `state` only refresh on structural changes (the `play`
edge event is intentionally cheap), so the conductor UI tallies live from `note`
events.

### Identity model

Same as QuizHub: a stable `clientId` (server-issued `mz_id` cookie, falling back
to a localStorage UUID) keys NVS profiles and survives reloads; the per-socket
`wsClientId` changes on every reconnect and only addresses a single socket. The
conductor seat is claimed by the first `hello` with `role:"admin"`, and survives
a brief disconnect for `Config::ADMIN_GRACE_MS` (20 s).

### Concurrency

WS events run on the AsyncTCP task (pinned to core 0) while `WsHub::tick()` runs
on the Arduino loop task. Both mutate `g_game`, so every multi-field mutation is
guarded by `GameState::mux_` (a `portMUX_TYPE` spinlock). Keep critical sections
tiny — no JSON serialization or network calls while holding the lock.

## Gotchas

- **MIDI range 48..84 is a hard contract.** `data/js/instruments.js` precomputes
  exactly C3..C6, and `data/scores/make-scores.py` *asserts* every note falls in
  that range. If you add a score note outside it, the generator fails (good); if
  you change the range, change both files. Melodies sit in octaves 4–5, bass in
  3–4.
- **Scores are generated, not hand-written.** Edit the symbolic melodies in
  `data/scores/make-scores.py` and re-run it; never hand-edit the `*.json`. The
  notes are transcriptions of public-domain compositions.
- **Colour palette is duplicated in three places** — `--p1..--p16` in
  `data/css/style.css`, `PRESETS` in `data/js/player.js`, and `kPalette` in
  `src/GameState.cpp`. Change all three together.
- **Instrument ids are shared too** — the keys of `BANK` in
  `data/js/instruments.js` are what scores reference (`voice.instrument`) and
  what profiles persist. Adding an instrument is JS-only, but a score that names
  a missing instrument will fall back silently.
- **Precompute is memory-heavy.** ~37 buffers × ~1 s × the audio sample rate per
  instrument. The conductor precomputes *every* instrument in the score (for the
  ALONG guide); that's fine on a laptop, less so on a cheap phone — keep the bank
  small.
- **iOS/Chrome audio** stays suspended until a user gesture; the first tap on any
  page calls `Maestro.instruments.unlock()`.
- **NVS key limit (15 chars):** `clientId`s are hashed (FNV-1a → base16) into a
  short key in `Persistence.cpp`; fields are packed `\x1F`-delimited per key.
- **Partition layout** (`partitions.csv`): ~1.4 MB app, ~2.5 MB LittleFS on 4 MB
  flash. The LittleFS partition uses SubType `spiffs` but is mounted as LittleFS
  via `board_build.filesystem` — don't "fix" the SubType.
