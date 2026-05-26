// Maestro C3 — global tunable constants.
// Header-only: include where needed; no .cpp.

#pragma once

#include <Arduino.h>

namespace Config {

// WiFi soft-AP — open network so phones can join with a single tap.
constexpr const char* AP_SSID = "Maestro";
constexpr const char* AP_PSK  = "";              // empty = open network
constexpr uint8_t     AP_CHANNEL         = 1;
// Soft-AP simultaneous client cap. ESP-IDF 4.4 (arduino-esp32 2.0.x, the
// espressif32@6.9 toolchain) rejects max_connection > ~10 — set too high,
// softAP() fails and NO network is broadcast. 8 is a safe value; raise only if
// your toolchain's IDF (5.x) supports more.
constexpr uint8_t     AP_MAX_CONNECTIONS = 8;

// Captive portal / mDNS — http://maestro.local resolves on the AP subnet.
constexpr const char* MDNS_HOST = "maestro";

// Captive-portal wildcard DNS. When true, every DNS query resolves to the AP so
// the OS captive popup opens automatically. See QuizHub's notes on the trade-off
// (a no-Internet AP makes captive detectors hammer the chip). On for Maestro:
// musicians arrive in a burst and the auto-popup gets phones into the orchestra
// fast; the server is otherwise idle between songs.
constexpr bool CAPTIVE_DNS_ENABLED = true;

// Orchestra limits.
constexpr uint8_t MAX_PLAYERS = 16;

// --- Transport timing --------------------------------------------------------
// Lead-in between the admin tapping "Start" and score position 0. Gives every
// phone time to (a) finish a fresh clock-sync handshake and (b) show a 3-2-1
// countdown so the whole orchestra starts together.
constexpr uint32_t COUNTDOWN_MS = 4000;

// "Along" mode: the admin device plays the piece as a guide for this long, then
// fades out and the musicians must carry it. Driven mode uses 0 (no guide —
// the falling notes are the guide).
constexpr uint32_t ALONG_INTRO_MS = 10000;

// WebSocket housekeeping cadence.
constexpr uint32_t WS_STATS_INTERVAL_MS   = 2000;   // periodic stats broadcast
constexpr uint32_t WS_CLEANUP_INTERVAL_MS = 1000;   // ws.cleanupClients()

// How long the admin (conductor) seat stays reserved for its clientId after that
// admin's socket drops, so a reload / brief network blip keeps the role across
// the reconnect. The seat is freed for a new claimant only after this elapses.
constexpr uint32_t ADMIN_GRACE_MS = 20000;          // 20 s

// WebSocket keep-alive: ping every connected client on this cadence so idle
// connections aren't dropped by NAT/Wi-Fi power-save and dead ones are detected.
constexpr uint32_t WS_PING_INTERVAL_MS = 15000;     // 15 s

} // namespace Config
