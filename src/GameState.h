// Maestro C3 — authoritative session state.
//
// All mutable orchestra/session data lives here: the musician table, the
// session mode, the selected score id, the master transport clock, and which
// clientId currently holds the conductor (admin) role.
//
// Concurrency: ESPAsyncWebServer dispatches WS events on the AsyncTCP task,
// while WsHub::tick() runs on the Arduino loop task. Both touch this state, so
// every multi-field mutation is guarded by a portMUX_TYPE spinlock. Critical
// sections are tiny (no JSON / no network calls inside them).
//
// Identity vs. socket: a Player is keyed by `clientId` (stable, browser-side).
// The `wsClientId` is the per-socket numeric id AsyncWebSocket assigns; it
// changes across reconnects but is what we use to address a single socket.

#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>

#include "Config.h"

struct Player {
    bool     used        = false;          // slot occupied?
    String   clientId;                     // stable id from the browser
    String   name;
    String   color;                        // "#rrggbb"
    String   instrument;                   // id from data/js/instruments.js
    String   voiceId;                      // assigned score voice ("" = none)
    bool     online      = false;
    uint32_t lastSeenMs  = 0;
    uint32_t wsClientId  = 0;              // 0 == not currently connected

    // Per-session play stats (cleared when a new transport run starts).
    uint32_t notes  = 0;                   // notes played this run
    uint32_t hits   = 0;                   // notes judged in-sync by the client
    uint32_t misses = 0;                   // notes judged out-of-sync
};

enum class Mode : uint8_t { LOBBY, FREE, ALONG, DRIVEN };

class GameState {
public:
    GameState();

    // --- lookups ------------------------------------------------------------
    Player* findById(const String& clientId);
    Player* findByWsId(uint32_t wsClientId);

    // --- session lifecycle --------------------------------------------------
    // Creates or refreshes a Player. If `wantAdmin` and there is no current
    // conductor, this client is promoted; otherwise downgraded to "player". The
    // assigned role ("admin"/"player") is written to `assignedRole`. Returns
    // false only if there's no free slot for a brand-new client.
    bool joinOrUpdate(const String& clientId,
                      uint32_t      wsClientId,
                      bool          wantAdmin,
                      String&       assignedRole);

    // Player-initiated profile update. Length-clamps and validates color.
    bool setProfile(const String& clientId,
                    const String& name,
                    const String& color,
                    const String& instrument);

    // --- conductor (admin) actions -----------------------------------------
    bool selectScore(const String& adminClientId, const String& scoreId);
    bool setMode(const String& adminClientId, const String& modeStr);

    // Assign a musician to a score voice ("" clears). Stored opaquely; the
    // conductor UI owns the distribution logic. Returns false for non-admin or
    // unknown target.
    bool assignVoice(const String& adminClientId,
                     const String& targetId,
                     const String& voiceId);

    // Begin the transport: requires a selected score and ALONG/DRIVEN mode.
    // Sets startAtMs = now + COUNTDOWN_MS and introMs per mode, zeroes per-run
    // stats. Returns false if preconditions aren't met.
    bool startTransport(const String& adminClientId);
    bool stopTransport (const String& adminClientId);

    // Record a played note for stats (any mode). `correct` is the client's
    // timing verdict. No-op for unknown clientId.
    void recordNote(const String& clientId, bool correct);

    // Returns the wsClientId of the kicked player (0 if none) so the caller can
    // close that socket; frees the slot so the clientId can rejoin fresh.
    uint32_t kick(const String& adminClientId, const String& targetId);

    // --- WS lifecycle hooks -------------------------------------------------
    void markOffline(uint32_t wsClientId);
    bool expireStaleAdmin();

    // --- serializers --------------------------------------------------------
    void serializeState(JsonObject root);

    // --- accessors ----------------------------------------------------------
    const String& adminId() const { return adminId_; }

private:
    Player   players_[Config::MAX_PLAYERS];

    Mode     mode_      = Mode::LOBBY;
    String   scoreId_;

    bool     running_   = false;
    uint32_t startAtMs_ = 0;
    uint32_t introMs_   = 0;

    String   adminId_;
    uint32_t adminWsClientId_     = 0;
    uint32_t adminOfflineSinceMs_ = 0;   // !=0 → admin socket gone, seat reserved
    uint8_t  colorCursor_         = 0;   // round-robin spread for colour assignment

    portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;

    // Helpers (caller must hold mux_).
    Player* findByIdLocked_(const String& clientId);
    Player* findByWsIdLocked_(uint32_t wsClientId);
    Player* allocateSlotLocked_();
    String  pickFreeColorLocked_();
    void    resetRunStatsLocked_();
};

extern GameState g_game;
