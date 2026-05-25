// Maestro C3 — HTTP route table.

#pragma once

#include <ESPAsyncWebServer.h>

namespace WebRoutes {

// Install the static-file + captive-portal route table on `server`.
void install(AsyncWebServer& server);

} // namespace WebRoutes
