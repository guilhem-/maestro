# Maestro C3

Maestro C3 turns a $5 ESP32-C3 and a roomful of phones into a **wireless
orchestra**. Plug in, everyone joins the Wi-Fi, and each phone becomes a musical
instrument. One person conducts from a laptop or tablet: they pick a classic
piece and a game mode, and the room plays it together. No app store, no cloud, no
sheet music to read.

It's a musical sibling of [QuizHub C3](../quizhub) — same one-chip,
phones-as-clients design, but the phones make music instead of buzzing.

## How it sounds

Each phone **synthesizes its own instrument in the browser** (Web Audio) — piano,
strings, flute, bells, harp, organ, marimba or guitar. There are no audio files
anywhere; every note is generated from scratch (additive synthesis with proper
envelopes, vibrato, ensemble detune for the bowed timbres, breath noise for the
flute, and anti-aliased high notes), so the whole project is copyright-clean and
tiny. At launch each phone spends a second "tuning" — pre-rendering every note of
its instrument so taps play with zero latency.

Every instrument is **loudness-matched** (each note normalized to a common
perceived level) and the whole output runs through a limiter, so no single timbre
saturates the speakers and stacked notes never clip. A correctly-played note also
sounds for its **scored length**, so quarter notes are crisper than half notes.

## The five modes

| Mode | What musicians do | Pitch is correct when… |
|------|-------------------|------------------------|
| 🎶 **Free Play** | A multi-touch instrument: a zone of labelled pitch columns (A–G with sharps). Touch a column to start a note; **how long you hold sets its length**; slide to another column to start a new note. Notes fall and **sound as they cross the gate**. Several fingers ⇒ chords. | you pick the notes — there's no "wrong" |
| 🎲 **Test Play** | Pick an instrument and tap a button — a sound check / warm-up | always random (4th octave) |
| 🎺 **Play Along** | The conductor's device plays the tune for 10 s, then fades; musicians keep it going by ear while the conductor directs | you tap within **±0.5 s** of your note |
| 🎯 **Follow Notes** | Notes fall down a lane toward a gate; **horizontal position shows pitch** (low ← → high), so the falling dots trace the melody; tap as each one lands | you tap within **±0.3 s** of the gate |
| 🎧 **Listen Only** | Nobody taps — the piece plays itself. The conductor picks **Play on Master** (everything plays on the podium device) or **Play on Players** (each phone auto-plays its assigned part). | n/a — automatic playback |

When you're off the beat, a random note plays instead — so the orchestra always
*sounds* like an orchestra, it just gets gloriously better as everyone locks in.

Each piece loops to **at least a minute** of music, so one "Start" gives the room
a proper performance rather than a snippet.

## The 10 pieces

All public-domain compositions, transcribed as simple melodies and looped to at
least a minute:

- **Ode to Joy** — Beethoven
- **Eine kleine Nachtmusik** — Mozart
- **Minuet in G** — Bach (Petzold)
- **Canon in D** — Pachelbel
- **Spring (La Primavera)** — Vivaldi
- **Für Elise** — Beethoven
- **In the Hall of the Mountain King** — Grieg
- **William Tell (Finale)** — Rossini
- **Brahms' Lullaby** — Brahms
- **Swan Lake (Theme)** — Tchaikovsky

Each piece has 2–3 *voices* (e.g. melody, bass, sparkle); the podium shows how
many parts each piece has so you can match it to your group size. In the timed
modes the conductor assigns each musician a voice; in Test Play the instrument
list is drawn from the selected piece's voices.

## Hardware

- An **ESP32-C3** board — tested on **ESP32-C3-DevKitM-1** and
  **Seeed XIAO ESP32-C3**.
- A USB-C cable for power (any 5 V source — a battery pack is fine).
- A second device for the conductor (laptop/tablet/spare phone). In *Play Along*
  the conductor's device plays the guide track, so one with decent speakers is
  nicest.

No GPIO, no wiring, no soldering. Just the dev board on USB power.

## Quick start

1. Install [PlatformIO](https://platformio.org/install).
2. Flash the firmware:

       pio run -t upload

3. Upload the web assets + scores to LittleFS:

       pio run -t uploadfs

Open a serial monitor to confirm the AP came up:

    pio device monitor      # expect: AP "Maestro" up at 192.168.4.1

## Playing

1. On every phone, join the open Wi-Fi network **Maestro**. The captive-portal
   sheet pops up by itself showing a **"Connected → Continue to Maestro"** page;
   tap **Continue** to open the musician UI in a real browser (this also
   dismisses the captive sheet so your phone stops nagging about "no Internet").
   If it doesn't appear, visit <http://192.168.4.1/> (or <http://maestro.local/>
   on a computer).
2. Each musician types a name and picks a colour.
3. One device opens <http://192.168.4.1/admin> — **the first browser to claim it
   becomes the conductor**; everyone else stays a musician. While no conductor is
   active, every musician sees a pulsing **"🎩 Become the conductor"** button and
   can claim the podium with one tap. The conductor can hand off at any time by
   tapping **🚪 Step down as conductor** on their own card in the orchestra grid
   (they drop back to a musician and the seat reopens immediately). If the
   conductor just closes the tab, the seat is held ~20 s (so a reload keeps it)
   and then offered to everyone again.
4. On the podium: **① choose a piece → ② choose a mode**.
   - *Free Play*: a multi-touch falling-note instrument — musicians play
     immediately, no assignment needed.
   - *Test Play*: musicians pick an instrument and tap to sound-check.
   - *Play Along* / *Follow Notes*: **③ assign parts** (tap **Auto-assign** or
     use each musician's voice dropdown), then press **▶ Start**. A 3-2-1
     countdown gets the whole room going together, and the piece ends on every
     device at the same moment.
   - *Listen Only*: assign parts (optional), then **🔊 Play on Master** (hear the
     whole piece from the podium) or **📱 Play on Players** (each phone plays its
     assigned part in sync).
5. In *Play Along*, watch the **Conductor cue** — it shows who plays what about
   1.5 seconds ahead so you can point at the right musician on the beat.
6. Short on musicians? Tick **🎹 Auto-play empty parts** in the transport bar:
   the podium itself plays — correctly, for the whole piece — every voice that
   has no musician assigned, so a duo can still perform a three-part piece.

## Adding or editing pieces

Scores live as JSON under `data/scores/`, but you don't edit those by hand — they
are generated from compact symbolic melodies in `data/scores/make-scores.py`
(note names + beat counts). To change a tune or add a new one:

```bash
cd data/scores
$EDITOR make-scores.py      # add/adjust a build(...) block
./make-scores.py            # regenerate manifest.json + the *.json files
pio run -t uploadfs         # from the repo root, push to the device
```

Every MIDI note must fall in **C3..C6** (the range each phone precomputes); the
generator asserts this for you. Instrument names must match the bank in
`data/js/instruments.js`.

## Adding instruments

Instruments are pure synthesis recipes (harmonic partials + an envelope) in the
`BANK` object at the top of `data/js/instruments.js`. Add an entry, give it an id
and an emoji icon, re-run `pio run -t uploadfs`. Reference the new id from a
score voice (or just pick it in Free Play). Keep the bank small — every phone
pre-renders the whole note range for its instrument at launch.

## Customizing colours

The theme lives in CSS custom properties at the top of `data/css/style.css`
(`--accent`, `--accent2`, and the 16 musician swatches `--p1..--p16`). If you
change the 16 swatches you must also update `PRESETS` in `data/js/player.js` and
`kPalette` in `src/GameState.cpp` (they must stay identical and in the same
order).

## Troubleshooting

- **A phone is silent.** Web browsers block audio until you interact with the
  page — the first tap unlocks it. Also wait for the one-time "Tuning…" bar to
  finish.
- **Everyone starts slightly out of sync.** The phones sync their clocks to the
  ESP over the WebSocket; give them a few seconds after joining before starting,
  and keep the AP uncongested. The judging windows (±0.3–0.5 s) absorb normal
  LAN jitter.
- **The captive sheet keeps reopening / "no Internet" warnings.** The portal
  releases a phone only once it has *opened the app* (tap **Continue**, or load
  192.168.4.1). After that its connectivity probes are answered "online" for the
  session. If a phone never opens the app it stays captive by design.
- **iOS can't resolve `maestro.local`.** Some Android/iOS builds strip mDNS — use
  <http://192.168.4.1/> directly.
- **More than 16 phones join.** The 17th onward associate to the AP but the hub
  rejects their `hello` ("orchestra is full"). Remove a musician from the podium
  to free a slot.
- **Reflash trouble.** On the DevKitM: hold BOOT, tap RESET, release BOOT, then
  re-run `pio run -t upload`.

## Architecture

    +------------------------------------------------+
    |          ESP32-C3 (single device)              |
    |  Soft-AP "Maestro" @ 192.168.4.1               |
    |  + captive DNS (53) + mDNS (maestro.local)     |
    |  + ESPAsyncWebServer (static + /scores + /ws)  |
    |  + GameState (mode, score, TRANSPORT clock)    |
    |  + LittleFS (HTML/CSS/JS/scores) + NVS         |
    +------------------------------------------------+
        ^         ^          ^            ^
      phone     phone      phone     laptop (conductor)
     🎻 synth  🎹 synth   🪈 synth    🎺 guide + cue

The chip is a thin coordinator: it broadcasts authoritative state snapshots over
one WebSocket and owns the master transport clock. **All audio is synthesized in
the browsers** — each phone pre-renders its instrument's notes at launch and
plays them locally, judged against a clock all phones sync to the ESP. See
`CLAUDE.md` and `src/WsHub.h` for the full design and the frozen `/ws` protocol.

## Inspired by

The one-chip, phones-as-clients, "first the host picks, then everyone plays"
shape comes straight from [QuizHub C3](../quizhub). Maestro keeps the plumbing
and swaps the buzzer for an instrument.

## License

MIT. All sounds are synthesized at runtime (no audio assets ship), and the five
scores are transcriptions of public-domain classical compositions, so the
repository carries no third-party media.
