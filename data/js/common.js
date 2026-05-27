// Maestro C3 — shared helpers (used by both player.js and admin.js).
// No DOM assumptions, no modules. Attaches everything to window.Maestro.net.
//
// Beyond the WebSocket plumbing (lifted from QuizHub), this adds two things the
// orchestra needs: score fetching (sheet music is static JSON under /scores/)
// and an NTP-style clock sync so every phone agrees on the transport timeline.
(function () {
  'use strict';

  var CLIENT_ID_KEY = 'maestro.clientId';
  var PROFILE_KEY   = 'maestro.profile';

  // ---- UUID v4 (fallback when no server cookie) ----------------------------
  function uuidv4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID(); } catch (e) { /* fall through */ }
    }
    var bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var j = 0; j < 16; j++) {
      var h = bytes[j].toString(16);
      if (h.length < 2) h = '0' + h;
      hex.push(h);
    }
    return hex[0]+hex[1]+hex[2]+hex[3]+'-'+hex[4]+hex[5]+'-'+hex[6]+hex[7]+'-'+
           hex[8]+hex[9]+'-'+hex[10]+hex[11]+hex[12]+hex[13]+hex[14]+hex[15];
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function clientId() {
    // Prefer the server-issued cookie (survives localStorage wipes / private mode).
    var c = readCookie('mz_id');
    if (c) return c;
    var id = null;
    try { id = localStorage.getItem(CLIENT_ID_KEY); } catch (e) {}
    if (!id) {
      id = uuidv4();
      try { localStorage.setItem(CLIENT_ID_KEY, id); } catch (e) {}
    }
    return id;
  }

  // ---- Profile (localStorage cache) ----------------------------------------
  function loadProfile() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return {};
      var p = JSON.parse(raw);
      return (p && typeof p === 'object') ? p : {};
    } catch (e) { return {}; }
  }

  function saveProfile(p) {
    try {
      var prev = loadProfile();
      localStorage.setItem(PROFILE_KEY, JSON.stringify({
        name:       (p && p.name       != null) ? p.name       : prev.name,
        color:      (p && p.color      != null) ? p.color      : prev.color,
        instrument: (p && p.instrument != null) ? p.instrument : prev.instrument
      }));
    } catch (e) {}
  }

  // ---- Scores ---------------------------------------------------------------
  var _scoresPromise = null;
  function fetchScores() {
    if (_scoresPromise) return _scoresPromise;
    _scoresPromise = fetch('/scores/manifest.json')
      .then(function (r) { if (!r.ok) throw new Error('manifest HTTP ' + r.status); return r.json(); })
      .then(function (d) { return Array.isArray(d) ? d : []; })
      .catch(function (err) {
        _scoresPromise = null;
        console.warn('[Maestro] fetchScores failed:', err);
        return [];
      });
    return _scoresPromise;
  }

  var _scoreCache = {};
  function fetchScore(id) {
    if (!id) return Promise.resolve(null);
    if (_scoreCache[id]) return _scoreCache[id];
    _scoreCache[id] = fetch('/scores/' + id + '.json')
      .then(function (r) { if (!r.ok) throw new Error('score HTTP ' + r.status); return r.json(); })
      .catch(function (err) {
        delete _scoreCache[id];
        console.warn('[Maestro] fetchScore failed:', id, err);
        return null;
      });
    return _scoreCache[id];
  }

  // ---- WebSocket connection with auto-reconnect + clock sync ---------------
  function connect(opts) {
    opts = opts || {};
    var role = opts.role || 'player';
    var closed = false;
    var ws = null;
    var backoff = 250;
    var reconnectTimer = null;
    var syncTimer = null;

    // Clock sync: offset = serverClock - localClock (both ms). We keep the
    // estimate from the lowest round-trip probe (least jitter), letting the best
    // RTT decay slowly so a better sample can win later.
    var offset = 0;
    var bestRtt = Infinity;
    var haveSync = false;

    function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
    function serverNow() { return now() + offset; }

    function dispatch(msg) {
      switch (msg.t) {
        case 'state':   if (opts.onState)   opts.onState(msg);   break;
        case 'note':    if (opts.onNote)    opts.onNote(msg);    break;
        case 'react':   if (opts.onReact)   opts.onReact(msg);   break;
        case 'welcome': if (opts.onWelcome) opts.onWelcome(msg); break;
        case 'stats':   if (opts.onStats)   opts.onStats(msg);   break;
        case 'error':   if (opts.onError)   opts.onError(msg);   break;
        case 'tsync':   onTsync(msg);                            break;
        default:        /* forward-compat: ignore unknown t */   break;
      }
    }

    function onTsync(msg) {
      var c0 = msg.c0;
      var s  = msg.s;
      if (typeof c0 !== 'number' || typeof s !== 'number') return;
      var rtt = now() - c0;
      if (rtt < 0) rtt = 0;
      // Slowly forget the previous best so we re-adapt to clock drift / route changes.
      bestRtt *= 1.05;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        offset = (s + rtt / 2) - now();
        haveSync = true;
        if (opts.onSync) opts.onSync({ offset: offset, rtt: rtt });
      }
    }

    function sendSync() { send({ t: 'tsync', c0: Math.round(now()) }); }

    function open() {
      if (closed) return;
      var url = 'ws://' + location.host + '/ws';
      try { ws = new WebSocket(url); }
      catch (e) { console.warn('[Maestro] WS construct failed:', e); scheduleReconnect(); return; }

      ws.onopen = function () {
        backoff = 250;
        try { ws.send(JSON.stringify({ t: 'hello', role: role, clientId: clientId() })); }
        catch (e) {}
        // Burst a few sync probes to converge fast, then keep a slow heartbeat.
        bestRtt = Infinity;
        sendSync();
        setTimeout(sendSync, 150);
        setTimeout(sendSync, 350);
        if (syncTimer) clearInterval(syncTimer);
        syncTimer = setInterval(sendSync, 2500);
      };

      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && typeof msg.t === 'string') dispatch(msg);
      };

      ws.onerror = function () { /* onclose handles reconnect */ };

      ws.onclose = function () {
        ws = null;
        if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
        if (!closed) scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        backoff = Math.min(backoff * 2, 5000);
        open();
      }, backoff);
    }

    function send(obj) {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(JSON.stringify(obj)); return true; }
      catch (e) { return false; }
    }

    function close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    }

    open();
    return {
      send: send,
      close: close,
      serverNow: serverNow,
      synced: function () { return haveSync; },
      rtt: function () { return bestRtt; }
    };
  }

  // ---- Export ---------------------------------------------------------------
  window.Maestro = window.Maestro || {};
  window.Maestro.net = {
    clientId: clientId,
    connect: connect,
    fetchScores: fetchScores,
    fetchScore: fetchScore,
    loadProfile: loadProfile,
    saveProfile: saveProfile
  };
})();
