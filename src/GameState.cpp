// Maestro C3 — GameState implementation. See GameState.h for design notes.

#include "GameState.h"

#include "Persistence.h"

GameState g_game;

// =============================================================================
// Small helpers (file scope).
// =============================================================================
namespace {

constexpr size_t kMaxNameLen    = 20;
constexpr size_t kMaxInstrLen   = 24;
constexpr size_t kMaxVoiceLen   = 24;
constexpr size_t kMaxScoreLen   = 40;
constexpr size_t kMaxClientId   = 64;

// Player colour palette — MUST stay in sync with PRESETS in data/js/player.js
// and --p1..--p16 in data/css/style.css. Hue-ordered (16 colours).
const char* const kPalette[] = {
    "#e74c3c", "#e67e22", "#f39c12", "#f1c40f",   // red .. yellow
    "#9bcc00", "#2ecc71", "#16a085", "#1abc9c",   // lime .. teal
    "#00bcd4", "#3498db", "#3f51b5", "#7c4dff",   // cyan .. violet
    "#9b59b6", "#b13ab1", "#e84393", "#ff6b81",   // purple .. rose
};
constexpr size_t kPaletteSize = sizeof(kPalette) / sizeof(kPalette[0]);

// New players are spread around the wheel by advancing a cursor; the stride must
// be coprime with the palette size so every colour is reachable.
constexpr size_t kColorStride = 9;

bool isValidColor(const String& s) {
    if (s.length() != 7 || s[0] != '#') return false;
    for (size_t i = 1; i < 7; ++i) {
        const char c = s[i];
        const bool hex = (c >= '0' && c <= '9') ||
                         (c >= 'a' && c <= 'f') ||
                         (c >= 'A' && c <= 'F');
        if (!hex) return false;
    }
    return true;
}

void clampLen(String& s, size_t maxLen) {
    if (s.length() > maxLen) s.remove(maxLen);
}

const char* modeToStr(Mode m) {
    switch (m) {
        case Mode::FREE:     return "FREE";
        case Mode::FREEPLAY: return "FREEPLAY";
        case Mode::ALONG:    return "ALONG";
        case Mode::DRIVEN:   return "DRIVEN";
        case Mode::LISTEN:   return "LISTEN";
        case Mode::LOBBY:
        default:             return "LOBBY";
    }
}

bool parseMode(const String& s, Mode& out) {
    if      (s == "FREE")     out = Mode::FREE;
    else if (s == "FREEPLAY") out = Mode::FREEPLAY;
    else if (s == "ALONG")    out = Mode::ALONG;
    else if (s == "DRIVEN")   out = Mode::DRIVEN;
    else if (s == "LISTEN")   out = Mode::LISTEN;
    else if (s == "LOBBY")    out = Mode::LOBBY;
    else return false;
    return true;
}

} // anonymous namespace

// =============================================================================
GameState::GameState() = default;

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------
Player* GameState::findByIdLocked_(const String& clientId) {
    if (clientId.length() == 0) return nullptr;
    for (auto& p : players_) {
        if (p.used && p.clientId == clientId) return &p;
    }
    return nullptr;
}

Player* GameState::findByWsIdLocked_(uint32_t wsClientId) {
    if (wsClientId == 0) return nullptr;
    for (auto& p : players_) {
        if (p.used && p.wsClientId == wsClientId) return &p;
    }
    return nullptr;
}

Player* GameState::allocateSlotLocked_() {
    for (auto& p : players_) {
        if (!p.used) return &p;
    }
    return nullptr;
}

String GameState::pickFreeColorLocked_() {
    for (size_t k = 0; k < kPaletteSize; k++) {
        const size_t idx = (colorCursor_ + k) % kPaletteSize;
        bool taken = false;
        for (auto& p : players_) {
            if (p.used && p.color == kPalette[idx]) { taken = true; break; }
        }
        if (!taken) {
            colorCursor_ = (uint8_t)((idx + kColorStride) % kPaletteSize);
            return String(kPalette[idx]);
        }
    }
    return String(kPalette[0]);
}

void GameState::resetRunStatsLocked_() {
    for (auto& p : players_) {
        if (!p.used) continue;
        p.notes = p.hits = p.misses = 0;
    }
}

Player* GameState::findById(const String& clientId) {
    portENTER_CRITICAL(&mux_);
    Player* p = findByIdLocked_(clientId);
    portEXIT_CRITICAL(&mux_);
    return p;
}

Player* GameState::findByWsId(uint32_t wsClientId) {
    portENTER_CRITICAL(&mux_);
    Player* p = findByWsIdLocked_(wsClientId);
    portEXIT_CRITICAL(&mux_);
    return p;
}

// -----------------------------------------------------------------------------
// Join / profile
// -----------------------------------------------------------------------------
bool GameState::joinOrUpdate(const String& clientIdIn,
                             uint32_t      wsClientId,
                             bool          wantAdmin,
                             String&       assignedRole) {
    String clientId = clientIdIn;
    clampLen(clientId, kMaxClientId);
    if (clientId.length() == 0) {
        assignedRole = "player";
        return false;
    }

    // Default profile (overridden if NVS has one).
    String defaultName, defaultColor = "#8b5cf6", defaultInstrument = "piano";
    bool   loadedFromNvs = false;
    {
        String n, c, instr;
        if (Persistence::loadPlayerProfile(clientId, n, c, instr)) {
            defaultName       = n;
            defaultColor      = c;
            defaultInstrument = instr;
            loadedFromNvs = true;
        }
    }

    bool   createdDefault = false;
    String persistName, persistColor, persistInstr;

    portENTER_CRITICAL(&mux_);

    Player* p = findByIdLocked_(clientId);
    if (!p) {
        p = allocateSlotLocked_();
        if (!p) {
            portEXIT_CRITICAL(&mux_);
            assignedRole = "player";
            return false;
        }
        p->used     = true;
        p->clientId = clientId;
        p->voiceId  = "";
        p->notes = p->hits = p->misses = 0;

        if (loadedFromNvs) {
            p->name       = defaultName;
            p->color      = defaultColor;
            p->instrument = defaultInstrument;
        } else {
            // First-ever session: hand the musician a complete, validated profile
            // — "Player N", a unique colour, and the default instrument — then
            // persist it after releasing the lock.
            const int idx = (int)(p - players_) + 1;
            p->name       = String("Player ") + idx;
            p->color      = pickFreeColorLocked_();
            p->instrument = "piano";
            createdDefault = true;
            persistName  = p->name;
            persistColor = p->color;
            persistInstr = p->instrument;
        }
    }

    p->wsClientId = wsClientId;
    p->online     = true;
    p->lastSeenMs = millis();

    // Conductor assignment: first-come-first-served, with reconnect resume.
    if (adminId_ == clientId) {
        adminWsClientId_     = wsClientId;
        adminOfflineSinceMs_ = 0;
        assignedRole         = "admin";
    } else if (wantAdmin && adminId_.length() == 0) {
        adminId_             = clientId;
        adminWsClientId_     = wsClientId;
        adminOfflineSinceMs_ = 0;
        assignedRole         = "admin";
    } else {
        assignedRole         = "player";
    }

    portEXIT_CRITICAL(&mux_);

    if (createdDefault) {
        Persistence::savePlayerProfile(clientId, persistName, persistColor, persistInstr);
    }
    return true;
}

bool GameState::setProfile(const String& clientId,
                           const String& nameIn,
                           const String& colorIn,
                           const String& instrumentIn) {
    String name       = nameIn;
    String color      = colorIn;
    String instrument = instrumentIn;
    clampLen(name,       kMaxNameLen);
    clampLen(instrument, kMaxInstrLen);

    if (!isValidColor(color)) return false;

    {
        portENTER_CRITICAL(&mux_);
        Player* p = findByIdLocked_(clientId);
        if (!p) {
            portEXIT_CRITICAL(&mux_);
            return false;
        }
        // Enforce unique colours (the client hides taken swatches; guard races).
        for (auto& q : players_) {
            if (q.used && &q != p && q.color == color) {
                portEXIT_CRITICAL(&mux_);
                return false;
            }
        }
        p->name       = name;
        p->color      = color;
        p->instrument = instrument;
        p->lastSeenMs = millis();
        portEXIT_CRITICAL(&mux_);
    }

    Persistence::savePlayerProfile(clientId, name, color, instrument);
    return true;
}

// -----------------------------------------------------------------------------
// Conductor actions
// -----------------------------------------------------------------------------
bool GameState::selectScore(const String& adminClientId, const String& scoreIdIn) {
    String scoreId = scoreIdIn;
    clampLen(scoreId, kMaxScoreLen);

    portENTER_CRITICAL(&mux_);
    if (adminClientId.length() == 0 || adminClientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    scoreId_   = scoreId;
    // Changing the piece stops the transport and clears voice assignments — the
    // new score has different parts.
    running_    = false;
    startAtMs_  = 0;
    introMs_    = 0;
    playTarget_ = "";
    for (auto& p : players_) { if (p.used) p.voiceId = ""; }
    portEXIT_CRITICAL(&mux_);
    return true;
}

bool GameState::setMode(const String& adminClientId, const String& modeStr) {
    Mode m;
    if (!parseMode(modeStr, m)) return false;

    portENTER_CRITICAL(&mux_);
    if (adminClientId.length() == 0 || adminClientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    mode_       = m;
    running_    = false;
    startAtMs_  = 0;
    introMs_    = 0;
    playTarget_ = "";
    portEXIT_CRITICAL(&mux_);
    return true;
}

bool GameState::assignVoice(const String& adminClientId,
                            const String& targetId,
                            const String& voiceIdIn) {
    String voiceId = voiceIdIn;
    clampLen(voiceId, kMaxVoiceLen);

    portENTER_CRITICAL(&mux_);
    if (adminClientId.length() == 0 || adminClientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    Player* p = findByIdLocked_(targetId);
    if (!p) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    p->voiceId = voiceId;
    portEXIT_CRITICAL(&mux_);
    return true;
}

bool GameState::startTransport(const String& adminClientId, const String& target) {
    portENTER_CRITICAL(&mux_);
    if (adminClientId.length() == 0 || adminClientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    // A transport run only makes sense for the timed modes with a score loaded.
    if (scoreId_.length() == 0 ||
        (mode_ != Mode::ALONG && mode_ != Mode::DRIVEN && mode_ != Mode::LISTEN)) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    running_    = true;
    startAtMs_  = millis() + Config::COUNTDOWN_MS;
    introMs_    = (mode_ == Mode::ALONG) ? Config::ALONG_INTRO_MS : 0;
    // Listen-only target: where the auto-playback sounds. Anything other than
    // "players" defaults to "master".
    playTarget_ = (mode_ == Mode::LISTEN)
                      ? (target == "players" ? "players" : "master")
                      : "";
    resetRunStatsLocked_();
    portEXIT_CRITICAL(&mux_);
    return true;
}

bool GameState::stopTransport(const String& adminClientId) {
    portENTER_CRITICAL(&mux_);
    if (adminClientId.length() == 0 || adminClientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    running_    = false;
    startAtMs_  = 0;
    introMs_    = 0;
    playTarget_ = "";
    portEXIT_CRITICAL(&mux_);
    return true;
}

void GameState::recordNote(const String& clientId, bool correct) {
    portENTER_CRITICAL(&mux_);
    Player* p = findByIdLocked_(clientId);
    if (p) {
        p->notes += 1;
        if (correct) p->hits += 1; else p->misses += 1;
        p->lastSeenMs = millis();
    }
    portEXIT_CRITICAL(&mux_);
}

uint32_t GameState::kick(const String& adminClientId, const String& targetId) {
    portENTER_CRITICAL(&mux_);
    if (adminClientId.length() == 0 || adminClientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return 0;
    }
    Player* p = findByIdLocked_(targetId);
    if (!p) {
        portEXIT_CRITICAL(&mux_);
        return 0;
    }
    const uint32_t wsId = p->wsClientId;

    if (adminId_ == targetId) {
        adminId_             = "";
        adminWsClientId_     = 0;
        adminOfflineSinceMs_ = 0;
    }
    *p = Player{};
    portEXIT_CRITICAL(&mux_);
    return wsId;
}

bool GameState::resignAdmin(const String& clientId) {
    portENTER_CRITICAL(&mux_);
    if (clientId.length() == 0 || clientId != adminId_) {
        portEXIT_CRITICAL(&mux_);
        return false;
    }
    // Free the seat outright (no grace window) — the conductor asked to leave.
    adminId_             = "";
    adminWsClientId_     = 0;
    adminOfflineSinceMs_ = 0;
    portEXIT_CRITICAL(&mux_);
    return true;
}

// -----------------------------------------------------------------------------
// WS lifecycle hooks
// -----------------------------------------------------------------------------
void GameState::markOffline(uint32_t wsClientId) {
    if (wsClientId == 0) return;
    portENTER_CRITICAL(&mux_);
    Player* p = findByWsIdLocked_(wsClientId);
    if (p) {
        p->online     = false;
        p->wsClientId = 0;
        p->lastSeenMs = millis();
    }
    if (adminWsClientId_ == wsClientId) {
        // Conductor's socket dropped: reserve the seat for this clientId so a
        // reload / blip keeps it. expireStaleAdmin() releases it after the grace.
        adminWsClientId_     = 0;
        adminOfflineSinceMs_ = millis();
    }
    portEXIT_CRITICAL(&mux_);
}

bool GameState::expireStaleAdmin() {
    bool freed = false;
    portENTER_CRITICAL(&mux_);
    if (adminId_.length() != 0 && adminOfflineSinceMs_ != 0 &&
        (millis() - adminOfflineSinceMs_) >= Config::ADMIN_GRACE_MS) {
        adminId_             = "";
        adminWsClientId_     = 0;
        adminOfflineSinceMs_ = 0;
        freed = true;
    }
    portEXIT_CRITICAL(&mux_);
    return freed;
}

// -----------------------------------------------------------------------------
// Serializer
// -----------------------------------------------------------------------------
void GameState::serializeState(JsonObject root) {
    portENTER_CRITICAL(&mux_);

    root["mode"]    = modeToStr(mode_);
    root["scoreId"] = scoreId_;
    root["adminId"] = adminId_;

    JsonObject tr = root["transport"].to<JsonObject>();
    tr["running"]   = running_;
    tr["startAtMs"] = startAtMs_;
    tr["introMs"]   = introMs_;
    tr["target"]    = playTarget_;   // LISTEN only: "master" | "players" | ""

    JsonArray arr = root["players"].to<JsonArray>();
    for (const auto& p : players_) {
        if (!p.used) continue;
        JsonObject o = arr.add<JsonObject>();
        o["id"]         = p.clientId;
        o["name"]       = p.name;
        o["color"]      = p.color;
        o["instrument"] = p.instrument;
        o["voiceId"]    = p.voiceId;
        o["online"]     = p.online;
        o["hits"]       = p.hits;
        o["misses"]     = p.misses;
        o["notes"]      = p.notes;
    }

    portEXIT_CRITICAL(&mux_);
}
