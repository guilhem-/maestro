// Maestro C3 — HTTP route table. See WebRoutes.h.
//
// Captive-portal handling mirrors QuizHub's current CAPPORT (RFC 8908) flow so
// joining is transparent: connectivity probes from a freshly-joined phone are
// REDIRECTED to /portal (which makes the OS pop its "Sign in to network" sheet
// automatically), the portal shows a "Connected → Continue" page with a
// one-time coded link, and opening the app URL VALIDATES the client — after
// which the very same probes are answered "online", dismissing the captive
// sheet so the OS stops thrashing the adapter. Plus the /scores/* tree: the
// orchestra's sheet music is static JSON on LittleFS, fetched + cached by every
// browser, so WebSocket frames stay tiny.

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
// Captive-portal landing page — DELIBERATELY separate from the game UI.
//
// The OS captive assistant (CNA) is a throwaway, churning, storage-less browser;
// it must never run the instrument or claim an identity. So all connectivity
// probes land here: a self-contained page that confirms the connection and
// hands the user a one-time coded link into the real game. Following that link
// (or just opening 192.168.4.1) marks the client "validated" server-side, after
// which the OS connectivity probes are answered "online" and the CNA is released.
//
// Template tokens substituted per request: __URL__ (coded continue link) and
// __CODE__ (the one-time code, also shown for the manual fallback).
// -----------------------------------------------------------------------------
static const char CAPTIVE_TMPL[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maestro</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;margin:0;min-height:100vh;
  display:flex;align-items:center;justify-content:center;
  background:linear-gradient(160deg,#1a1430,#2a1b46);color:#f3eefe;padding:24px}
 .card{max-width:430px;text-align:center}
 h1{color:#2ecc71;margin:0 0 .2em;font-size:1.9rem}
 p{line-height:1.5;color:#cfc3e6}
 .go{display:block;font-size:1.3rem;font-weight:700;color:#1a0f2e;background:#b08bff;
  border-radius:12px;padding:16px;margin:18px 0 10px;text-decoration:none}
 .code{font-size:1.5rem;font-weight:800;letter-spacing:.18em;color:#ffd76b}
 button{font:inherit;font-weight:700;cursor:pointer;border-radius:999px;border:1px solid #8b5cf6;
  background:transparent;color:#b08bff;padding:10px 18px;margin:6px}
 .alt{color:#9a8cbf;font-size:.9rem;margin-top:18px}.alt b{color:#f3eefe}.alt a{color:#b08bff}
</style></head><body><div class="card">
 <h1>&#127931; Connected &#9989;</h1>
 <p>Continue in your browser to join the Maestro orchestra.</p>
 <a class="go" id="go" href="__URL__">Continue to Maestro &#8594;</a>
 <button id="copy" type="button">&#128203; Copy address</button>
 <p class="alt">Didn't open? Go to <b>192.168.4.1</b> in your browser.<br>
  One-time code: <span class="code">__CODE__</span><br>
  On a computer: <a href="http://maestro.local/">maestro.local</a></p>
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
// Captive-portal helpers.
// -----------------------------------------------------------------------------
static const char* AP_ROOT_URL   = "http://192.168.4.1/";
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

// One line per HTTP request, with the verdict we applied, so the serial log
// makes the captive-portal handshake easy to follow.
static void logHttp(AsyncWebServerRequest* request, const char* verdict) {
    Serial.printf("[http] %-4s %s%s  from %s  -> %s\n",
                  request->methodToString(),
                  request->host().c_str(),
                  request->url().c_str(),
                  request->client()->remoteIP().toString().c_str(),
                  verdict);
}

// -----------------------------------------------------------------------------
// CAPPORT (RFC 8908) per-client state, keyed by IP.
//
// A proper captive portal answers the OS connectivity probe in opposite ways
// depending on whether the client has completed the portal flow:
//   * UNVALIDATED — redirect the probe to /portal so the OS pops the captive
//     "Sign in to network" sheet and shows our page.
//   * VALIDATED   — answer the very same probe with the exact success payload
//     the OS wants, so it marks the network "online" and releases the CNA.
//
// A client becomes VALIDATED the moment it actually opens the app URL (`/`),
// ideally via the one-time coded link we hand out on the portal page. The
// RFC 8908 API (/captive-api) reports the same `captive` flag as machine-
// readable JSON. Entries expire so a recycled DHCP lease doesn't inherit a
// stale validation.
// -----------------------------------------------------------------------------
static constexpr size_t   CAPTIVE_MAX     = 24;
static constexpr uint32_t CAPTIVE_TTL_MS  = 30UL * 60UL * 1000UL;   // 30 min
static constexpr size_t   CAPTIVE_CODELEN = 6;

struct CaptiveClient {
    uint32_t ip;
    uint32_t seenMs;
    bool     validated;
    char     code[CAPTIVE_CODELEN + 1];   // one-time code issued by /portal
};
static CaptiveClient s_captive[CAPTIVE_MAX] = {};

// Find the live entry for this request's IP, or nullptr. (Expired == absent.)
static CaptiveClient* captiveFind(uint32_t ip) {
    const uint32_t now = millis();
    for (size_t i = 0; i < CAPTIVE_MAX; i++) {
        if (s_captive[i].ip == ip && now - s_captive[i].seenMs < CAPTIVE_TTL_MS)
            return &s_captive[i];
    }
    return nullptr;
}

// Find-or-allocate an entry for this IP, refreshing its TTL.
static CaptiveClient* captiveTouch(uint32_t ip) {
    if (ip == 0) return nullptr;
    const uint32_t now = millis();
    CaptiveClient* e = captiveFind(ip);
    if (e) { e->seenMs = now; return e; }
    int slot = -1;
    for (size_t i = 0; i < CAPTIVE_MAX; i++) {
        if (s_captive[i].ip == 0 || now - s_captive[i].seenMs >= CAPTIVE_TTL_MS) {
            slot = (int)i; break;          // reuse a free or expired slot
        }
    }
    if (slot < 0) slot = 0;                // table full of fresh entries
    s_captive[slot] = CaptiveClient{ ip, now, false, {0} };
    return &s_captive[slot];
}

static bool captiveValidated(AsyncWebServerRequest* request) {
    CaptiveClient* e = captiveFind((uint32_t)request->client()->remoteIP());
    if (!e) return false;
    // Refresh TTL on every check (OS probes/API polls hit this regularly), so a
    // validated client stays released for the whole session even though in-game
    // traffic is WebSocket-only and never touches these HTTP routes.
    e->seenMs = millis();
    return e->validated;
}

// Issue (or reuse) this client's one-time code for the portal link.
static String captiveIssueCode(AsyncWebServerRequest* request) {
    CaptiveClient* e = captiveTouch((uint32_t)request->client()->remoteIP());
    if (!e) return "";
    if (e->code[0] == 0) {
        // Crockford-ish base32, no vowels/ambiguous chars — easy to read aloud.
        static const char alphabet[] = "23456789CDFGHJKMNPQRSTVWXYZ";
        for (size_t i = 0; i < CAPTIVE_CODELEN; i++)
            e->code[i] = alphabet[esp_random() % (sizeof(alphabet) - 1)];
        e->code[CAPTIVE_CODELEN] = 0;
    }
    return String(e->code);
}

// Mark the client validated (it opened the app URL). `provided` is the code from
// the link, if any — checked against the issued code for the log only; a plain
// load with no/wrong code still validates (the manual fallback).
static void captiveValidate(AsyncWebServerRequest* request, const String& provided) {
    CaptiveClient* e = captiveTouch((uint32_t)request->client()->remoteIP());
    if (!e) return;
    const bool already = e->validated;
    e->validated = true;
    const char* how = already                 ? "already"
                    : provided.length() == 0   ? "direct (fallback)"
                    : (provided == e->code)     ? "code ok"
                                                : "code mismatch -> allowed";
    if (!already) {
        Serial.printf("[capport] %s validated (%s)\n",
                      request->client()->remoteIP().toString().c_str(), how);
        e->code[0] = 0;                    // consume the one-time code
    }
}

// Connectivity-probe responder. UNVALIDATED → 302 to /portal so the OS pops its
// captive sheet; VALIDATED → the exact "online" payload the OS expects, which
// dismisses the sheet and stops it thrashing the adapter. Pass code==204 for
// Android's empty-body No-Content probe.
static void probeReply(AsyncWebServerRequest* request,
                       int code, const char* type, const char* body) {
    if (!captiveValidated(request)) {
        logHttp(request, "probe -> portal (302)");
        request->redirect(AP_PORTAL_URL);
        return;
    }
    logHttp(request, "probe -> online");
    if (code == 204) {
        request->send(204, "text/plain", "");
        return;
    }
    AsyncWebServerResponse* res = request->beginResponse(code, type, body);
    res->addHeader("Cache-Control", "no-store");
    request->send(res);
}

// RFC 8908 Captive Portal API. Returns application/captive+json describing
// whether this client is still captive and where the portal lives. Note: this
// IDF can't advertise the API via DHCP option 114 (RFC 8910), so most phones
// won't poll it automatically — it's served for spec-compliant clients and for
// the legacy-probe flow's benefit. `captive` mirrors the per-IP validated flag.
static void serveCaptiveApi(AsyncWebServerRequest* request) {
    const bool captive = !captiveValidated(request);
    JsonDocument d;
    d["captive"]          = captive;
    d["user-portal-url"]  = AP_PORTAL_URL;
    d["venue-info-url"]   = AP_ROOT_URL;
    if (!captive) d["can-extend-session"] = false;

    String body;
    serializeJson(d, body);
    logHttp(request, captive ? "capport: captive=true" : "capport: captive=false");
    AsyncWebServerResponse* res =
        request->beginResponse(200, "application/captive+json", body);
    res->addHeader("Cache-Control", "private, no-store");
    request->send(res);
}

// -----------------------------------------------------------------------------
// Serve a file from LittleFS, or fall back to PLACEHOLDER_HTML.
// -----------------------------------------------------------------------------
static void serveHtmlOrPlaceholder(AsyncWebServerRequest* request,
                                   const char*            path) {
    // Opening the app URL is the CAPPORT validation step: from now on this
    // client's connectivity probes get the "online" success answer and the
    // RFC 8908 API reports captive=false. The one-time code (?k=) from the
    // portal link is verified for the log; a plain load still validates.
    const String code = request->hasParam("k") ? request->getParam("k")->value()
                                                : String();
    captiveValidate(request, code);
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

// Captive landing page (inline, FS-independent). Issues this client a one-time
// code and bakes it into the "continue" link + the manual-fallback hint. Does
// NOT validate — that happens when the user actually opens the app URL.
static void serveCaptive(AsyncWebServerRequest* request) {
    const String code = captiveIssueCode(request);
    const String url  = String(AP_ROOT_URL) + "?k=" + code;

    String html;
    html.reserve(sizeof(CAPTIVE_TMPL) + 32);
    html = FPSTR(CAPTIVE_TMPL);
    html.replace("__URL__", url);
    html.replace("__CODE__", code);

    logHttp(request, "portal page");
    AsyncWebServerResponse* res = request->beginResponse(200, "text/html", html);
    res->addHeader("Cache-Control", "no-store");
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

    // Captive-portal landing — the dedicated "Connected ✅" page that all
    // connectivity probes redirect to. Separate from the game.
    server.on("/portal", HTTP_GET, serveCaptive);

    // RFC 8908 Captive Portal API (machine-readable captive state).
    server.on("/captive-api", HTTP_GET, serveCaptiveApi);

    // Dynamic scores manifest (only scores that actually exist). Must be
    // registered before the /scores/* catch-all so it wins for this exact path.
    server.on("/scores/manifest.json", HTTP_GET, serveScoresManifest);

    // Static asset trees. Our own handler does one existence check + a clean
    // 404, avoiding AsyncStaticWebHandler's probe cascade.
    server.on("/css/*",    HTTP_GET, serveStatic);
    server.on("/js/*",     HTTP_GET, serveStatic);
    server.on("/img/*",    HTTP_GET, serveStatic);
    server.on("/scores/*", HTTP_GET, serveStatic);

    // Captive-portal connectivity probes. Before the client has opened the UI,
    // each redirects to pop the OS "Sign in to network" sheet; once validated,
    // each returns the exact payload that OS treats as "online", so the device
    // stays on the AP and stops warning about missing Internet. DNS wildcards
    // every domain to us, so matching on the path alone catches all variants.
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

    // 404 fallback. Off-host requests (any unrecognised hostname — DNS wildcards
    // every domain to us) are OS/app connectivity probes: redirect unvalidated
    // clients to the portal so the captive sheet pops, and answer "online" (204)
    // once they're validated so the OS releases them. On-host unknown paths 404.
    server.onNotFound([](AsyncWebServerRequest* req) {
        if (!isLocalHost(req)) {
            if (!captiveValidated(req)) {
                logHttp(req, "off-host -> portal (302)");
                req->redirect(AP_PORTAL_URL);
            } else {
                logHttp(req, "off-host -> 204");
                req->send(204, "text/plain", "");
            }
            return;
        }
        logHttp(req, "404");
        req->send(404, "text/plain", "Not found");
    });

    Serial.println("[http] routes installed");
}

} // namespace WebRoutes
