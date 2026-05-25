// Maestro C3 — in-browser instrument synthesizer.
//
// Each phone IS an instrument. The ESP32 can't stream audio to 16 phones, so
// every note is synthesized locally with the Web Audio API. To make playback
// instant (zero render latency on a tap or gate-hit), we PRECOMPUTE one
// AudioBuffer per pitch for the chosen instrument at launch and cache them; a
// tap then just fires an AudioBufferSourceNode.
//
// Synthesis is additive (a sum of sine partials) with a per-instrument envelope,
// plus quality touches: anti-aliasing (partials above Nyquist are dropped so
// high notes stay clean), true vibrato via a per-partial phase accumulator,
// ensemble detune (a chorus shimmer for bowed/organ timbres), and breath noise
// for the flute. No samples, no external assets — copyright-clean and tiny.
//
// LOUDNESS: every note is normalized to a common RMS (perceived loudness) with a
// peak ceiling, so instruments are level-matched regardless of timbre — a
// sustained organ no longer dwarfs a plucked harp. Everything then routes
// through a shared limiter (master bus) so stacked notes never clip the output.
//
// No modules / no build step (older Android WebViews on the captive AP).
// Everything hangs off window.Maestro.instruments.
(function () {
  'use strict';

  // Precomputed pitch range: C3..C6. MUST contain every MIDI note used by any
  // score voice (data/scores/make-scores.py asserts the same range) and the
  // 4th-octave random pool (60..71).
  var RANGE_LO = 48, RANGE_HI = 84;
  var NOTE_SECONDS = 1.4;     // baked buffer length per note

  // Loudness targets (applied per note). RMS match equalizes perceived volume;
  // the peak ceiling keeps punchy plucks from clipping.
  var TARGET_RMS = 0.115;
  var PEAK_CEIL  = 0.9;

  // ---- Instrument bank ------------------------------------------------------
  // partials : relative amplitudes of harmonics 1,2,3,… (fundamental first).
  // inharm   : stretches upper partials (bell shimmer); 0 = perfectly harmonic.
  // pluck    : percussive — exponential decay at `decayRate` (1/e per second),
  //            ignores ADSR. twoStage adds a longer tail for a natural ring.
  // a,d,s,r  : sustained ADSR (seconds; s is the 0..1 sustain level).
  // vib      : vibrato {rate Hz, depth fractional pitch}.
  // ensemble : cent offsets of stacked detuned copies (chorus); default [0].
  // noise    : breath/air amount mixed in and shaped by the envelope.
  var BANK = {
    piano:   { label: 'Piano',   icon: '🎹', partials: [1, 0.55, 0.30, 0.16, 0.09, 0.05], inharm: 0.0002, pluck: true, decayRate: 3.0, twoStage: true },
    strings: { label: 'Strings', icon: '🎻', partials: [1, 0.7, 0.55, 0.42, 0.30, 0.22, 0.15, 0.10], a: 0.09, d: 0.10, s: 0.8, r: 0.30, vib: { rate: 5.5, depth: 0.005 }, ensemble: [-6, 6] },
    flute:   { label: 'Flute',   icon: '🪈', partials: [1, 0.16, 0.06, 0.02], a: 0.05, d: 0.06, s: 0.9, r: 0.18, vib: { rate: 5.0, depth: 0.005 }, noise: 0.05 },
    bells:   { label: 'Bells',   icon: '🔔', partials: [1, 0, 0.6, 0, 0.42, 0, 0.28, 0, 0.18], inharm: 0.0012, pluck: true, decayRate: 1.5, twoStage: true },
    harp:    { label: 'Harp',    icon: '🪕', partials: [1, 0.5, 0.30, 0.17, 0.09, 0.05], inharm: 0.0003, pluck: true, decayRate: 3.8, twoStage: true },
    organ:   { label: 'Organ',   icon: '🎛️', partials: [1, 0.5, 0.8, 0.25, 0.5, 0.15, 0.2], a: 0.02, d: 0.03, s: 1.0, r: 0.07, ensemble: [-4, 4] },
    marimba: { label: 'Marimba', icon: '🪵', partials: [1, 0, 0, 0.4, 0, 0, 0.2], inharm: 0.0006, pluck: true, decayRate: 6.0 },
    guitar:  { label: 'Guitar',  icon: '🎸', partials: [1, 0.6, 0.45, 0.28, 0.18, 0.10, 0.06], inharm: 0.0004, pluck: true, decayRate: 3.6, twoStage: true }
  };

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function noteName(m) {
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  // ---- Shared AudioContext + master limiter ---------------------------------
  var ctx = null;
  function audioCtx() {
    if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; ctx = new AC(); }
    return ctx;
  }

  // All playback routes through one gain → compressor (limiter) → output, so a
  // chord of stacked notes (e.g. the conductor's guide) can never clip.
  var masterIn = null;
  function master() {
    if (!masterIn) {
      var c = audioCtx();
      masterIn = c.createGain();
      masterIn.gain.value = 0.9;
      var comp = c.createDynamicsCompressor();
      try {
        comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 12;
        comp.attack.value = 0.003; comp.release.value = 0.25;
      } catch (e) {}
      masterIn.connect(comp);
      comp.connect(c.destination);
    }
    return masterIn;
  }

  // iOS/Safari & Chrome autoplay: the context starts suspended until a gesture.
  var unlocked = false;
  function unlock() {
    var c = audioCtx();
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    if (unlocked) return;
    unlocked = true;
    try {
      var b = c.createBuffer(1, 1, c.sampleRate);
      var s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) {}
  }

  // ---- Envelope -------------------------------------------------------------
  function fillEnvelope(env, spec, sr, len) {
    var dur = NOTE_SECONDS;
    if (spec.pluck) {
      var dr = spec.decayRate;
      for (var n = 0; n < len; n++) {
        var t = n / sr, e;
        if (spec.twoStage) e = 0.72 * Math.exp(-dr * t) + 0.28 * Math.exp(-dr * 0.32 * t);
        else e = Math.exp(-dr * t);
        if (t < 0.004) e *= t / 0.004;        // tiny attack to avoid a click
        env[n] = e;
      }
    } else {
      var a = spec.a, d = spec.d, s = spec.s, r = spec.r, relStart = dur - r;
      for (var m = 0; m < len; m++) {
        var tt = m / sr, ev;
        if (tt < a)            ev = tt / a;
        else if (tt < a + d)   ev = 1 - (1 - s) * ((tt - a) / d);
        else if (tt < relStart) ev = s;
        else                   ev = s * Math.max(0, (dur - tt) / r);
        env[m] = ev;
      }
    }
  }

  // ---- Note rendering -------------------------------------------------------
  function renderNote(c, spec, freq) {
    var sr = c.sampleRate;
    var len = Math.floor(sr * NOTE_SECONDS);
    var buf = c.createBuffer(1, len, sr);
    var data = buf.getChannelData(0);

    var partials = spec.partials, np = partials.length;
    var inh = spec.inharm || 0;
    var twoPi = 2 * Math.PI;
    var nyq = 0.46 * sr;                   // anti-alias guard
    var ensemble = spec.ensemble || [0], ne = ensemble.length;
    var vib = spec.vib;

    var env = new Float32Array(len);
    fillEnvelope(env, spec, sr, len);

    // Tonal content: sum each detuned ensemble copy, integrating phase per
    // partial so vibrato is a true frequency modulation (no aliasing artifacts).
    for (var e = 0; e < ne; e++) {
      var ratio = Math.pow(2, ensemble[e] / 1200);
      var pf = new Float64Array(np);
      var phase = new Float64Array(np);
      for (var k = 0; k < np; k++) pf[k] = freq * ratio * (k + 1) * (1 + inh * k * k);
      for (var n = 0; n < len; n++) {
        var vfac = vib ? (1 + vib.depth * Math.sin(twoPi * vib.rate * (n / sr))) : 1;
        var smp = 0;
        for (var j = 0; j < np; j++) {
          var amp = partials[j];
          if (amp === 0 || pf[j] >= nyq) continue;
          phase[j] += twoPi * pf[j] * vfac / sr;
          smp += amp * Math.sin(phase[j]);
        }
        data[n] += smp;
      }
    }
    if (ne > 1) { for (var q = 0; q < len; q++) data[q] /= ne; }

    // Apply the envelope once, mixing in enveloped breath noise if any.
    var noiseAmt = spec.noise || 0, last = 0;
    for (var i = 0; i < len; i++) {
      var nz = 0;
      if (noiseAmt) { last = 0.96 * last + 0.04 * (Math.random() * 2 - 1); nz = noiseAmt * last; }
      data[i] = (data[i] + nz) * env[i];
    }

    // Loudness normalization: match RMS across instruments, cap the peak.
    var peak = 0, sumsq = 0;
    for (var p = 0; p < len; p++) { var v = data[p], av = v < 0 ? -v : v; if (av > peak) peak = av; sumsq += v * v; }
    var rms = Math.sqrt(sumsq / len) || 1e-9;
    var gain = Math.min(TARGET_RMS / rms, PEAK_CEIL / (peak || 1e-9));
    for (var w = 0; w < len; w++) data[w] *= gain;
    return buf;
  }

  // ---- Precompute cache -----------------------------------------------------
  var cache = {};      // instrId -> { ready, notes: { midi -> AudioBuffer } }
  var building = {};

  function precompute(instrId, onProgress) {
    var spec = BANK[instrId] || BANK.piano;
    var c = audioCtx();
    if (cache[instrId] && cache[instrId].ready) { if (onProgress) onProgress(1, 1); return Promise.resolve(); }
    if (building[instrId]) return building[instrId];

    var notes = {};
    cache[instrId] = { ready: false, notes: notes };
    var total = RANGE_HI - RANGE_LO + 1, i = 0;

    var p = new Promise(function (resolve) {
      function step() {
        var batch = 3;
        while (batch-- > 0 && i < total) { var midi = RANGE_LO + i; notes[midi] = renderNote(c, spec, midiToFreq(midi)); i++; }
        if (onProgress) onProgress(i, total);
        if (i < total) {
          if (window.requestAnimationFrame) window.requestAnimationFrame(step);
          else setTimeout(step, 0);
        } else { cache[instrId].ready = true; delete building[instrId]; resolve(); }
      }
      step();
    });
    building[instrId] = p;
    return p;
  }

  function isReady(instrId) { return !!(cache[instrId] && cache[instrId].ready); }

  // ---- Playback -------------------------------------------------------------
  // Fire a note. `when` is an absolute ctx time (0/undefined = now). `gain` 0..1.
  // `dest` optionally routes through a caller bus (e.g. the conductor's fade bus
  // for the guide); it should ultimately feed master(). `durMs`, if given, cuts
  // the note to its scored length with a short release. Falls back silently if
  // not precomputed.
  var RELEASE_S = 0.08;
  function play(instrId, midi, when, gain, dest, durMs) {
    var c = audioCtx();
    var bank = cache[instrId];
    if (!bank) return null;
    var m = Math.max(RANGE_LO, Math.min(RANGE_HI, midi | 0));
    var buf = bank.notes[m];
    if (!buf) return null;

    var src = c.createBufferSource();
    src.buffer = buf;
    var g = c.createGain();
    var lvl = (gain == null) ? 0.9 : gain;
    g.gain.value = lvl;
    src.connect(g);
    g.connect(dest || master());

    var startT = (when && when > 0) ? when : c.currentTime;
    try { src.start(startT); } catch (e) { startT = c.currentTime; try { src.start(0); } catch (e2) {} }

    if (durMs != null && durMs > 0) {
      var endT = startT + durMs / 1000;
      var relStart = Math.max(startT, endT - RELEASE_S);
      try { g.gain.setValueAtTime(lvl, relStart); g.gain.linearRampToValueAtTime(0.0001, endT); } catch (e3) {}
      try { src.stop(endT + 0.03); } catch (e4) {}
    }
    return src;
  }

  // ---- Exports --------------------------------------------------------------
  window.Maestro = window.Maestro || {};
  window.Maestro.instruments = {
    RANGE_LO: RANGE_LO,
    RANGE_HI: RANGE_HI,
    list: function () { return Object.keys(BANK).map(function (id) { return { id: id, label: BANK[id].label, icon: BANK[id].icon }; }); },
    meta: function (id) { return BANK[id] || null; },
    icon: function (id) { return (BANK[id] && BANK[id].icon) || '🎵'; },
    label: function (id) { return (BANK[id] && BANK[id].label) || id; },
    midiToFreq: midiToFreq,
    noteName: noteName,
    randomFourthOctave: function () { return 60 + ((Math.random() * 12) | 0); },
    audioCtx: audioCtx,
    master: master,
    now: function () { return audioCtx().currentTime; },
    unlock: unlock,
    precompute: precompute,
    isReady: isReady,
    play: play
  };
})();
