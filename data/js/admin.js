// Maestro C3 — conductor (admin) UI.
//
// The podium: select a piece, choose a mode, assign musicians to voices, and
// drive the transport. In ALONG mode this device also plays the piece as an
// audible guide for the first `introMs`, then fades out (scheduled sample-
// accurately through a Web Audio fade bus). A live cue shows who plays what
// ~1.5 s ahead so the conductor can direct the room.
//
// No frameworks / no modules. Talks to /ws via Maestro.net; see WsHub.h.
(function () {
  'use strict';

  var I = null, NET = null;
  var CUE_AHEAD = 1500;   // conductor sees upcoming notes this far ahead (spec)

  var els = {};
  var conn = null, myId = null, amAdmin = false;
  var pendingState = null, lastState = null;
  var scoresList = [];
  var curScoreId = '', curScore = '';   // curScore = fetched object once loaded
  var cardsById = {};
  var live = {};           // playerId -> {hits,misses}  (live tally this run)
  var runKey = 0;
  var autoStopSent = false; // end-of-piece auto-stop fired for the current run?

  // Guide / accompaniment playback. `guideReady` means every instrument in the
  // score is precomputed (needed for the ALONG lead-in guide AND for auto-fill).
  var guideReady = false, guideInstruments = [];
  var schedKey = -1;                     // startAtMs we last scheduled audio for
  var guideSources = [], fadeBus = null; // ALONG lead-in guide (fades after intro)
  var fillSources = [], fillBus = null;  // auto-played empty voices (full piece)
  var autofillOn = false;                // "auto-play empty parts" toggle

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // ===========================================================================
  // Bootstrap
  // ===========================================================================
  document.addEventListener('DOMContentLoaded', function () {
    NET = window.Maestro.net; I = window.Maestro.instruments;
    els.main = $('podium'); els.notAdmin = $('not-admin');
    els.status = $('status'); els.modePill = $('mode-pill');
    els.scoreRow = $('score-row'); els.modeRow = $('mode-row');
    els.btnStart = $('btn-start'); els.btnStop = $('btn-stop');
    els.btnListenMaster = $('btn-listen-master'); els.btnListenPlayers = $('btn-listen-players');
    els.transport = $('transport-bar'); els.tStatus = $('transport-status');
    els.grid = $('player-grid'); els.empty = $('empty-msg');
    els.cue = $('cue'); els.cueList = $('cue-list');
    els.btnAuto = $('btn-auto'); els.btnReload = $('btn-reload');
    els.assignBar = $('assign-bar'); els.chkAutofill = $('chk-autofill');

    try { autofillOn = localStorage.getItem('maestro.autofill') === '1'; } catch (e) {}
    if (els.chkAutofill) els.chkAutofill.checked = autofillOn;

    els.main.hidden = false; els.notAdmin.hidden = true;

    buildModeButtons();
    installHandlers();
    document.body.addEventListener('pointerdown', function () { I.unlock(); }, { once: true });

    NET.fetchScores().then(function (list) { scoresList = list || []; buildScoreCards(); });

    conn = NET.connect({ role: 'admin', onWelcome: onWelcome, onState: onState, onNote: onNote, onStats: onStats, onError: onError });
    requestAnimationFrame(frame);
  });

  // ===========================================================================
  // Controls
  // ===========================================================================
  function buildScoreCards() {
    els.scoreRow.innerHTML = '';
    scoresList.forEach(function (s) {
      var c = el('button', 'score-card'); c.type = 'button'; c.setAttribute('data-score', s.id);
      c.appendChild(el('div', 'score-card__title', s.title));
      c.appendChild(el('div', 'score-card__composer', s.composer || ''));
      if (s.parts) c.appendChild(el('div', 'score-card__parts', '🎻 ' + s.parts + (s.parts > 1 ? ' parts' : ' part')));
      c.addEventListener('click', function () { if (curScoreId !== s.id) send({ t: 'selectScore', scoreId: s.id }); });
      els.scoreRow.appendChild(c);
    });
    markScoreCards();
  }
  function markScoreCards() {
    var n = els.scoreRow.querySelectorAll('.score-card');
    for (var i = 0; i < n.length; i++) n[i].classList.toggle('score-card--sel', n[i].getAttribute('data-score') === curScoreId);
  }

  var MODES = [
    ['FREEPLAY', '🎶 Free Play',   'Touch to make music'],
    ['FREE',     '🎲 Test Play',   'Tap = random note'],
    ['ALONG',    '🎺 Play Along',  'Follow the conductor'],
    ['DRIVEN',   '🎯 Follow Notes', 'Catch falling notes'],
    ['LISTEN',   '🎧 Listen Only', 'Auto-play the piece']
  ];
  function buildModeButtons() {
    els.modeRow.innerHTML = '';
    MODES.forEach(function (mdef) {
      var b = el('button', 'mode-card'); b.type = 'button'; b.setAttribute('data-mode', mdef[0]);
      b.appendChild(el('div', 'mode-card__title', mdef[1]));
      b.appendChild(el('div', 'mode-card__sub', mdef[2]));
      b.addEventListener('click', function () { send({ t: 'setMode', mode: mdef[0] }); });
      els.modeRow.appendChild(b);
    });
  }
  function markModeButtons() {
    var mode = (lastState && lastState.mode) || 'LOBBY';
    var n = els.modeRow.querySelectorAll('.mode-card');
    for (var i = 0; i < n.length; i++) n[i].classList.toggle('mode-card--sel', n[i].getAttribute('data-mode') === mode);
  }

  function installHandlers() {
    els.btnStart.addEventListener('click', function () { if (!els.btnStart.disabled) { I.unlock(); send({ t: 'start' }); } });
    els.btnStop.addEventListener('click', function () { send({ t: 'stop' }); });
    els.btnListenMaster.addEventListener('click', function () {
      if (els.btnListenMaster.disabled) return; I.unlock(); send({ t: 'start', target: 'master' });
    });
    els.btnListenPlayers.addEventListener('click', function () {
      if (els.btnListenPlayers.disabled) return; send({ t: 'start', target: 'players' });
    });
    els.btnAuto.addEventListener('click', autoAssign);
    if (els.btnReload) els.btnReload.addEventListener('click', function () { location.reload(); });
    if (els.chkAutofill) els.chkAutofill.addEventListener('change', function () {
      autofillOn = els.chkAutofill.checked;
      try { localStorage.setItem('maestro.autofill', autofillOn ? '1' : '0'); } catch (e) {}
      I.unlock();
      var tr = (lastState && lastState.transport) || {};
      if (tr.running) { schedKey = -1; handleTransport(); }   // reschedule live
      renderAll();
    });
  }

  // ===========================================================================
  // WS handlers
  // ===========================================================================
  function onWelcome(msg) {
    myId = msg.yourId || NET.clientId();
    if (msg.yourRole !== 'admin') { window.location.replace('/'); return; }
    amAdmin = true;
    if (pendingState) { var s = pendingState; pendingState = null; applyState(s); }
  }
  function onState(msg) { if (!amAdmin) { pendingState = msg; return; } applyState(msg); }

  function applyState(s) {
    lastState = s;

    if (s.scoreId !== curScoreId) {
      curScoreId = s.scoreId || ''; curScore = ''; markScoreCards();
      guideReady = false; guideInstruments = [];
      if (curScoreId) {
        var wantId = curScoreId;
        NET.fetchScore(wantId).then(function (sc) {
          if (curScoreId !== wantId) return;
          curScore = sc; prepareGuide(sc); renderAll();
        });
      }
    }

    // Reset live tallies when a new run starts.
    var tr = s.transport || {};
    var key = tr.running ? tr.startAtMs : 0;
    if (key !== runKey) { runKey = key; live = {}; autoStopSent = false; }

    markScoreCards(); markModeButtons();
    handleTransport();
    renderAll();
  }

  function onNote(evt) {
    if (!evt || !evt.playerId) return;
    var lv = live[evt.playerId] || (live[evt.playerId] = { hits: 0, misses: 0 });
    if (evt.correct) lv.hits++; else lv.misses++;
    var card = cardsById[evt.playerId];
    if (card) {
      card.root.classList.remove('note-hit', 'note-miss');
      void card.root.offsetWidth;
      card.root.classList.add(evt.correct ? 'note-hit' : 'note-miss');
      updateCardStats(card, evt.playerId);
    }
  }

  function onStats(msg) {
    var online = 0, total = 0;
    if (lastState && lastState.players) { total = lastState.players.length; lastState.players.forEach(function (p) { if (p.online) online++; }); }
    els.status.textContent = online + '/' + total + ' musicians · up ' + fmtUptime(msg.uptimeMs) + ' · ' + fmtBytes(msg.heapFree) + ' free' + (conn && conn.synced() ? ' · synced' : '');
  }
  function onError(msg) { console.warn('[Maestro] err', msg && msg.code, msg && msg.msg); }

  // ===========================================================================
  // Rendering
  // ===========================================================================
  function renderAll() {
    var mode = (lastState && lastState.mode) || 'LOBBY';
    els.modePill.textContent = ({ LOBBY: 'Lobby', FREE: 'Test Play', FREEPLAY: 'Free Play', ALONG: 'Play Along', DRIVEN: 'Follow Notes', LISTEN: 'Listen Only' })[mode] || mode;
    els.modePill.className = 'modepill modepill--' + mode.toLowerCase();

    var listen = (mode === 'LISTEN');
    var timed = (mode === 'ALONG' || mode === 'DRIVEN' || listen);
    els.transport.hidden = !timed;
    els.assignBar.hidden = !timed;
    els.cue.hidden = (mode !== 'ALONG');

    if (els.chkAutofill) els.chkAutofill.checked = autofillOn;
    var tr = (lastState && lastState.transport) || {};

    // Normal Start (ALONG/DRIVEN) vs the two Listen-Only buttons.
    els.btnStart.hidden = listen;
    els.btnListenMaster.hidden = !listen;
    els.btnListenPlayers.hidden = !listen;

    var needReady = (mode === 'ALONG') || autofillOn;    // master-played audio for ALONG/DRIVEN?
    els.btnStart.disabled = listen || !curScoreId || tr.running || (needReady && !guideReady);
    // "Play on Master" needs all instruments tuned here; "Play on Players" lets
    // each phone tune its own, so it only needs a piece selected.
    els.btnListenMaster.disabled  = !(listen && curScoreId && !tr.running && guideReady);
    els.btnListenPlayers.disabled = !(listen && curScoreId && !tr.running);
    els.btnStop.disabled = !tr.running;

    var tuning = (needReady || (listen && !guideReady)) && curScoreId && !guideReady;
    if (tuning) els.tStatus.textContent = 'Tuning instruments…';
    else if (!tr.running) els.tStatus.textContent = timed ? (curScoreId ? 'Ready' : 'Pick a piece') : '';

    renderGrid();
  }

  function renderGrid() {
    var players = (lastState && lastState.players) || [];
    var lockedBy = '';
    var seen = {};
    var voices = (curScore && curScore.voices) || [];

    for (var i = 0; i < players.length; i++) {
      var p = players[i]; if (!p || !p.id) continue;
      seen[p.id] = true;
      var entry = cardsById[p.id];
      if (!entry) { entry = createCard(p); cardsById[p.id] = entry; els.grid.appendChild(entry.root); }
      updateCard(entry, p, voices);
    }
    for (var k in cardsById) {
      if (!seen[k]) { var d = cardsById[k]; if (d.root.parentNode) d.root.parentNode.removeChild(d.root); delete cardsById[k]; }
    }
    var any = players.length > 0;
    els.empty.hidden = any;
  }

  function createCard(p) {
    var root = el('article', 'pcard'); root.setAttribute('data-pid', p.id);
    var stripe = el('div', 'pcard__stripe'); root.appendChild(stripe);

    var head = el('div', 'pcard__head');
    var icon = el('span', 'pcard__icon', '🎵');
    var name = el('h3', 'pcard__name', '');
    head.appendChild(icon); head.appendChild(name);
    var kick = el('button', 'pcard__kick', '×'); kick.type = 'button'; kick.title = 'Remove';
    kick.addEventListener('click', function () { if (confirm('Remove ' + (name.textContent || 'this musician') + '?')) send({ t: 'kick', playerId: p.id }); });
    head.appendChild(kick);
    root.appendChild(head);

    var sel = el('select', 'pcard__voice');
    sel.addEventListener('change', function () { send({ t: 'assign', pairs: [{ playerId: p.id, voiceId: sel.value }] }); });
    root.appendChild(sel);

    var stats = el('div', 'pcard__stats', '');
    root.appendChild(stats);

    // Shown only on the conductor's OWN card: step down and rejoin as a musician,
    // freeing the podium for anyone else.
    var leave = el('button', 'pcard__leave', '🚪 Step down as conductor'); leave.type = 'button'; leave.hidden = true;
    leave.addEventListener('click', function () {
      if (!confirm('Step down as conductor? The podium opens for anyone, and this device becomes a musician.')) return;
      send({ t: 'resign' });
      window.location.href = '/';     // rejoin as a plain musician
    });
    root.appendChild(leave);

    return { root: root, stripe: stripe, icon: icon, name: name, sel: sel, stats: stats, kick: kick, leave: leave, voicesSig: '' };
  }

  function updateCard(entry, p, voices) {
    entry.name.textContent = (p.name && p.name.length) ? p.name : '(unnamed)';
    entry.icon.textContent = I.icon(p.instrument);
    var color = (p.color && /^#[0-9a-fA-F]{6}$/.test(p.color)) ? p.color : '#888';
    entry.stripe.style.background = color;
    entry.root.classList.toggle('offline', p.online === false);
    entry.root.classList.toggle('is-conductor', lastState && p.id === lastState.adminId);

    // This device's own card: offer "step down" instead of "kick yourself".
    var isMe = (p.id === myId);
    entry.leave.hidden = !isMe;
    entry.kick.hidden = isMe;

    // Voice <select> — rebuild options only when the voice set changes.
    var sig = voices.map(function (v) { return v.id; }).join(',');
    var timed = lastState && (lastState.mode === 'ALONG' || lastState.mode === 'DRIVEN');
    entry.sel.hidden = !timed || voices.length === 0;
    if (entry.voicesSig !== sig) {
      entry.voicesSig = sig;
      entry.sel.innerHTML = '';
      entry.sel.appendChild(new Option('— no part —', ''));
      voices.forEach(function (v) { entry.sel.appendChild(new Option(I.icon(v.instrument) + ' ' + v.name, v.id)); });
    }
    if (entry.sel.value !== (p.voiceId || '')) entry.sel.value = p.voiceId || '';

    updateCardStats(entry, p.id);
  }

  function updateCardStats(entry, pid) {
    var p = playerById(pid);
    var lv = live[pid];
    var hits = (lv ? lv.hits : 0) || (p ? p.hits : 0);
    var miss = (lv ? lv.misses : 0) || (p ? p.misses : 0);
    var tot = hits + miss;
    entry.stats.textContent = tot ? ('🎯 ' + Math.round(hits / tot * 100) + '%  (' + hits + '/' + tot + ')') : '';
  }

  function autoAssign() {
    var voices = (curScore && curScore.voices) || [];
    if (!voices.length || !lastState) return;
    var players = lastState.players.filter(function (p) { return p.online && p.id !== lastState.adminId; });
    if (!players.length) return;
    var pairs = players.map(function (p, i) { return { playerId: p.id, voiceId: voices[i % voices.length].id }; });
    send({ t: 'assign', pairs: pairs });
  }

  // ===========================================================================
  // Transport clock + conductor cue + countdown
  // ===========================================================================
  function scorePos() {
    var tr = (lastState && lastState.transport) || {};
    if (!tr.running || !conn || !conn.synced()) return null;
    return conn.serverNow() - tr.startAtMs;
  }

  function frame() {
    requestAnimationFrame(frame);
    var mode = (lastState && lastState.mode) || 'LOBBY';
    var pos = scorePos();
    var tr = (lastState && lastState.transport) || {};

    if (tr.running) {
      if (pos != null && pos < 0) els.tStatus.textContent = '▶ starting in ' + Math.ceil(-pos / 1000) + '…';
      else if (pos != null) {
        var inIntro = mode === 'ALONG' && pos < (tr.introMs || 0);
        var len = curScore ? curScore.lengthMs : 0;
        if (len && pos > len + 800) {
          els.tStatus.textContent = '🎉 finished';
          // Stop once at the end so the piece ends at the same moment on every
          // device (one server stop → all clients halt together).
          if (!autoStopSent) { autoStopSent = true; send({ t: 'stop' }); }
        } else {
          els.tStatus.textContent = (inIntro ? '🎺 guiding · ' : '🎶 playing · ') + (pos / 1000).toFixed(1) + 's';
        }
      }
    }

    if (mode === 'ALONG' && !els.cue.hidden) renderCue(pos);
  }

  // Show every musician's upcoming note within CUE_AHEAD ms, soonest first.
  function renderCue(pos) {
    if (pos == null || !curScore) { els.cueList.innerHTML = '<div class="cue-empty">syncing…</div>'; return; }
    var players = (lastState && lastState.players) || [];
    var rows = [];
    players.forEach(function (p) {
      if (!p.voiceId || p.id === lastState.adminId) return;
      var v = findVoice(curScore, p.voiceId); if (!v) return;
      // next note at/after now for this player.
      var next = null;
      for (var i = 0; i < v.notes.length; i++) { if (v.notes[i].t >= pos - 150) { next = v.notes[i]; break; } }
      if (!next) return;
      var dt = next.t - pos;
      if (dt > CUE_AHEAD) return;
      rows.push({ dt: dt, name: p.name || '(unnamed)', color: p.color, note: I.noteName(next.m), now: dt < 180 });
    });
    rows.sort(function (a, b) { return a.dt - b.dt; });
    if (!rows.length) { els.cueList.innerHTML = '<div class="cue-empty">…</div>'; return; }
    var html = rows.map(function (r) {
      return '<div class="cue-item' + (r.now ? ' cue-item--now' : '') + '">' +
        '<span class="cue-dot" style="background:' + esc(r.color) + '"></span>' +
        '<span class="cue-name">' + esc(r.name) + '</span>' +
        '<span class="cue-note">' + esc(r.note) + '</span>' +
        '<span class="cue-when">' + (r.now ? 'NOW' : (r.dt / 1000).toFixed(1) + 's') + '</span></div>';
    }).join('');
    els.cueList.innerHTML = html;
  }

  // ===========================================================================
  // ALONG guide playback (this device plays the piece, then fades)
  // ===========================================================================
  function prepareGuide(score) {
    guideReady = false;
    if (!score || !score.voices) return;
    var seen = {}; guideInstruments = [];
    score.voices.forEach(function (v) { if (v.instrument && !seen[v.instrument]) { seen[v.instrument] = 1; guideInstruments.push(v.instrument); } });
    // Precompute each instrument in series, then mark ready.
    var i = 0;
    (function next() {
      if (i >= guideInstruments.length) { guideReady = true; renderAll(); return; }
      var id = guideInstruments[i++];
      els.tStatus.textContent = 'Tuning ' + I.label(id) + '…';
      I.precompute(id).then(next);
    })();
  }

  // Which voices already have a (live) musician? Everything else is "empty".
  function assignedVoiceIds() {
    var set = {};
    if (lastState && lastState.players) lastState.players.forEach(function (p) {
      if (p.voiceId && p.online && p.id !== lastState.adminId) set[p.voiceId] = true;
    });
    return set;
  }

  function handleTransport() {
    var mode = lastState && lastState.mode;
    var tr = (lastState && lastState.transport) || {};
    // Audio is produced on THIS device for: the ALONG guide, auto-fill, and
    // LISTEN "play on master". All need the instruments precomputed first.
    var needReady = (mode === 'ALONG') || autofillOn || (mode === 'LISTEN' && tr.target === 'master');
    if (tr.running && tr.startAtMs !== schedKey && (!needReady || guideReady)) {
      schedKey = tr.startAtMs;
      scheduleAll(tr);
    }
    if (!tr.running) { schedKey = -1; stopAll(); }
  }

  // Map the server-clock transport start to this device's Web Audio clock.
  function ctxStartFor(tr) {
    var ctx = I.audioCtx();
    var secs = (tr.startAtMs - conn.serverNow()) / 1000;
    return { ctx: ctx, start: ctx.currentTime + Math.max(0, secs) };
  }

  // Schedule a whole voice (all notes, correct pitch + length) on a bus.
  function scheduleVoiceFull(v, ctxStart, gain, bus, sink) {
    var nowCtx = I.audioCtx().currentTime;
    for (var i = 0; i < v.notes.length; i++) {
      var n = v.notes[i];
      var when = ctxStart + n.t / 1000;
      if (when < nowCtx - 0.05) continue;
      var s = I.play(v.instrument, n.m, when, gain, bus, n.d);
      if (s) sink.push(s);
    }
  }

  function scheduleAll(tr) {
    stopAll();
    if (!curScore || !conn) return;
    var a = ctxStartFor(tr), ctx = a.ctx, ctxStart = a.start;
    var mode = lastState.mode;
    var assigned = assignedVoiceIds();

    // Listen Only: "master" → this device plays ALL voices in full; "players" →
    // each phone plays its own part, so the podium stays silent.
    if (mode === 'LISTEN') {
      if (tr.target === 'master') {
        fillBus = ctx.createGain();
        fillBus.gain.value = 0.7;
        fillBus.connect(I.master());
        curScore.voices.forEach(function (v) { scheduleVoiceFull(v, ctxStart, 0.8, fillBus, fillSources); });
      }
      return;
    }

    // ALONG lead-in guide: play the piece for `introMs`, then fade. Voices that
    // auto-fill will carry fully are left out here (so they don't double up).
    if (mode === 'ALONG' && tr.introMs > 0) {
      fadeBus = ctx.createGain();
      fadeBus.gain.value = 0.85;
      fadeBus.connect(I.master());
      var introS = tr.introMs / 1000;
      try {
        fadeBus.gain.setValueAtTime(0.85, ctxStart + Math.max(0, introS - 2));
        fadeBus.gain.linearRampToValueAtTime(0.0001, ctxStart + introS);
      } catch (e) {}
      curScore.voices.forEach(function (v) {
        if (autofillOn && !assigned[v.id]) return;     // auto-fill plays it in full instead
        for (var i = 0; i < v.notes.length; i++) {
          var n = v.notes[i];
          if (n.t > tr.introMs + 200) break;           // only the guided portion
          var s = I.play(v.instrument, n.m, ctxStart + n.t / 1000, 0.6, fadeBus, n.d);
          if (s) guideSources.push(s);
        }
      });
    }

    // Auto-play empty parts: any voice with no musician is performed in full by
    // the podium, with correct pitch and length, for the whole piece.
    if (autofillOn) {
      fillBus = ctx.createGain();
      fillBus.gain.value = 0.6;
      fillBus.connect(I.master());
      curScore.voices.forEach(function (v) {
        if (assigned[v.id]) return;
        for (var i = 0; i < v.notes.length; i++) {
          var n = v.notes[i];
          var s = I.play(v.instrument, n.m, ctxStart + n.t / 1000, 0.85, fillBus, n.d);
          if (s) fillSources.push(s);
        }
      });
    }
  }

  function stopAll() {
    guideSources.forEach(function (s) { try { s.stop(); } catch (e) {} }); guideSources = [];
    fillSources.forEach(function (s) { try { s.stop(); } catch (e) {} }); fillSources = [];
    if (fadeBus) { try { fadeBus.disconnect(); } catch (e) {} fadeBus = null; }
    if (fillBus) { try { fillBus.disconnect(); } catch (e) {} fillBus = null; }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================
  function send(o) { return conn ? conn.send(o) : false; }
  function playerById(id) { if (!lastState || !lastState.players) return null; for (var i = 0; i < lastState.players.length; i++) if (lastState.players[i].id === id) return lastState.players[i]; return null; }
  function findVoice(score, vid) { if (!score || !score.voices) return null; for (var i = 0; i < score.voices.length; i++) if (score.voices[i].id === vid) return score.voices[i]; return null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmtUptime(ms) { if (typeof ms !== 'number') return '—'; var s = Math.floor(ms / 1000), h = Math.floor(s / 3600); s -= h * 3600; var m = Math.floor(s / 60); s -= m * 60; return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's'; }
  function fmtBytes(n) { if (typeof n !== 'number') return '—'; if (n < 1024) return n + 'B'; if (n < 1048576) return (n / 1024).toFixed(0) + 'K'; return (n / 1048576).toFixed(1) + 'M'; }
})();
