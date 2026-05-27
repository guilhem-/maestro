// Maestro C3 — musician (player) UI controller.
//
// Pure DOM glue around window.Maestro.{net,instruments}. The stage is rebuilt
// only when the "view" changes (mode / has-score / has-part / instrument-ready);
// live values (countdown, metronome, falling notes) are driven by a single rAF
// loop that reads the synchronized transport clock.
//
// Audio is entirely local: tapping plays a precomputed buffer for the player's
// instrument. Whether the *correct* pitch sounds depends on timing — in ALONG
// (±500 ms) and DRIVEN (±300 ms at the gate), a tap near a scheduled note plays
// that note; otherwise a random 4th-octave note sounds. FREE is always random.
(function () {
  'use strict';

  var I = null;   // Maestro.instruments (resolved on ready)
  var NET = null; // Maestro.net

  // 16-colour palette — MUST match kPalette in src/GameState.cpp and --p* in CSS.
  var PRESETS = [
    '#e74c3c', '#e67e22', '#f39c12', '#f1c40f',
    '#9bcc00', '#2ecc71', '#16a085', '#1abc9c',
    '#00bcd4', '#3498db', '#3f51b5', '#7c4dff',
    '#9b59b6', '#b13ab1', '#e84393', '#ff6b81'
  ];

  // Timing tolerances (ms). DRIVEN is tighter because the falling note shows you
  // exactly when. LOOKAHEAD is how far ahead driven notes appear (spec: 3 s).
  var ALONG_WINDOW = 500;
  var DRIVEN_WINDOW = 300;
  var LOOKAHEAD = 3000;

  var els = {};
  var conn = null;
  var myId = null;
  var lastState = null;
  var profile = { name: '', color: PRESETS[11], instrument: 'piano' };
  var profileTimer = null;

  // Current score (fetched JSON) and derived schedule for my part.
  var curScoreId = '';
  var curScore = null;
  var myVoice = null;        // voice object assigned to me (along/driven)
  var schedule = [];         // [{t,m,d,consumed,result}]  my part's notes
  var schedLo = 60, schedHi = 72;  // pitch span of my part (drives the Driven x-axis)
  var runKey = 0;            // startAtMs of the current run; change ⇒ reset

  // Effective instrument actually loaded into the synth, and its ready flag.
  var effInstr = null;
  var instrReady = false;

  // Live play feedback.
  var combo = 0, bestCombo = 0, hitCount = 0, missCount = 0;

  var viewSig = '';          // signature of the currently-built stage

  function $(id) { return document.getElementById(id); }
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ===========================================================================
  // Profile panel (name / colour / instrument)
  // ===========================================================================
  function buildSwatches() {
    var row = els.colorRow; row.innerHTML = '';
    PRESETS.forEach(function (c) {
      var b = el('button', 'swatch'); b.type = 'button';
      b.style.background = c; b.setAttribute('data-color', c);
      b.addEventListener('click', function () {
        profile.color = c; markSwatches(); NET.saveProfile(profile); scheduleProfileSend();
      });
      row.appendChild(b);
    });
    markSwatches();
  }
  function markSwatches() {
    var nodes = els.colorRow.querySelectorAll('.swatch');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('swatch--selected', nodes[i].getAttribute('data-color') === profile.color);
    }
  }
  function refreshSwatchAvailability() {
    var taken = {};
    if (lastState && lastState.players) {
      lastState.players.forEach(function (p) { if (p.id !== myId && p.color) taken[p.color.toLowerCase()] = true; });
    }
    var mine = (profile.color || '').toLowerCase();
    var nodes = els.colorRow.querySelectorAll('.swatch');
    for (var i = 0; i < nodes.length; i++) {
      var c = (nodes[i].getAttribute('data-color') || '').toLowerCase();
      nodes[i].style.display = (taken[c] && c !== mine) ? 'none' : '';
    }
  }

  // Instrument chips. In FREE/LOBBY the list is derived from the selected score
  // (its voices' instruments); with no score we offer the full bank.
  function buildInstrumentRow() {
    var row = els.instrRow; if (!row) return;
    row.innerHTML = '';
    var ids = scoreInstrumentIds();
    var dictated = isInstrumentDictated();

    if (dictated) {
      row.appendChild(el('div', 'instr-note', '🎼 Your instrument is set by your part'));
      return;
    }
    ids.forEach(function (id) {
      var chip = el('button', 'instr-chip'); chip.type = 'button';
      chip.setAttribute('data-instr', id);
      chip.appendChild(el('span', 'instr-chip__icon', I.icon(id)));
      chip.appendChild(el('span', 'instr-chip__label', I.label(id)));
      chip.addEventListener('click', function () {
        if (profile.instrument === id) return;
        profile.instrument = id; markInstrChips(); NET.saveProfile(profile);
        scheduleProfileSend(); refreshEffectiveInstrument();
      });
      row.appendChild(chip);
    });
    // If our chosen instrument isn't in this score, fall back to the first.
    if (ids.length && ids.indexOf(profile.instrument) < 0) {
      profile.instrument = ids[0]; NET.saveProfile(profile); scheduleProfileSend();
    }
    markInstrChips();
  }
  function markInstrChips() {
    var nodes = els.instrRow ? els.instrRow.querySelectorAll('.instr-chip') : [];
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('instr-chip--selected', nodes[i].getAttribute('data-instr') === profile.instrument);
    }
  }

  function scoreInstrumentIds() {
    // Test Play (FREE) draws its instrument list from the selected piece's
    // voices; Free Play (and the lobby) offer the full bank to improvise with.
    var mode = lastState && lastState.mode;
    if (mode === 'FREE' && curScore && curScore.voices) {
      var seen = {}, out = [];
      curScore.voices.forEach(function (v) { if (v.instrument && !seen[v.instrument]) { seen[v.instrument] = 1; out.push(v.instrument); } });
      if (out.length) return out;
    }
    return I.list().map(function (x) { return x.id; });
  }

  // In ALONG/DRIVEN/LISTEN the instrument comes from the assigned voice.
  function isInstrumentDictated() {
    var m = lastState && lastState.mode;
    return (m === 'ALONG' || m === 'DRIVEN' || m === 'LISTEN');
  }

  function scheduleProfileSend() {
    if (profileTimer) clearTimeout(profileTimer);
    profileTimer = setTimeout(function () {
      profileTimer = null;
      if (conn) conn.send({ t: 'setProfile', name: profile.name || '', color: profile.color || '', instrument: profile.instrument || 'piano' });
    }, 250);
  }

  // ===========================================================================
  // Effective instrument + precompute
  // ===========================================================================
  // FREE/LOBBY → the chosen instrument; ALONG/DRIVEN → my voice's instrument.
  function desiredInstrument() {
    if (isInstrumentDictated()) return myVoice ? myVoice.instrument : null;
    return profile.instrument || 'piano';
  }

  function refreshEffectiveInstrument() {
    var want = desiredInstrument();
    if (want === effInstr) return;
    effInstr = want;
    instrReady = false;
    if (!want) { renderStage(true); return; }
    if (I.isReady(want)) { instrReady = true; renderStage(true); return; }
    renderStage(true); // show the tuning state
    I.precompute(want, function (done, total) {
      if (els.tuneBar) els.tuneBar.style.width = Math.round(done / total * 100) + '%';
      if (els.tuneLabel) els.tuneLabel.textContent = 'Tuning ' + I.label(want) + '… ' + Math.round(done / total * 100) + '%';
    }).then(function () {
      if (effInstr === want) { instrReady = true; renderStage(true); }
    });
  }

  // ===========================================================================
  // Transport clock helpers
  // ===========================================================================
  function transport() { return (lastState && lastState.transport) || { running: false, startAtMs: 0, introMs: 0 }; }
  function scorePos() {                    // ms since score position 0 (neg = countdown)
    var tr = transport();
    if (!tr.running || !conn || !conn.synced()) return null;
    return conn.serverNow() - tr.startAtMs;
  }
  function tempo() { return (curScore && curScore.tempo) || 120; }

  // Rebuild my schedule when the run (re)starts.
  function syncRunState() {
    var tr = transport();
    var key = tr.running ? tr.startAtMs : 0;
    if (key !== runKey) {
      runKey = key;
      combo = 0; bestCombo = 0; hitCount = 0; missCount = 0;
      schedule = (myVoice && myVoice.notes) ? myVoice.notes.map(function (n) {
        return { t: n.t, m: n.m, d: n.d, v: n.v, consumed: false, result: 0 };
      }) : [];
      // Pitch span of my part → the horizontal axis of the Driven lane.
      schedLo = 60; schedHi = 72;
      if (schedule.length) {
        schedLo = schedHi = schedule[0].m;
        for (var i = 1; i < schedule.length; i++) { var m = schedule[i].m; if (m < schedLo) schedLo = m; if (m > schedHi) schedHi = m; }
      }
    }
  }

  // ===========================================================================
  // Playing a note
  // ===========================================================================
  // Judge a tap against my schedule, sound the result, and report it.
  function tapPlay(mode) {
    I.unlock();
    if (!instrReady || !effInstr) return;

    var midi, correct = false, durMs = null, gain = 0.95;

    if (mode === 'FREE') {
      midi = I.randomFourthOctave();   // free improvisation: let it ring naturally
    } else {
      var win = (mode === 'DRIVEN') ? DRIVEN_WINDOW : ALONG_WINDOW;
      var pos = scorePos();
      var note = (pos == null) ? null : nearestPlayable(pos, win);
      if (note) {
        note.consumed = true; note.result = 1;
        // Correct ⇒ scored pitch, length AND intensity (velocity).
        midi = note.m; correct = true; durMs = note.d; gain = I.velGain(note.v);
        combo++; if (combo > bestCombo) bestCombo = combo; hitCount++;
        gateFlash('hit');
      } else {
        midi = I.randomFourthOctave();
        gain = 0.85;
        combo = 0; missCount++;
        gateFlash('miss');
      }
    }

    I.play(effInstr, midi, 0, gain, null, durMs);
    spawnLocalNote(midi, correct);
    if (conn) conn.send({ t: 'play', midi: midi, correct: correct, voiceId: (myVoice ? myVoice.id : '') });
    updateScoreboard();
  }

  // Nearest un-consumed scheduled note within `win` ms of `pos`.
  function nearestPlayable(pos, win) {
    var best = null, bestAbs = win + 1;
    for (var i = 0; i < schedule.length; i++) {
      var s = schedule[i];
      if (s.consumed) continue;
      var dt = Math.abs(s.t - pos);
      if (dt <= win && dt < bestAbs) { best = s; bestAbs = dt; }
    }
    return best;
  }

  function gateFlash(kind) {
    if (!els.pad) return;
    els.pad.classList.remove('pad--hit', 'pad--miss');
    void els.pad.offsetWidth;
    els.pad.classList.add(kind === 'hit' ? 'pad--hit' : 'pad--miss');
  }

  function updateScoreboard() {
    if (els.combo) els.combo.textContent = combo > 1 ? ('🔥 ' + combo + ' combo') : '';
    if (els.acc) {
      var tot = hitCount + missCount;
      els.acc.textContent = tot ? (Math.round(hitCount / tot * 100) + '% · ' + hitCount + '/' + tot) : '';
    }
  }

  // ===========================================================================
  // Stage rendering — structure rebuilt only when the view signature changes
  // ===========================================================================
  function computeViewSig() {
    var mode = (lastState && lastState.mode) || 'LOBBY';
    var hasScore = curScore ? 1 : 0;
    var hasVoice = myVoice ? 1 : 0;
    var rdy = instrReady ? 1 : 0;
    var hasInstr = effInstr ? 1 : 0;
    return [mode, hasScore, hasVoice, rdy, hasInstr].join('|');
  }

  function renderStage(force) {
    var sig = computeViewSig();
    if (!force && sig === viewSig) return;
    viewSig = sig;
    var mode = (lastState && lastState.mode) || 'LOBBY';
    var stage = els.stage; stage.innerHTML = '';
    els.pad = els.combo = els.acc = els.canvas = els.tuneBar = els.tuneLabel = els.hint = els.ring = null;

    // Tuning gate (shown whenever we have an instrument that isn't ready yet).
    if (effInstr && !instrReady) { buildTuning(stage); toggleProfile(mode === 'LOBBY' || mode === 'FREE'); return; }

    if (mode === 'FREE')          buildFree(stage);
    else if (mode === 'FREEPLAY') buildFreePlay(stage);
    else if (mode === 'ALONG')    buildAlong(stage);
    else if (mode === 'DRIVEN')   buildDriven(stage);
    else if (mode === 'LISTEN')   buildListen(stage);
    else                          buildLobby(stage);

    toggleProfile(mode === 'LOBBY' || mode === 'FREE' || mode === 'FREEPLAY');
  }

  function toggleProfile(showInstr) {
    if (els.instrWrap) els.instrWrap.hidden = !showInstr && !isInstrumentDictated();
    // Always keep instrument row visible in lobby/free; in along/driven show the
    // "dictated" note instead.
    if (els.instrWrap) els.instrWrap.hidden = false;
    buildInstrumentRow();
  }

  function buildTuning(stage) {
    var w = el('div', 'tuning');
    w.appendChild(el('div', 'tuning__icon', I.icon(effInstr)));
    els.tuneLabel = el('div', 'tuning__label', 'Tuning ' + I.label(effInstr) + '…');
    w.appendChild(els.tuneLabel);
    var track = el('div', 'tuning__track');
    els.tuneBar = el('div', 'tuning__bar'); track.appendChild(els.tuneBar);
    w.appendChild(track);
    w.appendChild(el('div', 'tuning__sub', 'Pre-rendering every note so playback is instant.'));
    stage.appendChild(w);
  }

  function buildLobby(stage) {
    var w = el('div', 'lobby');
    w.appendChild(el('div', 'lobby__icon', '🎼'));
    if (curScore) {
      w.appendChild(el('div', 'lobby__title', curScore.title));
      w.appendChild(el('div', 'lobby__sub', 'by ' + (curScore.composer || '—') + ' · waiting for the conductor to start'));
    } else {
      w.appendChild(el('div', 'lobby__title', 'Welcome to the orchestra'));
      w.appendChild(el('div', 'lobby__sub', 'Pick a colour below and wait for the conductor to choose a piece.'));
    }
    stage.appendChild(w);
  }

  function buildFree(stage) {
    var w = el('div', 'free');
    var pad = el('button', 'pad pad--free'); pad.type = 'button';
    pad.style.setProperty('--pad', profile.color);
    pad.appendChild(el('span', 'pad__icon', I.icon(effInstr)));
    pad.appendChild(el('span', 'pad__label', 'PLAY'));
    bindPad(pad, 'FREE');
    els.pad = pad;
    w.appendChild(el('div', 'free__hint', 'Test your ' + I.label(effInstr) + ' — each tap plays a random note'));
    w.appendChild(pad);
    stage.appendChild(w);
  }

  // ---- Free Play: multi-touch falling-note instrument ----------------------
  // Touch a pitch column → a note is born and falls; its length tracks how long
  // you hold; sliding to another column starts a new note; the note SOUNDS when
  // it crosses the gate. Several fingers ⇒ several notes at once (chords).
  var FP_COLS = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]; // C4..B4 chromatic
  var FP_LEAD = 1500;        // ms a note falls before it reaches the gate
  var fpNotes = [];          // {col,pitch,startClock,endClock,playClock,played}
  var fpPointers = {};       // pointerId -> active note

  function fpReset() { fpNotes = []; fpPointers = {}; }
  function pcName(m) { return I.noteName(m).replace(/-?\d+$/, ''); }
  function isSharp(m) { var s = ((m % 12) + 12) % 12; return s === 1 || s === 3 || s === 6 || s === 8 || s === 10; }
  function fpColForX(x, W) { var n = FP_COLS.length; return Math.max(0, Math.min(n - 1, Math.floor(x / (W / n)))); }
  // The lane geometry in CSS px (must mirror drawFreePlay's device-px layout).
  function fpGeom(cv) { var h = cv.clientHeight; var labelH = 28, gateY = h - 54; return { labelH: labelH, gateY: gateY, travel: Math.max(1, gateY - labelH) }; }
  // Vertical touch position → time the note still falls before the gate, so it
  // is born under the finger (touch lower ⇒ shorter fall ⇒ sounds sooner).
  function fpLeadForY(y, cv) {
    var g = fpGeom(cv);
    var lead = (g.gateY - y) * FP_LEAD / g.travel;
    return Math.max(0, Math.min(FP_LEAD, lead));
  }
  function fpNewNote(col, lead) {
    var now = performance.now();
    if (lead == null) lead = FP_LEAD;
    var o = { col: col, pitch: FP_COLS[col], startClock: now, endClock: null, playClock: now + lead, played: false };
    fpNotes.push(o);
    return o;
  }
  function fpFinalize(o) { if (o && o.endClock == null) o.endClock = performance.now(); }

  function buildFreePlay(stage) {
    var w = el('div', 'driven');
    var bar = el('div', 'partbar'); bar.style.setProperty('--pad', profile.color);
    bar.appendChild(el('span', 'partbar__icon', I.icon(effInstr)));
    bar.appendChild(el('span', 'partbar__name', 'Free Play · ' + I.label(effInstr)));
    w.appendChild(bar);

    var lane = el('div', 'lane lane--free');
    els.canvas = document.createElement('canvas');
    els.canvas.className = 'lane__canvas';
    els.canvas.style.touchAction = 'none';
    lane.appendChild(els.canvas);
    w.appendChild(lane);
    w.appendChild(el('div', 'free__hint', 'Touch & hold the columns — slide and use several fingers for chords'));
    stage.appendChild(w);

    fpReset();
    bindFreePointers(els.canvas);
    sizeCanvas();
  }

  function bindFreePointers(cv) {
    function pt(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    cv.addEventListener('pointerdown', function (e) {
      e.preventDefault(); I.unlock();
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      var p = pt(e);
      fpPointers[e.pointerId] = fpNewNote(fpColForX(p.x, cv.clientWidth), fpLeadForY(p.y, cv));
    });
    cv.addEventListener('pointermove', function (e) {
      var cur = fpPointers[e.pointerId]; if (!cur) return;
      var p = pt(e);
      var col = fpColForX(p.x, cv.clientWidth);
      if (col !== cur.col) { fpFinalize(cur); fpPointers[e.pointerId] = fpNewNote(col, fpLeadForY(p.y, cv)); }
    });
    function endP(e) { var cur = fpPointers[e.pointerId]; if (cur) { fpFinalize(cur); delete fpPointers[e.pointerId]; } }
    cv.addEventListener('pointerup', endP);
    cv.addEventListener('pointercancel', endP);
    cv.addEventListener('lostpointercapture', endP);
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function updateFreePlay(now) {
    if (!instrReady || !effInstr) return;
    for (var i = 0; i < fpNotes.length; i++) {
      var o = fpNotes[i];
      if (!o.played && now >= o.playClock) {
        o.played = true;
        var dur = Math.max(120, (o.endClock || now) - o.startClock);
        I.play(effInstr, o.pitch, 0, 0.95, null, dur);
        spawnNote(profile.color, true);
        if (conn) conn.send({ t: 'play', midi: o.pitch, correct: true, voiceId: '' });
      }
    }
    // Cull notes whose tail has fully passed the gate.
    fpNotes = fpNotes.filter(function (o) {
      var dur = (o.endClock || now) - o.startClock;
      return now < o.playClock + dur + 500;
    });
  }

  function drawFreePlay(now) {
    var cv = els.canvas, ctx = cv.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    var n = FP_COLS.length, colW = W / n;
    var labelH = 28 * dpr, gateY = H - 54 * dpr, travel = gateY - labelH;
    var pxPerMs = travel / FP_LEAD;

    // Columns + pitch labels.
    for (var c = 0; c < n; c++) {
      var x0 = c * colW;
      ctx.fillStyle = isSharp(FP_COLS[c]) ? 'rgba(0,0,0,0.22)' : ((c % 2) ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)');
      ctx.fillRect(x0, 0, colW, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
      ctx.fillStyle = isSharp(FP_COLS[c]) ? 'rgba(176,139,255,0.85)' : 'rgba(243,238,254,0.75)';
      ctx.font = 'bold ' + (12 * dpr) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pcName(FP_COLS[c]), x0 + colW / 2, labelH / 2);
    }

    // Gate.
    ctx.strokeStyle = 'rgba(255,215,107,0.55)'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(0, gateY); ctx.lineTo(W, gateY); ctx.stroke();

    // Notes.
    var col = profile.color || '#b08bff';
    for (var i = 0; i < fpNotes.length; i++) {
      var o = fpNotes[i];
      var dur = (o.endClock || now) - o.startClock;
      var yLead = gateY - (o.playClock - now) * pxPerMs;   // bottom edge (musical start)
      var durPx = Math.max(6 * dpr, dur * pxPerMs);
      var x = o.col * colW + 2 * dpr, wRect = colW - 4 * dpr;
      ctx.globalAlpha = o.played ? 0.5 : 0.95;
      ctx.fillStyle = o.played ? '#2ecc71' : col;
      ctx.fillRect(x, yLead - durPx, wRect, durPx);
      ctx.globalAlpha = 1;
    }
  }

  function buildWaitingForPart(stage, modeLabel) {
    var w = el('div', 'lobby');
    w.appendChild(el('div', 'lobby__icon', '🎻'));
    w.appendChild(el('div', 'lobby__title', 'Waiting for your part'));
    w.appendChild(el('div', 'lobby__sub', 'The conductor will assign you a voice for ' + modeLabel + '.'));
    stage.appendChild(w);
  }

  function buildAlong(stage) {
    if (!myVoice) { buildWaitingForPart(stage, 'Play Along'); return; }
    var w = el('div', 'along');

    var head = el('div', 'partbar');
    head.style.setProperty('--pad', profile.color);
    head.appendChild(el('span', 'partbar__icon', I.icon(effInstr)));
    head.appendChild(el('span', 'partbar__name', myVoice.name + ' · ' + I.label(effInstr)));
    w.appendChild(head);

    els.ring = el('div', 'beatring');
    var inner = el('div', 'beatring__inner');
    els.hint = el('div', 'beatring__hint', '—');
    inner.appendChild(els.hint);
    els.ring.appendChild(inner);
    w.appendChild(els.ring);

    var pad = el('button', 'pad pad--along'); pad.type = 'button';
    pad.style.setProperty('--pad', profile.color);
    pad.appendChild(el('span', 'pad__label', 'TAP'));
    bindPad(pad, 'ALONG');
    els.pad = pad;
    w.appendChild(pad);

    var sb = el('div', 'scoreboard');
    els.combo = el('div', 'scoreboard__combo', '');
    els.acc = el('div', 'scoreboard__acc', '');
    sb.appendChild(els.combo); sb.appendChild(els.acc);
    w.appendChild(sb);

    stage.appendChild(w);
  }

  function buildDriven(stage) {
    if (!myVoice) { buildWaitingForPart(stage, 'Follow the Notes'); return; }
    var w = el('div', 'driven');

    var head = el('div', 'partbar');
    head.style.setProperty('--pad', profile.color);
    head.appendChild(el('span', 'partbar__icon', I.icon(effInstr)));
    head.appendChild(el('span', 'partbar__name', myVoice.name + ' · ' + I.label(effInstr)));
    w.appendChild(head);

    var lane = el('div', 'lane');
    els.canvas = document.createElement('canvas');
    els.canvas.className = 'lane__canvas';
    lane.appendChild(els.canvas);
    bindPad(lane, 'DRIVEN');   // tap anywhere in the lane
    w.appendChild(lane);

    var pad = el('button', 'pad pad--driven'); pad.type = 'button';
    pad.style.setProperty('--pad', profile.color);
    pad.appendChild(el('span', 'pad__label', 'TAP'));
    bindPad(pad, 'DRIVEN');
    els.pad = pad;
    w.appendChild(pad);

    var sb = el('div', 'scoreboard');
    els.combo = el('div', 'scoreboard__combo', '');
    els.acc = el('div', 'scoreboard__acc', '');
    sb.appendChild(els.combo); sb.appendChild(els.acc);
    w.appendChild(sb);

    stage.appendChild(w);
    sizeCanvas();
  }

  // ---- Listen Only ---------------------------------------------------------
  // The piece auto-plays. With target "players", THIS device sounds its assigned
  // voice (scheduled via Web Audio off the shared transport clock); with target
  // "master" the conductor device plays everything and we just watch. Either
  // way, if we have a part we show it as a falling-note visualizer.
  function buildListen(stage) {
    if (!myVoice) {
      var lw = el('div', 'lobby');
      lw.appendChild(el('div', 'lobby__icon', '🎧'));
      lw.appendChild(el('div', 'lobby__title', 'Listening'));
      lw.appendChild(el('div', 'lobby__sub', curScore ? ('Enjoy ' + curScore.title) : 'The conductor will play a piece.'));
      stage.appendChild(lw);
      return;
    }
    var w = el('div', 'driven');
    var head = el('div', 'partbar'); head.style.setProperty('--pad', profile.color);
    head.appendChild(el('span', 'partbar__icon', I.icon(effInstr)));
    head.appendChild(el('span', 'partbar__name', '🎧 ' + myVoice.name + ' · ' + I.label(effInstr)));
    w.appendChild(head);
    var lane = el('div', 'lane');
    els.canvas = document.createElement('canvas'); els.canvas.className = 'lane__canvas';
    lane.appendChild(els.canvas);
    w.appendChild(lane);
    w.appendChild(el('div', 'free__hint', 'Sit back — the piece plays itself'));
    stage.appendChild(w);
    sizeCanvas();
  }

  var listenSources = [], listenKey = -1;
  function stopListen() { listenSources.forEach(function (s) { try { s.stop(); } catch (e) {} }); listenSources = []; }
  function handleListen() {
    var s = lastState, tr = transport();
    // Only the "players" target plays locally; stop whenever the run ends/changes.
    if (!(s && s.mode === 'LISTEN' && tr.running)) { listenKey = -1; stopListen(); return; }
    if (tr.target !== 'players' || !myVoice || !instrReady || !conn || !conn.synced()) return;
    if (tr.startAtMs === listenKey) return;     // already scheduled this run
    listenKey = tr.startAtMs;
    scheduleListen(tr);
  }
  function scheduleListen(tr) {
    stopListen();
    if (!myVoice || !effInstr) return;
    var ctx = I.audioCtx();
    var ctxStart = ctx.currentTime + Math.max(0, (tr.startAtMs - conn.serverNow()) / 1000);
    var nowCtx = ctx.currentTime;
    for (var i = 0; i < myVoice.notes.length; i++) {
      var n = myVoice.notes[i];
      var when = ctxStart + n.t / 1000;
      if (when < nowCtx - 0.05) continue;       // don't dump already-past notes
      var src = I.play(effInstr, n.m, when, I.velGain(n.v), null, n.d);
      if (src) listenSources.push(src);
    }
  }

  function bindPad(node, mode) {
    node.addEventListener('pointerdown', function (e) { e.preventDefault(); tapPlay(mode); });
    node.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function sizeCanvas() {
    if (!els.canvas) return;
    var rect = els.canvas.parentNode.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    els.canvas.width = Math.max(1, rect.width * dpr);
    els.canvas.height = Math.max(1, rect.height * dpr);
    els.canvas.style.width = rect.width + 'px';
    els.canvas.style.height = rect.height + 'px';
  }

  // ===========================================================================
  // Animation loop — countdown, metronome, falling notes
  // ===========================================================================
  function frame() {
    requestAnimationFrame(frame);
    var mode = (lastState && lastState.mode) || 'LOBBY';
    var pos = scorePos();

    // Countdown overlay (any timed mode while transport hasn't reached 0).
    var tr = transport();
    if (tr.running && pos != null && pos < 0) showCountdown(Math.ceil(-pos / 1000));
    else hideCountdown();

    if (mode === 'ALONG' && myVoice) updateAlong(pos);
    if ((mode === 'DRIVEN' || mode === 'LISTEN') && myVoice && els.canvas) drawLane(pos);
    if (mode === 'FREEPLAY' && els.canvas) { var nowp = performance.now(); updateFreePlay(nowp); drawFreePlay(nowp); }
    if (mode === 'LISTEN') handleListen();
  }

  function showCountdown(n) {
    if (!els.countdown) {
      els.countdown = el('div', 'countdown');
      els.countNum = el('div', 'countdown__num', '');
      els.countdown.appendChild(els.countNum);
      els.countdown.appendChild(el('div', 'countdown__sub', 'get ready…'));
      document.body.appendChild(els.countdown);
    }
    els.countdown.hidden = false;
    var label = n <= 0 ? 'GO' : String(n);
    if (els.countNum.textContent !== label) {
      els.countNum.textContent = label;
      els.countNum.classList.remove('pop'); void els.countNum.offsetWidth; els.countNum.classList.add('pop');
    }
  }
  function hideCountdown() { if (els.countdown) els.countdown.hidden = true; }

  function updateAlong(pos) {
    var beatMs = 60000 / tempo();
    // Metronome ring pulse: it swells on the beat and a conic sweep fills the rim.
    if (els.ring) {
      var phase = (pos == null) ? 0 : (((pos % beatMs) + beatMs) % beatMs) / beatMs;
      var swell = (pos == null) ? 1 : (1 + 0.10 * Math.abs(Math.sin(phase * Math.PI)));
      els.ring.style.transform = 'scale(' + swell.toFixed(3) + ')';
      els.ring.style.setProperty('--beat', String(1 - phase));
    }
    // Next-note hint + auto-expire passed notes.
    if (pos != null) {
      for (var i = 0; i < schedule.length; i++) {
        var s = schedule[i];
        if (!s.consumed && pos > s.t + ALONG_WINDOW) { s.consumed = true; }
      }
      var next = null;
      for (var j = 0; j < schedule.length; j++) { if (!schedule[j].consumed && schedule[j].t >= pos - ALONG_WINDOW) { next = schedule[j]; break; } }
      if (els.hint) {
        if (next) {
          var dt = (next.t - pos) / 1000;
          els.hint.textContent = I.noteName(next.m) + (dt > 0.05 ? ' · ' + dt.toFixed(1) + 's' : ' · NOW');
        } else { els.hint.textContent = (pos > (curScore ? curScore.lengthMs : 0)) ? '🎉 fin' : '…'; }
      }
    } else if (els.hint) {
      els.hint.textContent = '♪';
    }
  }

  function drawLane(pos) {
    var cv = els.canvas, ctx = cv.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    var top = 10 * dpr;
    var gateY = H - 64 * dpr;
    var marginX = 34 * dpr;

    // Horizontal pitch axis: low pitches on the left, high on the right, so the
    // falling notes trace the melodic contour of the part.
    var span = Math.max(1, schedHi - schedLo);
    function xFor(m) {
      if (schedHi === schedLo) return W / 2;
      return marginX + (m - schedLo) / span * (W - 2 * marginX);
    }

    // Gate line.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(0, gateY); ctx.lineTo(W, gateY); ctx.stroke();
    // Gate glow band (the ± window mapped to pixels).
    var win = DRIVEN_WINDOW;
    var bandPx = (win / LOOKAHEAD) * (gateY - top);
    ctx.fillStyle = 'rgba(176,139,255,0.12)';
    ctx.fillRect(0, gateY - bandPx, W, bandPx * 2);

    // Pitch-axis hints (low ← → high).
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = (11 * dpr) + 'px sans-serif'; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';  ctx.fillText('low ' + I.noteName(schedLo), 6 * dpr, H - 8 * dpr);
    ctx.textAlign = 'right'; ctx.fillText(I.noteName(schedHi) + ' high', W - 6 * dpr, H - 8 * dpr);

    if (pos == null) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = (16 * dpr) + 'px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('syncing…', W / 2, H / 2);
      return;
    }

    var col = profile.color || '#b08bff';
    for (var i = 0; i < schedule.length; i++) {
      var s = schedule[i];
      var delta = s.t - pos;                 // ms until this note is due
      if (delta > LOOKAHEAD) continue;       // not visible yet
      if (delta < -win - 120) { if (!s.consumed) s.consumed = true; continue; }
      var frac = delta / LOOKAHEAD;          // 1 at top, 0 at gate, <0 below
      var y = gateY - frac * (gateY - top);
      var x = xFor(s.m);
      var r = 16 * dpr;
      // Faint guide rail down to the gate so you can read where it will land.
      ctx.globalAlpha = s.consumed ? 0.06 : 0.14;
      ctx.strokeStyle = col; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, gateY); ctx.stroke();
      ctx.globalAlpha = s.consumed ? 0.25 : 1;
      ctx.fillStyle = (s.result === 1) ? '#2ecc71' : col;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = 'bold ' + (12 * dpr) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(I.noteName(s.m), x, y);
    }
  }

  // ===========================================================================
  // Ambient notes from other musicians (shared visualization)
  // ===========================================================================
  function spawnLocalNote(midi, correct) { spawnNote(profile.color, correct); }
  function spawnNote(color, correct) {
    var n = el('div', 'fx-note', Math.random() < 0.5 ? '♪' : '♫');
    n.style.color = color || '#b08bff';
    n.style.left = (10 + Math.random() * 80) + 'vw';
    n.style.fontSize = (20 + Math.random() * 22) + 'px';
    if (correct) n.classList.add('fx-note--hit');
    document.body.appendChild(n);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 1600);
  }

  // ===========================================================================
  // WS callbacks
  // ===========================================================================
  function onState(s) {
    lastState = s;

    // Reconcile my profile with the server's authoritative copy.
    var me = null;
    if (myId && s.players) { for (var i = 0; i < s.players.length; i++) if (s.players[i].id === myId) { me = s.players[i]; break; } }
    if (me) {
      if (me.name && me.name !== profile.name && document.activeElement !== els.name) { profile.name = me.name; els.name.value = me.name; }
      if (me.color && me.color !== profile.color) { profile.color = me.color; markSwatches(); }
      if (me.instrument && me.instrument !== profile.instrument && !isInstrumentDictated()) { profile.instrument = me.instrument; markInstrChips(); }
    }

    // Resolve my assigned voice (along/driven).
    var myVoiceId = me ? (me.voiceId || '') : '';
    myVoice = (curScore && myVoiceId) ? findVoice(curScore, myVoiceId) : null;

    // Fetch the score if it changed.
    if (s.scoreId !== curScoreId) {
      curScoreId = s.scoreId || '';
      curScore = null; myVoice = null;
      if (curScoreId) {
        var wantId = curScoreId;
        NET.fetchScore(wantId).then(function (sc) {
          if (curScoreId !== wantId) return;        // a newer score was selected
          curScore = sc;
          myVoice = findVoice(curScore, pickMyVoiceId());
          refreshEffectiveInstrument(); syncRunState(); buildInstrumentRow(); renderStage(true);
        });
      }
    }

    syncRunState();
    refreshEffectiveInstrument();
    refreshSwatchAvailability();
    renderStage(false);
    updateConn();
  }

  function pickMyVoiceId() {
    if (!lastState || !lastState.players || !myId) return '';
    for (var i = 0; i < lastState.players.length; i++) if (lastState.players[i].id === myId) return lastState.players[i].voiceId || '';
    return '';
  }
  function findVoice(score, vid) {
    if (!score || !score.voices || !vid) return null;
    for (var i = 0; i < score.voices.length; i++) if (score.voices[i].id === vid) return score.voices[i];
    return null;
  }

  function onNote(evt) {
    if (!evt || evt.playerId === myId) return;     // our own taps render locally
    var color = '#b08bff';
    if (lastState && lastState.players) {
      for (var i = 0; i < lastState.players.length; i++) if (lastState.players[i].id === evt.playerId) { color = lastState.players[i].color; break; }
    }
    spawnNote(color, !!evt.correct);
  }

  function onWelcome(w) {
    myId = w.yourId || NET.clientId();
    if (w.yourRole === 'admin') showConductorBanner();
    if (lastState) onState(lastState);
  }

  function onError(e) { /* non-fatal; surface profile clashes quietly */ if (e && e.code === 'bad_profile') flashConn('colour taken — pick another'); }

  // ===========================================================================
  // Connection chrome
  // ===========================================================================
  function updateConn() {
    if (!els.conn) return;
    var mode = (lastState && lastState.mode) || 'LOBBY';
    var online = 0, total = 0;
    if (lastState && lastState.players) { total = lastState.players.length; lastState.players.forEach(function (p) { if (p.online) online++; }); }
    els.modePill.textContent = modeLabel(mode);
    els.modePill.className = 'modepill modepill--' + mode.toLowerCase();
    els.conn.textContent = (conn && conn.synced() ? '🟢' : '🟡') + ' ' + online + '/' + total + ' musicians';
    // Offer the podium whenever the conductor seat is empty (the server frees it
    // after the grace period when a conductor leaves).
    if (els.claimHost) els.claimHost.hidden = !!(lastState && lastState.adminId && lastState.adminId.length);
  }
  function modeLabel(m) { return ({ LOBBY: 'Lobby', FREE: 'Test Play', FREEPLAY: 'Free Play', ALONG: 'Play Along', DRIVEN: 'Follow Notes', LISTEN: 'Listen Only' })[m] || m; }
  function flashConn(msg) { if (els.conn) { els.conn.textContent = '⚠️ ' + msg; } }

  function showConductorBanner() {
    if (document.querySelector('.banner[data-kind="conductor"]')) return;
    var b = el('div', 'banner'); b.setAttribute('data-kind', 'conductor');
    var a = el('a', null, '🎩 You are the conductor — open the podium'); a.href = '/admin';
    b.appendChild(a);
    document.body.insertBefore(b, document.body.firstChild);
  }

  // ===========================================================================
  // Init
  // ===========================================================================
  ready(function () {
    NET = window.Maestro.net; I = window.Maestro.instruments;
    els.stage   = $('stage');
    els.name    = $('name');
    els.colorRow = $('color-row');
    els.instrRow = $('instr-row');
    els.instrWrap = $('instr-wrap');
    els.conn    = $('conn');
    els.modePill = $('mode-pill');
    els.claimHost = $('claim-host');
    if (els.claimHost) els.claimHost.addEventListener('click', function () { window.location.href = '/admin'; });

    var saved = NET.loadProfile();
    if (saved.name) profile.name = saved.name;
    if (saved.color) profile.color = saved.color;
    if (saved.instrument) profile.instrument = saved.instrument;
    els.name.value = profile.name || '';

    buildSwatches();
    buildInstrumentRow();

    els.name.addEventListener('input', function () { profile.name = els.name.value.slice(0, 20); NET.saveProfile(profile); scheduleProfileSend(); });
    document.body.addEventListener('pointerdown', function () { I.unlock(); }, { once: true });
    window.addEventListener('resize', function () { sizeCanvas(); });

    // Pre-tune whatever instrument we already remember (so FREE is instant).
    refreshEffectiveInstrument();
    renderStage(true);
    requestAnimationFrame(frame);

    conn = NET.connect({ role: 'player', onState: onState, onNote: onNote, onWelcome: onWelcome, onError: onError });
  });
})();
