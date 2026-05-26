// =============================================================================
// Maestro C3 — WebSocket Hub
// =============================================================================
//
// This file FREEZES the WebSocket JSON protocol shared by three layers: the
// server FSM (GameState/WsHub), the musician UI (data/js/player.js), and the
// conductor UI (data/js/admin.js). Do NOT change a field name or shape here
// without coordinated updates in all three. Receivers MUST ignore unknown `t`
// values (forward compatibility).
//
// Transport: a single endpoint at  ws://<host>/ws  (host = 192.168.4.1 on AP,
// or maestro.local via mDNS). All frames are TEXT frames carrying a JSON object
// with a string discriminator field `t`.
//
// -----------------------------------------------------------------------------
// AUDIO & TIMING MODEL (why the protocol looks like this)
// -----------------------------------------------------------------------------
// The ESP32-C3 cannot synthesize and stream audio to 16 phones, so it doesn't
// try. Each phone is an INSTRUMENT: it precomputes its timbre's note buffers in
// the browser (Web Audio) at launch and plays them locally. The server only:
//   * holds the authoritative session state (mode, selected score, who plays
//     which voice) and broadcasts it as a snapshot, and
//   * owns the master TRANSPORT clock so every phone starts together.
// Sheet music itself is static JSON under /scores/ — fetched over HTTP and
// cached by each browser — so it never travels over the WebSocket.
//
// Clock sync: the transport start time is expressed in the server's millis()
// clock. Each client runs a tiny NTP-style handshake ("tsync") to learn the
// offset between its own clock and the server's, then converts the start time
// to its local clock. LAN round-trips are sub-50 ms, comfortably inside the
// ±500 ms "in sync" window the game judges against.
//
// -----------------------------------------------------------------------------
// CLIENT  →  SERVER
// -----------------------------------------------------------------------------
//
//   { "t": "hello", "role": "player"|"admin", "clientId": "<id>" }
//     - First message after WS open. The server assigns the conductor (admin)
//       role to the FIRST claimant of role="admin"; later claims are silently
//       demoted to "player".
//
//   { "t": "setProfile", "name":"<str>", "color":"<#rrggbb>", "instrument":"<id>" }
//     - Musician updates their own profile. `instrument` is an id from
//       data/js/instruments.js. Persisted to NVS keyed by clientId.
//
//   { "t": "tsync", "c0": <client clock ms> }
//     - Clock-sync probe. Server echoes it back with its own clock (below),
//       unicast. Sent periodically by every client.
//
//   { "t": "play", "midi": <int 0-127>, "correct": <bool>, "voiceId":"<str>" }
//     - Musician played a note (a button tap / gate hit). The browser already
//       sounded it locally; this is fan-out for the shared visualization and
//       per-player hit/miss stats. `correct` is the client's own timing verdict
//       (it has the best local timing); the server trusts it for stats.
//
//   --- conductor (admin) only ---
//   { "t": "selectScore", "scoreId": "<id>" }     // load a piece (stops transport)
//   { "t": "setMode", "mode": "FREE"|"FREEPLAY"|"ALONG"|"DRIVEN"|"LISTEN" }  // (stops transport)
//        - FREE = "Test Play" (tap → random note); FREEPLAY = "Free Play"
//          (multi-touch falling-note instrument, judged client-side); LISTEN =
//          "Listen Only" (the piece auto-plays, no tapping).
//   { "t": "assign", "pairs": [ {"playerId":"<id>","voiceId":"<str>"}, ... ] }
//        - Assign musicians to score voices (voiceId "" clears). The conductor
//          UI computes the distribution (it has the score); the server stores
//          the voiceId strings opaquely.
//   { "t": "start", "target": "master"|"players" }   // begin the transport
//        - Lead-in countdown, then RUNNING. `target` applies only to LISTEN:
//          "master" = conductor device auto-plays all voices; "players" = each
//          musician device auto-plays its assigned voice. Ignored otherwise.
//   { "t": "stop"  }   // RUNNING -> IDLE
//   { "t": "resign" }  // conductor steps down → seat freed immediately for anyone
//   { "t": "kick", "playerId": "<id>" }
//
// -----------------------------------------------------------------------------
// SERVER  →  CLIENT  (broadcast to all unless noted)
// -----------------------------------------------------------------------------
//
//   { "t": "state",
//     "mode":    "LOBBY"|"FREE"|"FREEPLAY"|"ALONG"|"DRIVEN"|"LISTEN",
//     "scoreId": "<id or empty>",
//     "adminId": "<clientId of conductor, empty if none>",
//     "transport": {
//        "running":  <bool>,
//        "startAtMs":<server-clock ms at score position 0; 0 if stopped>,
//        "introMs":  <ms the conductor device guides before fading (ALONG=10000)>,
//        "target":   "master"|"players"|""   // LISTEN auto-play target
//     },
//     "players": [
//       { "id":"<id>", "name":"<str>", "color":"<#rrggbb>",
//         "instrument":"<id>", "voiceId":"<str or empty>",
//         "online":<bool>, "hits":<uint>, "misses":<uint>, "notes":<uint> },
//       ...
//     ]
//   }
//     - Full authoritative snapshot, broadcast on EVERY state change. UIs are
//       pure projections of the latest snapshot (a hard refresh is always safe).
//
//   { "t": "tsync", "c0": <echoed client clock>, "s": <server clock ms> }
//     - Unicast reply to a "tsync" probe. Client computes:
//          rtt    = clientNow - c0
//          offset = (s + rtt/2) - clientNow      // serverClock - clientClock
//       keeping the estimate from the lowest-rtt probe.
//
//   { "t": "note", "playerId":"<id>", "midi":<int>, "correct":<bool>,
//     "voiceId":"<str>" }
//     - Edge event fanned out when any musician plays, for the conductor's
//       live "orchestra activity" view and other phones' ambient note bursts.
//
//   { "t": "welcome", "yourRole":"player"|"admin", "yourId":"<id>" }
//     - Unicast response to "hello". Confirms the role actually assigned.
//
//   { "t": "stats", "uptimeMs":<uint>, "heapFree":<uint> }
//     - Periodic (WS_STATS_INTERVAL_MS). Drives the conductor's status line.
//
//   { "t": "error", "code":"<short>", "msg":"<human readable>" }
//     - Unicast when a client message is rejected. Non-fatal.
//
// =============================================================================

#pragma once

#include <ESPAsyncWebServer.h>

namespace WsHub {

// Wire up the /ws endpoint on `server` and attach `ws.onEvent(...)`.
// `ws` MUST outlive the AsyncWebServer (typically a file-scope global).
void install(AsyncWebServer& server, AsyncWebSocket& ws);

// Drive periodic broadcasts (stats fan-out, stale-admin reaping). Call from loop().
void tick();

} // namespace WsHub
