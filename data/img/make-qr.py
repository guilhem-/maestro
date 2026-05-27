#!/usr/bin/env python3
"""Generate the static "join the orchestra" QR codes as SVG.

The AP has no Internet, so QR codes can't be produced at runtime from a web
service — they are pre-rendered here and shipped on LittleFS (same idea as the
generated scores). Two codes:

  * qr-wifi.svg — joins the open Wi-Fi "Maestro" (most phones auto-connect).
  * qr-app.svg  — opens the musician UI at http://192.168.4.1/.

Re-run after changing the SSID or AP IP (keep these in sync with Config.h), then
`pio run -t uploadfs`:

    pip install segno          # one-time
    ./make-qr.py
"""
import os
import segno
from segno import helpers

# Keep in sync with src/Config.h (AP_SSID) and the soft-AP IP (192.168.4.1).
SSID = "Maestro"
URL  = "http://192.168.4.1/"

DARK  = "#150f24"   # near-black, matches the app background for a tidy card
LIGHT = "#ffffff"   # white quiet zone — high contrast scans best

here = os.path.dirname(os.path.abspath(__file__))


def main():
    # Open network → security=None, no password.
    wifi = helpers.make_wifi(ssid=SSID, password=None, security=None)
    wifi.save(os.path.join(here, "qr-wifi.svg"), scale=8, border=2,
              dark=DARK, light=LIGHT)

    app = segno.make(URL, error="m")
    app.save(os.path.join(here, "qr-app.svg"), scale=8, border=2,
             dark=DARK, light=LIGHT)

    print("wrote qr-wifi.svg (join SSID %r) and qr-app.svg (%s)" % (SSID, URL))


if __name__ == "__main__":
    main()
