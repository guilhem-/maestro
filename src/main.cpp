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

namespace {

AsyncWebServer    server(80);
AsyncWebSocket    ws("/ws");
DNSServer         dnsServer;

uint32_t          lastWsCleanupMs = 0;

} // anonymous namespace

void setup() {
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
    WiFi.mode(WIFI_AP);
    const bool apOk = WiFi.softAP(Config::AP_SSID,
                                  /*psk=*/(strlen(Config::AP_PSK) ? Config::AP_PSK : nullptr),
                                  Config::AP_CHANNEL,
                                  /*hidden=*/0,
                                  Config::AP_MAX_CONNECTIONS);
    if (!apOk) {
        Serial.println("[wifi] softAP() FAILED");
    } else {
        Serial.printf("[wifi] AP \"%s\" up at %s (max %u clients)\n",
                      Config::AP_SSID,
                      WiFi.softAPIP().toString().c_str(),
                      Config::AP_MAX_CONNECTIONS);
    }

    // ---- Captive DNS -------------------------------------------------------
    if (Config::CAPTIVE_DNS_ENABLED) {
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

    // Yield to the WiFi/network stack. delay(1) is enough on the single-core C3.
    delay(1);
}
