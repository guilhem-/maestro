// Maestro C3 — entry point. See README.md for the product pitch.
//
// Bring-up:
//   1. Mount LittleFS (format on first failure).
//   2. Bring up WiFi soft-AP "Maestro" on 192.168.4.1 (open, 16 max clients).
//   3. Run a wildcard DNS responder on UDP/53 for captive-portal redirection.
//   4. Advertise mDNS so http://maestro.local works on the AP subnet.
//   5. Install HTTP routes (UI + scores + captive probes).
//   6. Install /ws endpoint (the orchestra protocol).

#include <Arduino.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <WiFi.h>

#include "Config.h"
#include "Persistence.h"
#include "WebRoutes.h"
#include "WsHub.h"

// Onboard status LED — a plain single-colour LED on GPIO8 (the usual pin on the
// C3 mini/supermini boards). Status is encoded by BLINK RHYTHM, not colour, so
// it works on any single LED. Many of these boards wire the LED active-LOW
// (LOW = lit); flip STATUS_LED_ACTIVE_LOW if yours is inverted.
#ifndef STATUS_LED_PIN
#define STATUS_LED_PIN 8
#endif
#ifndef STATUS_LED_ACTIVE_LOW
#define STATUS_LED_ACTIVE_LOW 1
#endif
#if STATUS_LED_ACTIVE_LOW
#define STATUS_LED_ON  LOW
#define STATUS_LED_OFF HIGH
#else
#define STATUS_LED_ON  HIGH
#define STATUS_LED_OFF LOW
#endif

namespace {

AsyncWebServer    server(80);
AsyncWebSocket    ws("/ws");
DNSServer         dnsServer;

uint32_t          lastWsCleanupMs = 0;

// Status by blink RHYTHM (a glanceable indicator that needs no serial monitor):
//   AP up      → flip every 1000 ms  (calm heartbeat)
//   AP failed  → flip every 150 ms   (urgent fast blink)
bool              g_apUp   = false;
bool              g_ledOn  = false;

void serviceStatusLed() {
    const uint32_t halfPeriodMs = g_apUp ? 1000 : 150;
    const bool     wantOn = ((millis() / halfPeriodMs) & 1) == 0;
    if (wantOn == g_ledOn) return;
    g_ledOn = wantOn;
    digitalWrite(STATUS_LED_PIN, wantOn ? STATUS_LED_ON : STATUS_LED_OFF);
}

} // anonymous namespace

void setup() {
    // Light the LED the instant the app starts — before the serial and WiFi
    // waits — so a clean boot shows light immediately. It stays solid through
    // boot, then loop() takes over with the rhythm above. If it never lights
    // after a reset, the app didn't start (a reset/boot/power issue downstream).
    pinMode(STATUS_LED_PIN, OUTPUT);
    digitalWrite(STATUS_LED_PIN, STATUS_LED_ON);

    Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
    // Native USB-Serial/JTAG: never block the app on a write when no monitor is
    // attached, and give the host up to ~1.5 s to open the port after a reset so
    // the early boot log isn't lost.
    Serial.setTxTimeoutMs(0);
    for (uint32_t t0 = millis(); !Serial && millis() - t0 < 1500; ) { delay(10); }
#endif
    delay(50);
    Serial.println();
    Serial.println("=== Maestro C3 booting ===");

    // ---- NVS ---------------------------------------------------------------
    Persistence::begin();

    // ---- LittleFS ----------------------------------------------------------
    // The FS partition is named "littlefs" in partitions.csv. LittleFS.begin()
    // otherwise defaults its partition lookup to the label "spiffs" and fails
    // to mount, so pass the actual label explicitly.
    if (!LittleFS.begin(/*formatOnFail=*/true, "/littlefs", /*maxOpenFiles=*/10, "littlefs")) {
        Serial.println("[fs] LittleFS mount FAILED even after format");
    } else {
        Serial.printf("[fs] LittleFS mounted (used %u / total %u bytes)\n",
                      (unsigned)LittleFS.usedBytes(),
                      (unsigned)LittleFS.totalBytes());
    }

    // ---- WiFi AP -----------------------------------------------------------
    // Soft-AP bring-up is racy on the C3 right after a reset: the WiFi driver /
    // RF calibration isn't always ready when softAP() is called, so it can
    // return before the AP is actually beaconing — the network then shows up on
    // some resets but not others. Make it deterministic:
    //   * persistent(false): don't read/write AP config from NVS each boot
    //     (removes a flash race against Persistence::begin() and stale config),
    //   * pin an explicit AP IP via softAPConfig(),
    //   * retry from a clean radio state until the AP is genuinely up,
    //     confirmed by softAPIP() matching the IP we asked for.
    WiFi.persistent(false);
    WiFi.setSleep(false);

    const IPAddress apIP(192, 168, 4, 1), apGw(192, 168, 4, 1), apMask(255, 255, 255, 0);
    bool apOk = false;
    for (int attempt = 1; attempt <= 5 && !apOk; ++attempt) {
        WiFi.mode(WIFI_OFF);
        delay(100);
        WiFi.mode(WIFI_AP);
        delay(100);                       // let the AP netif settle before configuring
        WiFi.softAPConfig(apIP, apGw, apMask);
        apOk = WiFi.softAP(Config::AP_SSID,
                           /*psk=*/(strlen(Config::AP_PSK) ? Config::AP_PSK : nullptr),
                           Config::AP_CHANNEL,
                           /*hidden=*/0,
                           Config::AP_MAX_CONNECTIONS)
               && WiFi.softAPIP() == apIP;
        if (!apOk) {
            Serial.printf("[wifi] softAP attempt %d failed — retrying\n", attempt);
            delay(200);
        }
    }
    g_apUp = apOk;
    if (!apOk) {
        Serial.println("[wifi] softAP() FAILED after retries");
    } else {
        // Cap TX power. The full ~20 dBm PA current spike (esp. when a client
        // associates) can brown out a marginal 5V supply, which makes the AP
        // vanish mid-connect. A room of nearby phones doesn't need full power;
        // ~8.5 dBm cuts the spike and is the firmware-side brownout mitigation.
        WiFi.setTxPower(WIFI_POWER_8_5dBm);
        Serial.printf("[wifi] AP \"%s\" up at %s (max %u clients, txpower %d)\n",
                      Config::AP_SSID,
                      WiFi.softAPIP().toString().c_str(),
                      Config::AP_MAX_CONNECTIONS,
                      (int)WiFi.getTxPower());
    }

    // ---- Captive DNS -------------------------------------------------------
    if (apOk && Config::CAPTIVE_DNS_ENABLED) {
        dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
        if (!dnsServer.start(53, "*", WiFi.softAPIP())) {
            Serial.println("[dns] DNSServer start FAILED");
        } else {
            Serial.println("[dns] captive DNS responder on UDP/53");
        }
    } else {
        Serial.println("[dns] captive DNS disabled — open 192.168.4.1 or maestro.local");
    }

    // ---- mDNS --------------------------------------------------------------
    if (!MDNS.begin(Config::MDNS_HOST)) {
        Serial.println("[mdns] MDNS.begin FAILED");
    } else {
        MDNS.addService("http", "tcp", 80);
        Serial.printf("[mdns] advertising http://%s.local/\n", Config::MDNS_HOST);
    }

    // ---- HTTP routes + WS --------------------------------------------------
    WebRoutes::install(server);
    WsHub::install(server, ws);

    server.begin();
    Serial.println("[http] server.begin() done");
    Serial.println("=== Maestro C3 ready ===");
}

void loop() {
    if (Config::CAPTIVE_DNS_ENABLED) dnsServer.processNextRequest();

    const uint32_t now = millis();
    if (now - lastWsCleanupMs >= Config::WS_CLEANUP_INTERVAL_MS) {
        lastWsCleanupMs = now;
        ws.cleanupClients();
    }

    WsHub::tick();
    serviceStatusLed();

    // Yield to the WiFi/network stack. delay(1) is enough on the single-core C3.
    delay(1);
}
