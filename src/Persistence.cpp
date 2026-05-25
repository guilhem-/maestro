// Maestro C3 — NVS persistence implementation.

#include "Persistence.h"

#include <Preferences.h>
#include <nvs_flash.h>

namespace Persistence {

namespace {

constexpr const char* NS_WIFI   = "wifi";
constexpr const char* NS_PLAYER = "player";

// Profile fields are stored as one delimited string per key to stay within NVS
// limits:  "name\x1Fcolor\x1Finstrument"  (\x1F = ASCII Unit Separator) — small,
// no JSON parser overhead, no collisions with user input (UI-restricted to
// printable text).
constexpr char FIELD_SEP = 0x1F;

bool s_began = false;

// NVS keys are capped at 15 chars. Convert an arbitrary clientId (UUID, etc.)
// to a stable key by hashing with FNV-1a 32-bit, base36-encoding the result,
// and prefixing with 'p' so it's a valid identifier.
String keyForClientId(const String& clientId) {
    uint32_t h = 2166136261u;                       // FNV-1a offset basis
    for (size_t i = 0; i < clientId.length(); ++i) {
        h ^= static_cast<uint8_t>(clientId[i]);
        h *= 16777619u;
    }
    // Base16 of a uint32_t fits in <= 8 chars; prefix 'p' → max 9 chars.
    char buf[16];
    snprintf(buf, sizeof(buf), "p%lx", (unsigned long)h);
    return String(buf);
}

} // anonymous namespace

// -----------------------------------------------------------------------------
void begin() {
    if (s_began) return;
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    s_began = true;
}

// -----------------------------------------------------------------------------
// WiFi credentials.
// -----------------------------------------------------------------------------
bool loadWifiCreds(String& ssid, String& psk) {
    begin();
    Preferences p;
    if (!p.begin(NS_WIFI, /*readOnly=*/true)) return false;
    ssid = p.getString("ssid", "");
    psk  = p.getString("psk",  "");
    p.end();
    return ssid.length() > 0;
}

bool saveWifiCreds(const String& ssid, const String& psk) {
    begin();
    Preferences p;
    if (!p.begin(NS_WIFI, /*readOnly=*/false)) return false;
    p.putString("ssid", ssid);
    p.putString("psk",  psk);
    p.end();
    return true;
}

bool clearWifiCreds() {
    begin();
    Preferences p;
    if (!p.begin(NS_WIFI, /*readOnly=*/false)) return false;
    p.clear();
    p.end();
    return true;
}

// -----------------------------------------------------------------------------
// Player profiles.
// -----------------------------------------------------------------------------
bool loadPlayerProfile(const String& clientId,
                       String&       name,
                       String&       color,
                       String&       instrument) {
    begin();
    Preferences p;
    if (!p.begin(NS_PLAYER, /*readOnly=*/true)) return false;
    const String key = keyForClientId(clientId);
    // Probe with isKey() first: getString() on a missing key logs a noisy NVS
    // NOT_FOUND error. A brand-new player simply has no saved profile — expected.
    if (!p.isKey(key.c_str())) { p.end(); return false; }
    String packed = p.getString(key.c_str(), "");
    p.end();
    if (packed.length() == 0) return false;

    int s1 = packed.indexOf(FIELD_SEP);
    int s2 = (s1 >= 0) ? packed.indexOf(FIELD_SEP, s1 + 1) : -1;
    if (s1 < 0 || s2 < 0) return false;

    name       = packed.substring(0, s1);
    color      = packed.substring(s1 + 1, s2);
    instrument = packed.substring(s2 + 1);
    return true;
}

bool savePlayerProfile(const String& clientId,
                       const String& name,
                       const String& color,
                       const String& instrument) {
    begin();
    Preferences p;
    if (!p.begin(NS_PLAYER, /*readOnly=*/false)) return false;
    String packed;
    packed.reserve(name.length() + color.length() + instrument.length() + 2);
    packed += name;
    packed += FIELD_SEP;
    packed += color;
    packed += FIELD_SEP;
    packed += instrument;
    p.putString(keyForClientId(clientId).c_str(), packed);
    p.end();
    return true;
}

bool clearAll() {
    begin();
    bool ok = true;
    Preferences p;
    if (p.begin(NS_WIFI, false))   { p.clear(); p.end(); } else ok = false;
    if (p.begin(NS_PLAYER, false)) { p.clear(); p.end(); } else ok = false;
    return ok;
}

} // namespace Persistence
