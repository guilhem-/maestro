// Maestro C3 — WebSocket protocol implementation.
//
// Wire format is frozen in WsHub.h's top-of-file contract. This file owns the
// dispatch, the broadcast helpers, the clock-sync reply, and the periodic
// stats / stale-conductor housekeeping.

#include "WsHub.h"

#include "Config.h"
#include "GameState.h"

#include <Arduino.h>
#include <ArduinoJson.h>

namespace WsHub {

namespace {

AsyncWebSocket* s_ws = nullptr;
uint32_t        s_lastStatsMs      = 0;
uint32_t        s_lastAdminCheckMs = 0;
uint32_t        s_lastPingMs       = 0;

constexpr size_t kInboundDocBytes  = 1024;   // largest realistic frame is `assign`
constexpr size_t kStateReserveBytes = 2560;  // 16 players × ~150 bytes + wrapper
constexpr size_t kSmallReserveBytes = 256;

// --- send helpers ----------------------------------------------------------
void sendUnicast(AsyncWebSocketClient* client, const JsonDocument& doc) {
    if (!client) return;
    String out;
    out.reserve(kSmallReserveBytes);
    serializeJson(doc, out);
    client->text(out);
}

void sendUnicastError(AsyncWebSocketClient* client, const char* code, const char* msg) {
    if (!client) return;
    JsonDocument d;
    d["t"]    = "error";
    d["code"] = code;
    d["msg"]  = msg;
    sendUnicast(client, d);
}

void broadcastState() {
    if (!s_ws) return;
    JsonDocument doc;
    doc["t"] = "state";                       // promotes root to JsonObject
    g_game.serializeState(doc.as<JsonObject>());

    String out;
    out.reserve(kStateReserveBytes);
    serializeJson(doc, out);
    s_ws->textAll(out);
}

// --- dispatch --------------------------------------------------------------
void handleHello(AsyncWebSocketClient* client, JsonDocument& in) {
    const char* role     = in["role"]     | "player";
    const char* clientId = in["clientId"] | "";

    String assignedRole;
    const bool ok = g_game.joinOrUpdate(String(clientId),
                                        client->id(),
                                        String(role) == "admin",
                                        assignedRole);

    Serial.printf("[ws] hello ws#%u id=%.10s want=%s -> %s ok=%d\n",
                  (unsigned)client->id(), clientId, role, assignedRole.c_str(),
                  ok ? 1 : 0);

    if (!ok) {
        sendUnicastError(client, "no_slot", "orchestra is full");
        return;
    }

    JsonDocument d;
    d["t"]        = "welcome";
    d["yourRole"] = assignedRole;
    d["yourId"]   = clientId;
    sendUnicast(client, d);

    broadcastState();
}

void handleSetProfile(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const String clientId = p->clientId;

    const char* name  = in["name"]       | "";
    const char* color = in["color"]      | "";
    const char* instr = in["instrument"] | "piano";

    if (!g_game.setProfile(clientId, String(name), String(color), String(instr))) {
        sendUnicastError(client, "bad_profile", "invalid or already-taken color");
        return;
    }
    broadcastState();
}

// Clock-sync: echo the client's c0 with our current millis(). Unicast, no state
// change. This is the highest-frequency message, so keep it allocation-light.
void handleTsync(AsyncWebSocketClient* client, JsonDocument& in) {
    JsonDocument d;
    d["t"]  = "tsync";
    d["c0"] = in["c0"] | (uint32_t)0;
    d["s"]  = (uint32_t)millis();
    sendUnicast(client, d);
}

void handlePlay(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const String clientId = p->clientId;
    const String voiceId  = p->voiceId;

    const int  midi    = in["midi"]    | 60;
    const bool correct = in["correct"] | false;

    g_game.recordNote(clientId, correct);

    // Fan out a lightweight edge event for the conductor's activity view and
    // other phones' ambient note bursts. No full-state rebroadcast (stats ride
    // along on the next periodic `state`? No — we broadcast state lazily on
    // structural changes; per-note counters refresh via the periodic stats path
    // and the next structural state). Keep this hot path tiny.
    if (s_ws) {
        JsonDocument d;
        d["t"]        = "note";
        d["playerId"] = clientId;
        d["midi"]     = midi;
        d["correct"]  = correct;
        d["voiceId"]  = voiceId;
        String out;
        out.reserve(kSmallReserveBytes);
        serializeJson(d, out);
        s_ws->textAll(out);
    }
}

void handleSelectScore(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const char* scoreId = in["scoreId"] | "";
    if (!g_game.selectScore(p->clientId, String(scoreId))) {
        sendUnicastError(client, "not_admin", "selectScore requires conductor");
        return;
    }
    broadcastState();
}

void handleSetMode(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const char* mode = in["mode"] | "";
    if (!g_game.setMode(p->clientId, String(mode))) {
        sendUnicastError(client, "bad_mode", "setMode requires conductor and a valid mode");
        return;
    }
    broadcastState();
}

void handleAssign(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const String adminId = p->clientId;

    JsonArray pairs = in["pairs"].as<JsonArray>();
    if (pairs.isNull()) {
        sendUnicastError(client, "bad_assign", "expected pairs array");
        return;
    }
    bool anyOk = false;
    for (JsonObject pr : pairs) {
        const char* pid = pr["playerId"] | "";
        const char* vid = pr["voiceId"]  | "";
        if (g_game.assignVoice(adminId, String(pid), String(vid))) anyOk = true;
    }
    if (!anyOk) {
        sendUnicastError(client, "not_admin", "assign requires conductor");
        return;
    }
    broadcastState();
}

void handleStart(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const char* target = in["target"] | "";   // LISTEN only: "master"|"players"
    if (!g_game.startTransport(p->clientId, String(target))) {
        sendUnicastError(client, "cant_start", "need conductor, a score, and a timed mode");
        return;
    }
    broadcastState();
}

void handleStop(AsyncWebSocketClient* client) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    if (!g_game.stopTransport(p->clientId)) {
        sendUnicastError(client, "not_admin", "stop requires conductor");
        return;
    }
    broadcastState();
}

void handleResign(AsyncWebSocketClient* client) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    if (!g_game.resignAdmin(p->clientId)) {
        sendUnicastError(client, "not_admin", "resign requires being the conductor");
        return;
    }
    broadcastState();
}

void handleKick(AsyncWebSocketClient* client, JsonDocument& in) {
    Player* p = g_game.findByWsId(client->id());
    if (!p) { sendUnicastError(client, "not_joined", "send hello first"); return; }
    const char* target = in["playerId"] | "";
    const uint32_t kickedWsId = g_game.kick(p->clientId, String(target));
    if (kickedWsId == 0 && g_game.adminId() != p->clientId) {
        sendUnicastError(client, "not_admin", "kick requires conductor");
        return;
    }
    if (kickedWsId != 0 && s_ws) {
        AsyncWebSocketClient* victim = s_ws->client(kickedWsId);
        if (victim) victim->close(1000, "kicked");
    }
    broadcastState();
}

// --- master event handler --------------------------------------------------
void onWsEvent(AsyncWebSocket*       /*server*/,
               AsyncWebSocketClient* client,
               AwsEventType          type,
               void*                 arg,
               uint8_t*              data,
               size_t                len) {
    switch (type) {
        case WS_EVT_CONNECT:
            Serial.printf("[ws] client #%u connected from %s\n",
                          client->id(), client->remoteIP().toString().c_str());
            break;

        case WS_EVT_DISCONNECT:
            Serial.printf("[ws] client #%u disconnected\n", client->id());
            g_game.markOffline(client->id());
            broadcastState();
            break;

        case WS_EVT_DATA: {
            AwsFrameInfo* info = static_cast<AwsFrameInfo*>(arg);
            if (!(info && info->final && info->index == 0 &&
                  info->len == len && info->opcode == WS_TEXT)) {
                Serial.printf("[ws] client #%u dropped non-text/fragmented frame\n",
                              client->id());
                break;
            }

            JsonDocument in;
            DeserializationError err = deserializeJson(in, data, len);
            if (err) {
                sendUnicastError(client, "bad_json", err.c_str());
                break;
            }

            const char* t = in["t"] | "";
            if      (!strcmp(t, "hello"))       handleHello(client, in);
            else if (!strcmp(t, "setProfile"))  handleSetProfile(client, in);
            else if (!strcmp(t, "tsync"))       handleTsync(client, in);
            else if (!strcmp(t, "play"))        handlePlay(client, in);
            else if (!strcmp(t, "selectScore")) handleSelectScore(client, in);
            else if (!strcmp(t, "setMode"))     handleSetMode(client, in);
            else if (!strcmp(t, "assign"))      handleAssign(client, in);
            else if (!strcmp(t, "start"))       handleStart(client, in);
            else if (!strcmp(t, "stop"))        handleStop(client);
            else if (!strcmp(t, "resign"))      handleResign(client);
            else if (!strcmp(t, "kick"))        handleKick(client, in);
            else {
                sendUnicastError(client, "unknown_type", t[0] ? t : "(missing)");
            }
            break;
        }

        case WS_EVT_PONG:
        case WS_EVT_ERROR:
        default:
            break;
    }
}

} // anonymous namespace

// =============================================================================
// Public API
// =============================================================================
void install(AsyncWebServer& server, AsyncWebSocket& ws) {
    s_ws = &ws;
    ws.onEvent(onWsEvent);
    server.addHandler(&ws);
    Serial.println("[ws] /ws endpoint installed");
}

void tick() {
    if (!s_ws) return;
    const uint32_t now = millis();

    // Release a reserved-but-stale conductor seat ~once a second.
    if (now - s_lastAdminCheckMs >= 1000) {
        s_lastAdminCheckMs = now;
        if (g_game.expireStaleAdmin()) broadcastState();
    }

    // Keep-alive ping so idle sockets aren't silently dropped.
    if (now - s_lastPingMs >= Config::WS_PING_INTERVAL_MS) {
        s_lastPingMs = now;
        s_ws->pingAll();
    }

    if (now - s_lastStatsMs < Config::WS_STATS_INTERVAL_MS) return;
    s_lastStatsMs = now;

    JsonDocument doc;
    doc["t"]        = "stats";
    doc["uptimeMs"] = (uint32_t)millis();
    doc["heapFree"] = (uint32_t)ESP.getFreeHeap();

    String out;
    out.reserve(kSmallReserveBytes);
    serializeJson(doc, out);
    s_ws->textAll(out);
}

} // namespace WsHub
