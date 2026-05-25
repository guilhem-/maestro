// Maestro C3 — HTTP route table. See WebRoutes.h.
//
// Mirrors QuizHub's captive-portal handling (the hard-won "answer probes as
// online so the OS stops thrashing the adapter" behaviour) and adds the
// /scores/* tree: the orchestra's sheet music lives as static JSON on LittleFS,
// fetched and cached by every browser, so WebSocket frames stay tiny.

#include "WebRoutes.h"
#include "Config.h"
#include "GameState.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <esp_random.h>

namespace WebRoutes {

// -----------------------------------------------------------------------------
// Inline placeholder served when the LittleFS asset bundle hasn't been
// uploaded yet (typical between `pio run -t upload` and `pio run -t uploadfs`).
// -----------------------------------------------------------------------------
static const char PLACEHOLDER_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Maestro C3</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif;
           margin: 0; padding: 2rem; background: #15121f; color: #eee; }
    h1   { color: #b08bff; margin-top: 0; }
    code { background: #241d34; padding: 0.15em 0.4em; border-radius: 4px;
           color: #ffd76b; }
    p    { line-height: 1.5; }
  </style>
</head>
<body>
  <h1>&#127931; Maestro C3</h1>
  <p>The firmware is running, but the web UI hasn't been uploaded to LittleFS yet.</p>
  <p>From the project directory on the dev machine, run:</p>
  <p><code>pio run -t uploadfs</code></p>
  <p>Then reload this page.</p>
</body>
</html>
)HTML";

// -----------------------------------------------------------------------------
// Captive-portal landing page — DELIBERATELY separate from the game UI. The OS
// captive assistant (CNA) is a throwaway, storage-less browser; it must never
// run the instrument or claim an identity. All connectivity probes land here.
// -----------------------------------------------------------------------------
static const char CAPTIVE_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maestro</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;margin:0;min-height:100vh;
  display:flex;align-items:center;justify-content:center;
  background:linear-gradient(160deg,#1a1430,#2a1b46);color:#f3eefe;padding:24px}
 .card{max-width:430px;text-align:center}
 h1{color:#b08bff;margin:0 0 .3em;font-size:2rem}
 p{line-height:1.5;color:#cfc3e6}
 .url{display:block;font-size:1.6rem;font-weight:700;color:#ffd76b;background:#241d34;
  border:1px solid #3a3052;border-radius:12px;padding:14px;margin:16px 0;text-decoration:none;word-break:break-all}
 button{font:inherit;font-weight:700;cursor:pointer;border-radius:999px;border:1px solid #8b5cf6;
  background:#8b5cf6;color:#fff;padding:12px 20px;margin:6px}
 button.ghost{background:transparent;color:#b08bff}
 .alt{color:#9a8cbf;font-size:.9rem;margin-top:18px}.alt a{color:#b08bff}
</style></head><body><div class="card">
 <h1>&#127931; Maestro</h1>
 <p>To join the orchestra, open this address in your browser&nbsp;:</p>
 <a class="url" id="url" href="http://192.168.4.1/">192.168.4.1</a>
 <div>
  <button id="copy" type="button">&#128203; Copy address</button>
  <button class="ghost" type="button" onclick="location.href='http://192.168.4.1/'">Open Maestro</button>
 </div>
 <p class="alt">On a computer&nbsp;: <a href="http://maestro.local/">maestro.local</a></p>
</div><script>
 var U="http://192.168.4.1/",b=document.getElementById("copy");
 function ok(){b.textContent="✅ Copied!";setTimeout(function(){b.textContent="📋 Copy address"},1500);}
 function fb(){var t=document.createElement("input");t.value=U;document.body.appendChild(t);t.select();
  try{document.execCommand("copy");ok();}catch(e){}document.body.removeChild(t);}
 b.addEventListener("click",function(){
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(U).then(ok).catch(fb);}else{fb();}});
</script></body></html>
)HTML";

// -----------------------------------------------------------------------------
static const char* AP_PORTAL_URL = "http://192.168.4.1/portal";

static bool isLocalHost(AsyncWebServerRequest* request) {
    if (!request->hasHeader("Host")) return true;
    const String host = request->header("Host");
    return host.startsWith("192.168.4.1") ||
           host.equalsIgnoreCase(String(Config::MDNS_HOST) + ".local");
}

// -----------------------------------------------------------------------------
// Identity cookie. The server issues an `mz_id` on the first app-page load and
// the browser returns it on every later request, so identity survives reloads
// and localStorage being wiped — more reliable than a client-generated token in
// a captive/private browser.
// -----------------------------------------------------------------------------
static String readClientCookie(AsyncWebServerRequest* request) {
    if (!request->hasHeader("Cookie")) return "";
    const String c = request->getHeader("Cookie")->value();
    int i = c.indexOf("mz_id=");
    if (i < 0) return "";
    i += 6;
    const int j = c.indexOf(';', i);
    String v = (j < 0) ? c.substring(i) : c.substring(i, j);
    v.trim();
    return v;
}

static String newClientId() {
    static const char hex[] = "0123456789abcdef";
    String s;
    s.reserve(24);
    for (int i = 0; i < 24; i++) s += hex[esp_random() & 0x0F];
    return s;
}

static void logHttp(AsyncWebServerRequest* request, const char* verdict) {
    Serial.printf("[http] %-4s %s%s  from %s  -> %s\n",
                  request->methodToString(),
                  request->host().c_str(),
                  request->url().c_str(),
                  request->client()->remoteIP().toString().c_str(),
                  verdict);
}

// -----------------------------------------------------------------------------
// Captive-portal "sign-in then release" tracking (see QuizHub for the rationale:
// answer the OS probe as "online" once the client has seen the UI, so the OS
// stops popping the captive sheet and thrashing the connection).
// -----------------------------------------------------------------------------
static constexpr size_t   CAPTIVE_MAX     = 24;
static constexpr uint32_t CAPTIVE_TTL_MS  = 15UL * 60UL * 1000UL;   // 15 min

struct CaptiveClient { uint32_t ip; uint32_t seenMs; };
static CaptiveClient s_captive[CAPTIVE_MAX] = {};

static void markCaptiveSignedIn(AsyncWebServerRequest* request) {
    const uint32_t ip  = (uint32_t)request->client()->remoteIP();
    const uint32_t now = millis();
    if (ip == 0) return;
    int slot = -1;
    for (size_t i = 0; i < CAPTIVE_MAX; i++) {
        if (s_captive[i].ip == ip) { s_captive[i].seenMs = now; return; }
        if (slot < 0 && (s_captive[i].ip == 0 ||
                         now - s_captive[i].seenMs >= CAPTIVE_TTL_MS)) {
            slot = (int)i;
        }
    }
    if (slot < 0) slot = 0;
    s_captive[slot].ip     = ip;
    s_captive[slot].seenMs = now;
}

// Connectivity-probe responder: always answer "online" — never redirect.
// Redirecting trips every OS's captive-portal UI (which reloads the page and
// churns the connection). Pass code==204 for Android's No-Content probe.
static void probeReply(AsyncWebServerRequest* request,
                       int code, const char* type, const char* body) {
    logHttp(request, "probe -> online");
    if (code == 204) {
        request->send(204, "text/plain", "");
        return;
    }
    AsyncWebServerResponse* res = request->beginResponse(code, type, body);
    res->addHeader("Cache-Control", "no-store");
    request->send(res);
}

// -----------------------------------------------------------------------------
// Serve a file from LittleFS, or fall back to PLACEHOLDER_HTML.
// -----------------------------------------------------------------------------
static void serveHtmlOrPlaceholder(AsyncWebServerRequest* request,
                                   const char*            path) {
    markCaptiveSignedIn(request);
    logHttp(request, LittleFS.exists(path) ? "page" : "placeholder");

    AsyncWebServerResponse* res =
        LittleFS.exists(path)
            ? request->beginResponse(LittleFS, path, "text/html")
            : request->beginResponse_P(200, "text/html", PLACEHOLDER_HTML);
    res->addHeader("Cache-Control", "no-cache");

    // Issue a stable identity cookie if the browser doesn't already carry one.
    if (readClientCookie(request).length() == 0) {
        res->addHeader("Set-Cookie",
                       "mz_id=" + newClientId() + "; Max-Age=31536000; Path=/; SameSite=Lax");
    }
    request->send(res);
}

static void serveCaptive(AsyncWebServerRequest* request) {
    markCaptiveSignedIn(request);
    logHttp(request, "portal page");
    AsyncWebServerResponse* res =
        request->beginResponse_P(200, "text/html", CAPTIVE_HTML);
    res->addHeader("Cache-Control", "no-cache");
    request->send(res);
}

// Static-asset Content-Type sniffer based on extension.
static const char* mimeFor(const String& path) {
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".css"))  return "text/css";
    if (path.endsWith(".js"))   return "application/javascript";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".svg"))  return "image/svg+xml";
    if (path.endsWith(".png"))  return "image/png";
    if (path.endsWith(".ico"))  return "image/x-icon";
    return "application/octet-stream";
}

// Generic handler for /css/*, /js/*, /scores/*.
static void serveStatic(AsyncWebServerRequest* request) {
    const String path = request->url();           // already starts with '/'
    if (!LittleFS.exists(path)) {
        request->send(404, "text/plain", "Not found");
        return;
    }
    AsyncWebServerResponse* res =
        request->beginResponse(LittleFS, path, mimeFor(path));
    // Scores are immutable once uploaded; no-cache the rest while iterating.
    if (path.startsWith("/scores/")) {
        res->addHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
        res->addHeader("Cache-Control", "no-cache");
    }
    request->send(res);
}

// Serve /scores/manifest.json filtered to entries whose JSON file actually
// exists on LittleFS, so the UI never offers a piece it can't load.
static void serveScoresManifest(AsyncWebServerRequest* request) {
    JsonDocument disk;
    File f = LittleFS.open("/scores/manifest.json", "r");
    if (f) { deserializeJson(disk, f); f.close(); }

    JsonDocument out;
    JsonArray arr = out.to<JsonArray>();
    if (disk.is<JsonArray>()) {
        for (JsonObject e : disk.as<JsonArray>()) {
            const char* file = e["file"] | "";
            if (file[0] && LittleFS.exists(String("/scores/") + file)) {
                arr.add(e);
            }
        }
    }

    String body;
    serializeJson(out, body);
    AsyncWebServerResponse* res =
        request->beginResponse(200, "application/json", body);
    res->addHeader("Cache-Control", "no-cache");
    request->send(res);
}

// -----------------------------------------------------------------------------
void install(AsyncWebServer& server) {
    server.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
        // Always the musician (player) UI. The conductor claims /admin explicitly
        // in a real browser — never auto-assigned, so a captive shell can't grab
        // it. (See QuizHub WebRoutes for the full story.)
        serveHtmlOrPlaceholder(req, "/index.html");
    });

    server.on("/admin", HTTP_GET, [](AsyncWebServerRequest* req) {
        const String cid = readClientCookie(req);
        const String adm = g_game.adminId();
        const char* verdict =
            adm.length() == 0 ? "seat FREE -> should CLAIM conductor"
          : (adm == cid)      ? "you ARE conductor -> should RESUME"
                              : "conductor held by OTHER -> should DEMOTE to player";
        Serial.printf("[admin] GET /admin cookie=%s adminId=%s -> %s\n",
                      cid.length() ? cid.c_str() : "(none)",
                      adm.length() ? adm.c_str() : "(none)", verdict);
        serveHtmlOrPlaceholder(req, "/admin.html");
    });

    server.on("/portal", HTTP_GET, serveCaptive);

    // Dynamic scores manifest (only scores that actually exist). Must be
    // registered before the /scores/* catch-all so it wins for this exact path.
    server.on("/scores/manifest.json", HTTP_GET, serveScoresManifest);

    server.on("/css/*",    HTTP_GET, serveStatic);
    server.on("/js/*",     HTTP_GET, serveStatic);
    server.on("/scores/*", HTTP_GET, serveStatic);

    // Captive-portal connectivity probes — answer "online" so the OS stays on
    // the AP and stops nagging. DNS wildcards every domain to us, so matching on
    // path alone catches all variants.
    static const char IOS_OK[] =
        "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>";

    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest* r) {        // Android
        probeReply(r, 204, "text/plain", "");
    });
    server.on("/gen_204", HTTP_GET, [](AsyncWebServerRequest* r) {             // Android (older)
        probeReply(r, 204, "text/plain", "");
    });
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest* r) { // iOS / macOS
        probeReply(r, 200, "text/html", IOS_OK);
    });
    server.on("/library/test/success.html", HTTP_GET, [](AsyncWebServerRequest* r) { // iOS legacy
        probeReply(r, 200, "text/html", IOS_OK);
    });
    server.on("/success.txt", HTTP_GET, [](AsyncWebServerRequest* r) {         // Firefox
        probeReply(r, 200, "text/plain", "success\n");
    });
    server.on("/connecttest.txt", HTTP_GET, [](AsyncWebServerRequest* r) {     // Windows
        probeReply(r, 200, "text/plain", "Microsoft Connect Test");
    });
    server.on("/ncsi.txt", HTTP_GET, [](AsyncWebServerRequest* r) {            // Windows NCSI
        probeReply(r, 200, "text/plain", "Microsoft NCSI");
    });
    server.on("/redirect", HTTP_GET, [](AsyncWebServerRequest* r) {            // Windows fallback
        probeReply(r, 204, "text/plain", "");
    });
    server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest* r) {              // Microsoft fwlink
        probeReply(r, 204, "text/plain", "");
    });

    server.onNotFound([](AsyncWebServerRequest* req) {
        if (!isLocalHost(req)) {
            logHttp(req, "off-host -> 204");
            req->send(204, "text/plain", "");
            return;
        }
        logHttp(req, "404");
        req->send(404, "text/plain", "Not found");
    });

    Serial.println("[http] routes installed");
}

} // namespace WebRoutes
