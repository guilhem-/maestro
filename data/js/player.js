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
  var combo = 0, bestCombo = 0, hitCount = 0, missCount = 0, perfectCount = 0;
  var perfectStreak = 0;          // consecutive PERFECTs (drives an in-the-moment badge toast)
  var lastPosWhileRunning = -1;   // last score position seen while running (for the end-of-piece payoff)
  var rosterEls = {};             // playerId -> roster chip element (pulsed on their notes)

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

  // In ALONG/DRIVEN/LISTEN the instrument comes from the assigned voice — but
  // only once you actually have one. Before that (waiting for a part) you keep
  // your own choice, so the warm-up pad makes the sound you picked. SCORE is
  // read-only (no audio), so the chooser is irrelevant there too.
  function isInstrumentDictated() {
    var m = lastState && lastState.mode;
    if (m === 'LISTEN' || m === 'SCORE') return true;
    return (m === 'ALONG' || m === 'DRIVEN') && !!myVoice;
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
    // SCORE is a read-only view → no audio buffers needed, skip precompute.
    if (lastState && lastState.mode === 'SCORE') return null;
    // While a part is assigned, the voice dictates the instrument; before that
    // (waiting for a part, or the lobby) fall back to the profile choice so the
    // phone can pre-tune and the musician can warm up.
    if (isInstrumentDictated()) return myVoice ? myVoice.instrument : (profile.instrument || 'piano');
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
      // A run that was playing just stopped → if I took part and the piece
      // actually reached its end, reward the effort before wiping the tally.
      if (runKey !== 0 && key === 0) maybeCelebrate((lastState && lastState.mode) || '');
      else hideCelebrate();              // a fresh run starting → clear any payoff overlay
      runKey = key;
      combo = 0; bestCombo = 0; hitCount = 0; missCount = 0; perfectCount = 0; perfectStreak = 0;
      lastPosWhileRunning = -1;
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
        var signed = note.t - pos;                 // >0 you tapped early, <0 late
        var grade = gradeFor(Math.abs(signed), win);
        if (grade === 'perfect') { perfectCount++; perfectStreak++; maybePerfectStreak(perfectStreak); }
        else perfectStreak = 0;
        combo++; if (combo > bestCombo) bestCombo = combo; hitCount++;
        gateFlash('hit');
        flashJudge(grade, signed);
        haptic(grade === 'perfect' ? [8, 26, 8] : 14);
        maybeCombo(combo);
      } else {
        midi = I.randomFourthOctave();
        gain = 0.85;
        combo = 0; perfectStreak = 0; missCount++;
        gateFlash('miss');
        flashJudge('miss', 0);
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

  // Tactile feedback — the single biggest "game feel" win on a phone. No-op on
  // desktop / iOS Safari (which doesn't expose the Vibration API).
  function haptic(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }

  // Timing tiers: closer to the scheduled note ⇒ better grade. Thirds of the
  // judging window → perfect / great / good.
  function gradeFor(absDt, win) {
    if (absDt <= win * 0.34) return 'perfect';
    if (absDt <= win * 0.67) return 'great';
    return 'good';
  }

  // Floating timing verdict above the pad (PERFECT / GREAT / GOOD ± early/late).
  function flashJudge(grade, signed) {
    if (!els.judge) { els.judge = el('div', 'judge'); document.body.appendChild(els.judge); }
    var txt, cls;
    if (grade === 'perfect')    { txt = 'PERFECT'; cls = 'judge--perfect'; }
    else if (grade === 'great') { txt = 'GREAT';   cls = 'judge--great'; }
    else if (grade === 'good')  { txt = 'GOOD';    cls = 'judge--good'; }
    else                        { txt = 'MISS';    cls = 'judge--miss'; }
    if (grade === 'great' || grade === 'good') txt += signed > 0 ? '  early' : '  late';
    els.judge.className = 'judge ' + cls;
    els.judge.textContent = txt;
    void els.judge.offsetWidth;
    els.judge.classList.add('judge--show');
  }

  // Combo milestones: a full-screen burst, a stronger buzz, and a bright little
  // arpeggio reward so a hot streak *feels* like an achievement.
  function maybeCombo(c) {
    if (!(c === 10 || c === 25 || c === 50 || c === 75 || c === 100 || (c > 100 && c % 50 === 0))) return;
    if (!els.combofx) { els.combofx = el('div', 'combofx'); document.body.appendChild(els.combofx); }
    els.combofx.textContent = '🔥 ' + c + ' COMBO';
    els.combofx.classList.remove('combofx--show'); void els.combofx.offsetWidth; els.combofx.classList.add('combofx--show');
    haptic([0, 35, 35, 35]);
    if (effInstr && instrReady) [0, 4, 7, 12].forEach(function (iv, k) { I.play(effInstr, 72 + iv, I.now() + k * 0.05, 0.4, null, 240); });
  }

  // In-the-moment streak reward: a clean run of PERFECTs in a row.
  function maybePerfectStreak(streak) {
    if (!(streak === 10 || streak === 25 || (streak > 10 && streak % 25 === 0))) return;
    if (!els.combofx) { els.combofx = el('div', 'combofx'); document.body.appendChild(els.combofx); }
    els.combofx.textContent = '💎 ' + streak + ' PERFECT IN A ROW';
    els.combofx.classList.remove('combofx--show'); void els.combofx.offsetWidth; els.combofx.classList.add('combofx--show');
    haptic([0, 20, 20, 20, 20, 20]);
  }

  // A warm major chord that swells when a piece you played finishes.
  function playFanfare() {
    if (!effInstr || !instrReady) return;
    [0, 4, 7, 12].forEach(function (iv, k) { I.play(effInstr, 60 + iv, I.now() + k * 0.05, 0.5, null, 1800); });
  }

  function updateScoreboard() {
    if (els.combo) els.combo.textContent = combo > 1 ? ('🔥 ' + combo + ' combo') : '';
    if (els.acc) {
      var tot = hitCount + missCount;
      els.acc.textContent = tot ? (Math.round(hitCount / tot * 100) + '% · ' + hitCount + '/' + tot) : '';
    }
  }

  // ===========================================================================
  // End-of-piece payoff — the moment that makes people want "one more"
  // ===========================================================================
  function maybeCelebrate(prevMode) {
    if (prevMode !== 'ALONG' && prevMode !== 'DRIVEN') return;   // only modes you tap
    if (!myVoice) return;
    var tot = hitCount + missCount;
    if (tot <= 0) return;
    var len = curScore ? (curScore.lengthMs || 0) : 0;
    if (len && lastPosWhileRunning < len - 2500) return;         // stopped early → no payoff
    var acc = Math.round(hitCount / tot * 100);
    showCelebrate({ acc: acc, best: bestCombo, perfect: perfectCount, hits: hitCount, total: tot,
                    badges: earnBadges({ acc: acc, best: bestCombo, perfect: perfectCount }) });
    playFanfare();
  }

  // Badges earned this run (with a `fresh` flag for first-ever), persisted so a
  // badge is "new" only the first time. Keyed by stat thresholds.
  var BADGES = [
    { id: 'finisher',      icon: '🎵', label: 'Finisher',      test: function () { return true; } },
    { id: 'sharpshooter',  icon: '🎯', label: 'Sharpshooter',  test: function (s) { return s.acc >= 90; } },
    { id: 'flawless',      icon: '🌟', label: 'Flawless',      test: function (s) { return s.acc >= 100; } },
    { id: 'combo-master',  icon: '🔥', label: 'Combo Master',  test: function (s) { return s.best >= 25; } },
    { id: 'perfectionist', icon: '💎', label: 'Perfectionist', test: function (s) { return s.perfect >= 15; } }
  ];
  function loadBadges() { try { return JSON.parse(localStorage.getItem('maestro.badges') || '{}') || {}; } catch (e) { return {}; } }
  function saveBadges(o) { try { localStorage.setItem('maestro.badges', JSON.stringify(o)); } catch (e) {} }
  function earnBadges(s) {
    var have = loadBadges(), out = [];
    BADGES.forEach(function (b) {
      if (!b.test(s)) return;
      var fresh = !have[b.id];
      if (fresh) have[b.id] = 1;
      out.push({ icon: b.icon, label: b.label, fresh: fresh });
    });
    saveBadges(have);
    return out;
  }

  function celStat(num, lbl) {
    var d = el('div', 'celebrate__stat');
    d.appendChild(el('div', 'celebrate__num', num));
    d.appendChild(el('div', 'celebrate__lbl', lbl));
    return d;
  }
  function showCelebrate(s) {
    hideCelebrate();
    var ov = el('div', 'celebrate');
    ov.appendChild(el('div', 'celebrate__emoji', s.acc >= 80 ? '🌟' : '🎉'));
    ov.appendChild(el('div', 'celebrate__title', 'Bravo!'));
    var st = el('div', 'celebrate__stats');
    st.appendChild(celStat(s.acc + '%', 'accuracy'));
    st.appendChild(celStat('🔥 ' + s.best, 'best combo'));
    st.appendChild(celStat(String(s.perfect), 'perfect'));
    ov.appendChild(st);
    ov.appendChild(el('div', 'lobby__sub', 'You played ' + s.hits + ' of ' + s.total + ' notes'));
    if (s.badges && s.badges.length) {
      var br = el('div', 'badges');
      s.badges.forEach(function (b) {
        var chip = el('div', 'badge' + (b.fresh ? ' badge--new' : ''));
        chip.appendChild(el('span', 'badge__icon', b.icon));
        chip.appendChild(el('span', 'badge__label', b.label + (b.fresh ? ' ✦' : '')));
        br.appendChild(chip);
      });
      ov.appendChild(br);
    }
    var btn = el('button', 'btn celebrate__btn', 'Continue'); btn.type = 'button';
    btn.addEventListener('click', hideCelebrate);
    ov.appendChild(btn);
    document.body.appendChild(ov);
    els.celebrate = ov;
    haptic([0, 30, 40, 30, 40, 60]);
  }
  function hideCelebrate() {
    if (els.celebrate && els.celebrate.parentNode) els.celebrate.parentNode.removeChild(els.celebrate);
    els.celebrate = null;
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
    else if (mode === 'SCORE')    buildScore(stage);
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
      w.appendChild(el('div', 'lobby__sub', 'Pick a colour below and warm up while the conductor sets up.'));
    }
    stage.appendChild(w);
    addWarmupPad(stage);
  }

  // A free "noodle" pad so nobody stares at a dead screen while waiting (in the
  // lobby, or after joining a timed mode before a part is assigned). Taps play a
  // random note on the chosen instrument — same path as Test Play.
  function addWarmupPad(stage) {
    if (!instrReady || !effInstr) return;
    var pad = el('button', 'pad pad--warm'); pad.type = 'button';
    pad.style.setProperty('--pad', profile.color);
    pad.appendChild(el('span', 'pad__icon', I.icon(effInstr)));
    pad.appendChild(el('span', 'pad__label', 'WARM UP'));
    bindPad(pad, 'FREE');
    els.pad = pad;
    stage.appendChild(pad);
    stage.appendChild(el('div', 'free__hint', 'Tap to noodle on your ' + I.label(effInstr) + ' while you wait'));
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
    addWarmupPad(stage);
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

  // ---- Read Score ----------------------------------------------------------
  // A read-only view of the musician's assigned voice for the whole piece, in
  // one of two layouts (toggle): a piano-ROLL (time top→bottom, pitch left→right)
  // or a music SHEET (treble staff, time left→right). In both, tapping a note
  // plays it on the device. Audio is loaded lazily on the first tap so the view
  // shows instantly. No transport.
  var scoreSubview = (function () { try { return localStorage.getItem('maestro.scoreView') || 'roll'; } catch (e) { return 'roll'; } })();
  var pianoKeys = {};            // sheet view: pitch-class → keyboard key element (lit on play)

  function buildScore(stage) {
    if (!myVoice) { buildWaitingForPart(stage, 'Read Score'); return; }
    pianoKeys = {};              // dropped unless the sheet view rebuilds it
    var w = el('div', 'scoreview');

    var head = el('div', 'partbar'); head.style.setProperty('--pad', profile.color);
    head.appendChild(el('span', 'partbar__icon', I.icon(myVoice.instrument)));
    head.appendChild(el('span', 'partbar__name', '📜 ' + myVoice.name + ' · ' + I.label(myVoice.instrument)));
    w.appendChild(head);

    // View toggle: Roll vs Sheet.
    var seg = el('div', 'scoreseg');
    [['roll', '🎹 Roll'], ['sheet', '🎼 Sheet']].forEach(function (o) {
      var b = el('button', 'scoreseg__btn' + (scoreSubview === o[0] ? ' scoreseg__btn--on' : ''), o[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (scoreSubview === o[0]) return;
        scoreSubview = o[0];
        try { localStorage.setItem('maestro.scoreView', scoreSubview); } catch (e) {}
        renderStage(true);
      });
      seg.appendChild(b);
    });
    w.appendChild(seg);

    if (scoreSubview === 'sheet') {
      // A framed area: the staff scrolls; a one-octave keyboard pinned at the
      // bottom does not (it's a sibling of the scroller, not inside it).
      var frame = el('div', 'sheetwrap');
      var sroll = el('div', 'sheetroll');
      var sheet = el('div', 'sheet');
      sroll.appendChild(sheet); frame.appendChild(sroll);
      frame.appendChild(buildKeyboard());
      w.appendChild(frame);
      w.appendChild(el('div', 'free__hint', 'Tap a note or a key to hear it — scroll left to right'));
      stage.appendChild(w);
      layoutSheet(sheet);
    } else {
      var scroller = el('div', 'scoreroll');
      var roll = el('div', 'scoreroll__inner');
      scroller.appendChild(roll); w.appendChild(scroller);
      w.appendChild(el('div', 'free__hint', 'Tap a note to hear it — scroll top to bottom'));
      stage.appendChild(w);
      layoutRoll(roll);
    }
  }

  // Lazily load the part's instrument, then sound the tapped note. Also lights
  // the matching keyboard key (no-op outside the sheet view).
  function playScoreNote(m, durMs) {
    I.unlock();
    animateKey(((m % 12) + 12) % 12);
    var instr = myVoice && myVoice.instrument; if (!instr) return;
    if (I.isReady(instr)) { I.play(instr, m, 0, 0.95, null, durMs); return; }
    I.precompute(instr).then(function () { I.play(instr, m, 0, 0.95, null, durMs); });
  }
  function makeTappable(node, m, durMs) {
    node.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      playScoreNote(m, durMs);
      node.classList.remove('snote--hit'); void node.offsetWidth; node.classList.add('snote--hit');
    });
  }

  function layoutRoll(roll) {
    var notes = (myVoice && myVoice.notes) || [];
    if (!notes.length) { roll.appendChild(el('div', 'scoreroll__empty', '(empty part)')); return; }

    var lo = notes[0].m, hi = notes[0].m, endMs = 0;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.m < lo) lo = n.m; if (n.m > hi) hi = n.m;
      var e = n.t + (n.d || 200); if (e > endMs) endMs = e;
    }
    var span = Math.max(1, hi - lo);
    var PXMS = 0.16;                       // vertical px per ms (scroll length)
    var padTop = 16;
    roll.style.height = Math.round(endMs * PXMS + padTop * 2) + 'px';

    var beatMs = 60000 / ((curScore && curScore.tempo) || 120);
    for (var b = 0, y; (y = padTop + b * beatMs * PXMS) <= endMs * PXMS + padTop; b++) {
      var line = el('div', (b % 4 === 0) ? 'scoreline scoreline--bar' : 'scoreline');
      line.style.top = y + 'px';
      if (b % 4 === 0) line.appendChild(el('span', 'scoreline__n', String(b / 4 + 1)));
      roll.appendChild(line);
    }

    for (var j = 0; j < notes.length; j++) {
      var nn = notes[j];
      var blk = el('div', 'snote');
      blk.style.top = (padTop + nn.t * PXMS) + 'px';
      blk.style.height = Math.max(15, (nn.d || 200) * PXMS) + 'px';
      blk.style.left = (span === 0 ? 50 : (8 + (nn.m - lo) / span * 84)).toFixed(2) + '%';
      blk.style.background = profile.color;
      blk.appendChild(el('span', 'snote__lbl', I.noteName(nn.m)));
      makeTappable(blk, nn.m, nn.d);
      roll.appendChild(blk);
    }
  }

  // Spell a pitch for the treble staff. Naturals keep their letter; a black key
  // is a sharp when ascending/repeating into it and a flat when descending —
  // which sets both the staff position (C♯ on C, D♭ on D) and the glyph.
  function spell(m, prevM) {
    var natLetter = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };   // C D E F G A B
    var pc = ((m % 12) + 12) % 12;
    if (natLetter.hasOwnProperty(pc)) return { letter: natLetter[pc], oct: Math.floor(m / 12) - 1, acc: '' };
    var flat = (prevM != null && prevM > m);
    var nat = flat ? m + 1 : m - 1;                                  // the natural we lean on
    return { letter: natLetter[((nat % 12) + 12) % 12], oct: Math.floor(nat / 12) - 1, acc: flat ? 'b' : '#' };
  }
  function stepFromSpell(sp) { return sp.oct * 7 + sp.letter - 30; }   // 30 = E4, the bottom line

  function addLedger(sheet, x, y) {
    var l = el('div', 'ledger'); l.style.left = (x - 5) + 'px'; l.style.top = y + 'px'; sheet.appendChild(l);
  }

  // Note value from its length in beats → open/filled head, stem, flag count
  // (so half/whole notes read as hollow "white" heads, quarters and shorter as
  // filled "black" heads).
  function noteValue(beats) {
    if (beats >= 3)     return { open: true,  stem: false, flags: 0 };  // whole
    if (beats >= 1.5)   return { open: true,  stem: true,  flags: 0 };  // half
    if (beats >= 0.75)  return { open: false, stem: true,  flags: 0 };  // quarter
    if (beats >= 0.375) return { open: false, stem: true,  flags: 1 };  // eighth
    return                     { open: false, stem: true,  flags: 2 };  // sixteenth
  }

  function layoutSheet(sheet) {
    var notes = (myVoice && myVoice.notes) || [];
    if (!notes.length) { sheet.appendChild(el('div', 'scoreroll__empty', '(empty part)')); return; }
    var color = profile.color || '#b08bff';
    var beatMs = 60000 / ((curScore && curScore.tempo) || 120);
    var PXMS = 0.09, startX = 56, half = 7;   // half = px per staff step

    // Spell each note first (its accidental sets its staff position), then size.
    var info = [], prev = null, minS = Infinity, maxS = -Infinity, endMs = 0;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i], sp = spell(n.m, prev), st = stepFromSpell(sp);
      info.push({ m: n.m, d: n.d || 200, t: n.t, step: st, acc: sp.acc });
      if (st < minS) minS = st; if (st > maxS) maxS = st;
      var e = n.t + (n.d || 200); if (e > endMs) endMs = e;
      prev = n.m;
    }
    var topPad = 28 + Math.max(0, maxS - 8) * half;          // room for high ledger notes
    var baseY = topPad + 8 * half;                           // y of step 0 (bottom line)
    function yOf(st) { return baseY - st * half; }
    sheet.style.height = Math.round(baseY + Math.max(0, -minS) * half + 28) + 'px';

    for (var li = 0; li <= 8; li += 2) {                     // 5 staff lines
      var line = el('div', 'staffline'); line.style.top = yOf(li) + 'px'; sheet.appendChild(line);
    }
    var clef = el('div', 'clef', '𝄞'); clef.style.top = (yOf(8) - 8) + 'px'; sheet.appendChild(clef);

    // Place notes by time, but reserve space for accidentals: a ♯/♭ sits in the
    // gap to the LEFT of its own notehead; if that gap would collide with the
    // previous note, push this note (and, via the running offset, every note
    // after it) to the right so the accidental never lands on the prior note.
    var extra = 0, prevRight = startX - 8, lastX = startX;
    for (var j = 0; j < info.length; j++) {
      var it = info[j], y = yOf(it.step), v = noteValue(it.d / beatMs), k;
      var accW = it.acc ? 15 : 0;
      var x = startX + it.t * PXMS + extra;
      var clusterLeft = x - accW - (it.acc ? 4 : 0);         // left edge incl. accidental
      if (clusterLeft < prevRight + 5) { var push = (prevRight + 5) - clusterLeft; extra += push; x += push; }

      if (it.step < 0) for (k = -2; k >= it.step; k -= 2) addLedger(sheet, x, yOf(k));
      if (it.step > 8) for (k = 10; k <= it.step; k += 2) addLedger(sheet, x, yOf(k));
      if (it.acc) { var acc = el('div', 'accidental', it.acc === 'b' ? '♭' : '♯'); acc.style.left = (x - 14) + 'px'; acc.style.top = (y - 9) + 'px'; sheet.appendChild(acc); }
      var up = it.step < 4;
      if (v.stem) {
        var stemX = up ? x + 11 : x, stem = el('div', 'stem');
        stem.style.background = color; stem.style.left = stemX + 'px'; stem.style.top = (up ? y - 28 : y + 4) + 'px';
        sheet.appendChild(stem);
        for (var f = 0; f < v.flags; f++) {
          var fl = el('div', 'flag'); fl.style.background = color; fl.style.left = stemX + 'px';
          fl.style.top = (up ? (y - 28 + f * 6) : (y + 27 - f * 6)) + 'px';
          sheet.appendChild(fl);
        }
      }
      var head = el('div', 'notehead' + (v.open ? ' notehead--open' : ''));
      head.style.left = x + 'px'; head.style.top = (y - 5) + 'px'; head.style.color = color;
      if (!v.open) head.style.background = color;
      head.appendChild(el('span', 'notehead__lbl', I.noteName(it.m)));
      makeTappable(head, it.m, it.d);
      sheet.appendChild(head);

      prevRight = x + 17; lastX = x;
    }
    sheet.style.width = Math.round(lastX + 60) + 'px';
  }

  // One-octave keyboard pinned at the bottom of the sheet frame. The key for a
  // played pitch-class lights up; tapping a key plays that note (octave 4).
  function buildKeyboard() {
    var kb = el('div', 'piano');
    pianoKeys = {};
    [0, 2, 4, 5, 7, 9, 11].forEach(function (pc) {
      var k = el('button', 'pkey pkey--w'); k.type = 'button';
      k.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); kbPlay(pc); });
      pianoKeys[pc] = k; kb.appendChild(k);
    });
    var blackAfter = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };   // pc → index of white key it sits after
    Object.keys(blackAfter).forEach(function (pcStr) {
      var pc = +pcStr, k = el('button', 'pkey pkey--b'); k.type = 'button';
      k.style.left = ((blackAfter[pc] + 1) * (100 / 7)) + '%';
      k.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); kbPlay(pc); });
      pianoKeys[pc] = k; kb.appendChild(k);
    });
    return kb;
  }
  function animateKey(pc) {
    var k = pianoKeys[pc]; if (!k) return;
    k.classList.remove('pkey--lit'); void k.offsetWidth; k.classList.add('pkey--lit');
  }
  function kbPlay(pc) { playScoreNote(60 + pc, 450); }

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
    if (pos != null && pos >= 0) lastPosWhileRunning = pos;   // for the end-of-piece payoff
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

    var pxPerMs = (gateY - top) / LOOKAHEAD;   // shared note speed → duration in px
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
      // Sustain bar trailing UP from the head: its length is the note's scored
      // duration, so you can read how long to hold the sound (mirrors Free Play).
      var durPx = (s.d || 0) * pxPerMs;
      if (durPx > 4 * dpr) {
        var bw = 9 * dpr;
        ctx.globalAlpha = s.consumed ? 0.12 : 0.4;
        ctx.fillStyle = col;
        rrect(ctx, x - bw / 2, y - durPx, bw, durPx, bw / 2); ctx.fill();
      }
      ctx.globalAlpha = s.consumed ? 0.25 : 1;
      ctx.fillStyle = (s.result === 1) ? '#2ecc71' : col;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = 'bold ' + (12 * dpr) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(I.noteName(s.m), x, y);
    }
  }

  // Rounded-rect path (ctx.roundRect isn't available on older mobile Safari).
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ===========================================================================
  // Ambient notes from other musicians (shared visualization)
  // ===========================================================================
  function spawnLocalNote(midi, correct) { spawnNote(profile.color, correct); }
  function spawnNote(color, correct, name) {
    var n = el('div', 'fx-note');
    n.appendChild(el('span', null, Math.random() < 0.5 ? '♪' : '♫'));
    if (name) n.appendChild(el('span', 'fx-note__who', name));   // attribute it to a musician
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
    renderRoster();
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
    var color = '#b08bff', name = '';
    if (lastState && lastState.players) {
      for (var i = 0; i < lastState.players.length; i++) if (lastState.players[i].id === evt.playerId) { color = lastState.players[i].color; name = lastState.players[i].name || ''; break; }
    }
    pulseRoster(evt.playerId);
    // Attribute the burst by name on correct notes only (keeps it readable).
    spawnNote(color, !!evt.correct, evt.correct ? name : '');
  }

  // ---- Live roster: the other musicians, a chip pulsing when they play ------
  function renderRoster() {
    if (!els.roster) return;
    var players = (lastState && lastState.players) ? lastState.players.filter(function (p) {
      return p.online && p.id !== myId && (!lastState.adminId || p.id !== lastState.adminId);
    }) : [];
    if (!players.length) { els.roster.hidden = true; els.roster.innerHTML = ''; rosterEls = {}; return; }
    els.roster.hidden = false;
    els.roster.innerHTML = ''; rosterEls = {};
    players.forEach(function (p) {
      var chip = el('div', 'rchip');
      var dot = el('span', 'rchip__dot'); dot.style.background = p.color || '#888';
      chip.appendChild(dot);
      chip.appendChild(el('span', 'rchip__name', p.name || '🎵'));
      els.roster.appendChild(chip);
      rosterEls[p.id] = chip;
    });
  }
  function pulseRoster(pid) {
    var chip = rosterEls[pid]; if (!chip) return;
    chip.classList.remove('rchip--play'); void chip.offsetWidth; chip.classList.add('rchip--play');
  }

  // ---- Reactions: emoji bursts fanned out to every screen -------------------
  function onReact(evt) {
    if (!evt || !evt.emoji) return;
    if (evt.playerId === myId) return;             // our own taps burst locally already
    spawnReaction(evt.emoji);
  }
  function spawnReaction(emoji) {
    var n = el('div', 'fx-react', emoji);
    n.style.left = (8 + Math.random() * 84) + 'vw';
    document.body.appendChild(n);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 1800);
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
    // Hide the reaction bar while actively playing (it would overlap the pad /
    // Free Play canvas) — reactions are for the lobby and between songs.
    if (els.reactbar) {
      var playing = (mode === 'FREEPLAY') || (transport().running && (mode === 'ALONG' || mode === 'DRIVEN'));
      els.reactbar.hidden = !!playing;
    }
  }
  function modeLabel(m) { return ({ LOBBY: 'Lobby', FREE: 'Test Play', FREEPLAY: 'Free Play', ALONG: 'Play Along', DRIVEN: 'Follow Notes', LISTEN: 'Listen Only', SCORE: 'Read Score' })[m] || m; }
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
    els.roster  = $('roster');
    els.reactbar = $('reactbar');
    if (els.claimHost) els.claimHost.addEventListener('click', function () { window.location.href = '/admin'; });

    // Reaction buttons: burst locally for instant feedback, fan out to everyone.
    if (els.reactbar) els.reactbar.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-emoji]'); if (!b) return;
      var emoji = b.getAttribute('data-emoji');
      spawnReaction(emoji); haptic(10);
      if (conn) conn.send({ t: 'react', emoji: emoji });
    });

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

    conn = NET.connect({ role: 'player', onState: onState, onNote: onNote, onReact: onReact, onWelcome: onWelcome, onError: onError });
  });
})();
