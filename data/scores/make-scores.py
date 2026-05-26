#!/usr/bin/env python3
"""Generate Maestro's score JSON from compact symbolic melodies.

Why this exists
---------------
The notes here are transcriptions of *public-domain compositions* (Beethoven,
Mozart, Bach, Pachelbel, Vivaldi — all long out of copyright), entered by hand
as simple note-name + beat-count sequences. This script turns them into the
timed JSON the firmware serves from LittleFS, so the absolute millisecond
timings are computed (never hand-typed) and stay consistent if you retune a
tempo. Run it from this directory:

    ./make-scores.py        # writes manifest.json + <id>.json here
    pio run -t uploadfs     # from the repo root, to push them to the device

Score JSON shape (one file per piece, fetched + cached by every browser):

    { "id","title","composer","tempo","lengthMs",
      "voices": [ { "id","name","instrument",
                    "notes": [ {"t":<ms>,"m":<midi>,"d":<ms>}, ... ] } ] }

A voice is one orchestral part. In FREE mode the musician picker offers the set
of distinct instruments across a score's voices; in ALONG / DRIVEN the conductor
assigns each musician to a voice and they play its notes on cue.

Constraint: every MIDI note MUST fall in 48..84 (C3..C6) — that is the range
each browser precomputes per instrument (see data/js/instruments.js). Melodies
sit in the 4th/5th octave, bass lines in the 3rd/4th.
"""

import json
import math
import os

# Every piece is looped up to at least this length so a single "Start" gives the
# orchestra a proper minute-plus to play, rather than a 15-second snippet.
TARGET_MS = 66000

# --- note-name -> MIDI ------------------------------------------------------
_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def m(name):
    """'C4' -> 60, 'F#5' -> 78, 'Bb3' -> 58. Middle C (C4) = MIDI 60."""
    note = name[0].upper()
    i = 1
    semi = _STEP[note]
    while i < len(name) and name[i] in "#b":
        semi += 1 if name[i] == "#" else -1
        i += 1
    octave = int(name[i:])
    midi = (octave + 1) * 12 + semi
    assert 48 <= midi <= 84, f"{name} -> {midi} out of precomputed range 48..84"
    return midi


# R is a rest (advances time, emits no note).
R = "R"


def voice(vid, name, instrument, tempo, seq, gap=0.06):
    """seq is a flat list alternating note(str)/duration(beats, float).

    e.g. ["E4",1, "E4",1, "F4",1, R,1]. `gap` trims each note slightly so
    repeated pitches re-articulate instead of merging.
    """
    beat_ms = 60000.0 / tempo
    notes = []
    t = 0.0
    for i in range(0, len(seq), 2):
        pitch = seq[i]
        beats = seq[i + 1]
        dur = beats * beat_ms
        if pitch != R:
            notes.append(
                {"t": round(t), "m": m(pitch), "d": round(max(80, dur * (1 - gap)))}
            )
        t += dur
    return {"id": vid, "name": name, "instrument": instrument, "notes": notes}, round(t)


def beats(seq):
    """Total beats of a flat note/duration sequence."""
    return sum(seq[1::2])


def drone(vid, name, instrument, tempo, roots, total_beats, beat_per=2.0):
    """A bass/accompaniment voice that cycles `roots`, each `beat_per` beats,
    filling exactly `total_beats` — so it stays length-aligned with the melody
    it accompanies (the looper repeats every voice over a common period)."""
    seq, t, i = [], 0.0, 0
    while t < total_beats - 1e-6:
        d = min(beat_per, total_beats - t)
        seq += [roots[i % len(roots)], d]
        t += d; i += 1
    return voice(vid, name, instrument, tempo, seq)


def write(score):
    fn = score["id"] + ".json"
    with open(fn, "w") as f:
        json.dump(score, f, separators=(",", ":"))
    print(f"  wrote {fn}  ({len(json.dumps(score))} bytes, "
          f"{sum(len(v['notes']) for v in score['voices'])} notes)")


def build(meta, tempo, voices, target_ms=TARGET_MS):
    """Loop every voice over a common period until the piece reaches target_ms.

    The loop period P is the longest single-pass voice length, so all voices stay
    phase-aligned across repeats (a shorter voice simply rests out the remainder
    of each pass). lengthMs is the looped total.
    """
    period = max(L for (_, L) in voices)
    repeats = max(1, math.ceil(target_ms / period))
    out_voices = []
    for (v, _L) in voices:
        notes = []
        for r in range(repeats):
            off = r * period
            for n in v["notes"]:
                notes.append({"t": n["t"] + off, "m": n["m"], "d": n["d"]})
        out_voices.append({"id": v["id"], "name": v["name"], "instrument": v["instrument"], "notes": notes})
    score = dict(meta)
    score["tempo"] = tempo
    score["lengthMs"] = repeats * period
    score["voices"] = out_voices
    return score


scores = []

# ============================================================================
# 1. Beethoven — Ode to Joy (Symphony No. 9), C major, simplified.
# ============================================================================
T = 120
mel = voice("melody", "Melody", "piano", T, [
    "E4",1,"E4",1,"F4",1,"G4",1, "G4",1,"F4",1,"E4",1,"D4",1,
    "C4",1,"C4",1,"D4",1,"E4",1, "E4",1.5,"D4",0.5,"D4",2,
    "E4",1,"E4",1,"F4",1,"G4",1, "G4",1,"F4",1,"E4",1,"D4",1,
    "C4",1,"C4",1,"D4",1,"E4",1, "D4",1.5,"C4",0.5,"C4",2,
])
bass = voice("bass", "Bass", "strings", T, [
    "C3",2,"C3",2, "G3",2,"C3",2, "C3",2,"G3",2, "C3",2,"G3",2,
    "C3",2,"C3",2, "G3",2,"C3",2, "C3",2,"G3",2, "G3",2,"C3",2,
])
harm = voice("harmony", "Harmony", "bells", T, [
    R,4, "C5",2,"E5",2, R,4, "G5",2,"E5",2,
    R,4, "C5",2,"E5",2, R,4, "E5",2,"C5",2,
])
scores.append(build(
    {"id": "ode-to-joy", "title": "Ode to Joy", "composer": "Beethoven"},
    T, [mel, bass, harm]))

# ============================================================================
# 2. Mozart — Eine kleine Nachtmusik (1st mvt opening), G major.
# ============================================================================
T = 132
mel = voice("melody", "Melody", "strings", T, [
    "G4",0.5,"D4",0.5,"G4",0.5,"D4",0.5,"G4",0.5,"D4",0.5,"G4",1,
    "B4",0.5,"A4",0.5,"G4",1, R,1,
    "D5",0.5,"A4",0.5,"D5",0.5,"A4",0.5,"D5",0.5,"A4",0.5,"D5",1,
    "F#5",0.5,"E5",0.5,"D5",1, R,1,
])
bass = voice("bass", "Bass", "harp", T, [
    "G3",1,"G3",1,"D3",1,"D3",1, "G3",1,"B3",1,"G3",1,R,1,
    "D3",1,"D3",1,"A3",1,"A3",1, "D3",1,"F#3",1,"D3",1,R,1,
])
deco = voice("sparkle", "Sparkle", "flute", T, [
    R,4, "G5",0.5,"A5",0.5,"B5",1,R,1,
    R,4, "D5",0.5,"E5",0.5,"F#5",1,R,1,
])
scores.append(build(
    {"id": "nachtmusik", "title": "Eine kleine Nachtmusik", "composer": "Mozart"},
    T, [mel, bass, deco]))

# ============================================================================
# 3. Bach — Minuet in G (Petzold, Anh. 114), G major.
# ============================================================================
T = 120
mel = voice("melody", "Melody", "harp", T, [
    "D5",1,"G4",0.5,"A4",0.5,"B4",0.5,"C5",0.5,
    "D5",1,"G4",1,"G4",1,
    "E5",1,"C5",0.5,"D5",0.5,"E5",0.5,"F#5",0.5,
    "G5",1,"G4",1,"G4",1,
    "C5",1,"D5",0.5,"C5",0.5,"B4",0.5,"A4",0.5,
    "B4",1,"C5",0.5,"B4",0.5,"A4",0.5,"G4",0.5,
    "F#4",1,"G4",0.5,"A4",0.5,"B4",0.5,"G4",0.5,
    "A4",2,R,1,
])
bass = voice("bass", "Bass", "organ", T, [
    "G3",1,"B3",1,"A3",1, "B3",1,"G3",1,"B3",1,
    "C4",1,"E3",1,"G3",1, "B3",1,"G3",1,"D3",1,
    "C4",1,"B3",1,"A3",1, "G3",1,"E3",1,"D3",1,
    "D3",1,"D3",1,"D3",1, "G3",2,R,1,
])
scores.append(build(
    {"id": "minuet-in-g", "title": "Minuet in G", "composer": "Bach (Petzold)"},
    T, [mel, bass]))

# ============================================================================
# 4. Pachelbel — Canon in D (the famous ground + a melodic line). D major.
# ============================================================================
T = 100
bass = voice("ground", "Ground Bass", "strings", T, [
    "D3",1,"A3",1,"B3",1,"F#3",1, "G3",1,"D3",1,"G3",1,"A3",1,
    "D3",1,"A3",1,"B3",1,"F#3",1, "G3",1,"D3",1,"G3",1,"A3",1,
])
mel = voice("melody", "Melody", "flute", T, [
    "F#5",2,"E5",2, "D5",2,"C#5",2, "B4",2,"A4",2, "B4",2,"C#5",2,
    "D5",2,"C#5",2, "B4",2,"A4",2, "G4",2,"F#4",2, "G4",2,"E4",2,
])
counter = voice("counter", "Counter", "bells", T, [
    "D5",1,"F#5",1,"A5",1,"G5",1, "F#5",1,"D5",1,"D5",1,"C#5",1,
    "D5",1,"C#5",1,"D5",1,"A4",1, "B4",1,"A4",1,"B4",1,"C#5",1,
])
scores.append(build(
    {"id": "canon-in-d", "title": "Canon in D", "composer": "Pachelbel"},
    T, [mel, bass, counter]))

# ============================================================================
# 5. Vivaldi — Spring (La Primavera, 1st mvt main theme). E major -> simplified.
# ============================================================================
T = 110
mel = voice("melody", "Melody", "strings", T, [
    "E5",0.5,"E5",0.5,"E5",1, "E5",0.5,"E5",0.5,"E5",1,
    "E5",0.5,"G#5",0.5,"B5",1, "A5",0.5,"G#5",0.5,"A5",1,
    "B5",0.5,"B5",0.5,"B5",1, "B5",0.5,"B5",0.5,"B5",1,
    "B5",0.5,"A5",0.5,"G#5",1, "A5",0.5,"G#5",0.5,"E5",1,
])
bass = voice("bass", "Bass", "harp", T, [
    "E3",2,"E3",2, "E3",2,"B3",2, "E3",2,"E3",2, "B3",2,"E3",2,
    "G#3",2,"G#3",2, "B3",2,"B3",2, "E3",2,"B3",2, "E3",2,"E3",2,
])
birds = voice("birds", "Birdsong", "flute", T, [
    R,4, "E5",0.25,"F#5",0.25,"E5",0.25,"F#5",0.25,"E5",1,R,1,
    R,4, "B5",0.25,"A5",0.25,"B5",0.25,"A5",0.25,"G#5",1,R,1,
])
scores.append(build(
    {"id": "spring", "title": "Spring (La Primavera)", "composer": "Vivaldi"},
    T, [mel, bass, birds]))

# ============================================================================
# 6. Beethoven — Für Elise (opening), A minor. Bass auto-aligned via drone().
# ============================================================================
T = 120
fe = [
    "E5",0.5,"D#5",0.5,"E5",0.5,"D#5",0.5,"E5",0.5,"B4",0.5,"D5",0.5,"C5",0.5,
    "A4",1, R,0.5, "C4",0.5,"E4",0.5,"A4",0.5, "B4",1, R,0.5,
    "E4",0.5,"G#4",0.5,"B4",0.5, "C5",1, R,0.5, "E4",0.5,
    "E5",0.5,"D#5",0.5,"E5",0.5,"D#5",0.5,"E5",0.5,"B4",0.5,"D5",0.5,"C5",0.5,
    "A4",1, R,0.5, "C4",0.5,"E4",0.5,"A4",0.5, "B4",1, R,0.5,
    "E4",0.5,"C5",0.5,"B4",0.5, "A4",1.5, R,0.5,
]
mel = voice("melody", "Melody", "piano", T, fe)
bass = drone("bass", "Bass", "harp", T, ["A3", "E3", "A3", "E3"], beats(fe), 2.0)
scores.append(build(
    {"id": "fur-elise", "title": "Für Elise", "composer": "Beethoven"},
    T, [mel, bass]))

# ============================================================================
# 7. Grieg — In the Hall of the Mountain King, creeping theme.
# ============================================================================
T = 120
hm = [
    "E4",0.5,"F#4",0.5,"G4",0.5,"A4",0.5,"G4",0.5,"B4",0.5,"A4",1,
    "E4",0.5,"F#4",0.5,"G4",0.5,"A4",0.5,"G4",0.5,"B4",0.5,"A4",1,
    "B4",0.5,"C5",0.5,"D5",0.5,"E5",0.5,"D5",0.5,"F5",0.5,"E5",1,
    "B4",0.5,"C5",0.5,"D5",0.5,"E5",0.5,"D5",0.5,"F5",0.5,"E5",1,
]
mel = voice("melody", "Melody", "marimba", T, hm)
bass = drone("bass", "Bass", "organ", T, ["E3", "E3", "B3", "B3"], beats(hm), 2.0)
scores.append(build(
    {"id": "mountain-king", "title": "In the Hall of the Mountain King", "composer": "Grieg"},
    T, [mel, bass]))

# ============================================================================
# 8. Rossini — William Tell Overture (finale gallop).
# ============================================================================
T = 132
wt = [
    "E4",0.5,"E4",0.5,"E4",1, "E4",0.5,"E4",0.5,"E4",1,
    "E4",0.5,"E4",0.5,"A4",0.5,"A4",0.5, "B4",0.5,"B4",0.5,"E5",1,
    "E4",0.5,"E4",0.5,"E4",1, "E4",0.5,"E4",0.5,"E4",1,
    "E4",0.5,"A4",0.5,"B4",0.5,"C5",0.5, "B4",0.5,"A4",0.5,"E4",1,
]
mel = voice("melody", "Melody", "guitar", T, wt)
bass = drone("bass", "Bass", "strings", T, ["A3", "A3", "E3", "E3"], beats(wt), 2.0)
scores.append(build(
    {"id": "william-tell", "title": "William Tell (Finale)", "composer": "Rossini"},
    T, [mel, bass]))

# ============================================================================
# 9. Brahms — Lullaby (Wiegenlied), gentle.
# ============================================================================
T = 96
bl = [
    "E4",0.5,"E4",0.5,"G4",1, "E4",0.5,"E4",0.5,"G4",1,
    "E4",0.5,"G4",0.5,"C5",1,"B4",0.5,"A4",0.5,"G4",1,
    "D4",0.5,"D4",0.5,"E4",0.5,"F4",0.5,"G4",1, R,1,
    "D4",0.5,"D4",0.5,"E4",0.5,"F4",0.5,"G4",1, R,1,
]
mel = voice("melody", "Melody", "flute", T, bl)
bass = drone("bass", "Bass", "harp", T, ["C3", "G3", "C3", "G3"], beats(bl), 2.0)
scores.append(build(
    {"id": "brahms-lullaby", "title": "Brahms' Lullaby", "composer": "Brahms"},
    T, [mel, bass]))

# ============================================================================
# 10. Tchaikovsky — Swan Lake (theme), B minor.
# ============================================================================
T = 100
sl = [
    "B4",1.5,"F#5",0.5,"E5",0.5,"D5",0.5,"C#5",0.5,"B4",0.5,
    "C#5",1,"D5",1, "C#5",1,"B4",1,
    "B4",1.5,"F#5",0.5,"E5",0.5,"D5",0.5,"C#5",0.5,"B4",0.5,
    "C#5",1,"A#4",1, "B4",2,
]
mel = voice("melody", "Melody", "strings", T, sl)
bass = drone("bass", "Bass", "organ", T, ["B3", "F#3", "B3", "F#3"], beats(sl), 2.0)
scores.append(build(
    {"id": "swan-lake", "title": "Swan Lake (Theme)", "composer": "Tchaikovsky"},
    T, [mel, bass]))

# ============================================================================
# Emit files + manifest.
# ============================================================================
print("Generating scores…")
manifest = []
for s in scores:
    write(s)
    manifest.append({
        "id": s["id"], "title": s["title"], "composer": s["composer"],
        "file": s["id"] + ".json",
        "parts": len(s["voices"]),          # number of instrument voices (musicians)
    })

with open("manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
print(f"  wrote manifest.json ({len(manifest)} scores)")
print("Done. Now run:  pio run -t uploadfs")
