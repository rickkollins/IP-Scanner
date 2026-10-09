#!/usr/bin/env python3
"""Serve the web app with a fake timer behind it, for UI work without hardware.

    python3 tools/mock_server.py [port]      then open http://localhost:8000
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / "web" / "index.html"
MAX_SLOTS = 8

state = {
    "names": ["Porch Lights", "Garden Pump"],
    "modes": ["auto", "auto"],
    "tz": "EST5EDT,M3.2.0,M11.1.0",
    "ssid": "", "pass": "", "apPass": "relay1234",
    "relays": [
        [[[1080, 1410]]] * 5 + [[[1080, 60]]] * 2,                           # Sun..Fri, Sat overnight
        [[[360, 420], [1140, 1170]], [[360, 400]], [], [[360, 400]], [], [[360, 400]], [[480, 540]]],
    ],
}


def on_at(r, d, m):
    s = state["relays"][r]
    if any((a < b and a <= m < b) or (a > b and m >= a) for a, b in s[d]):
        return True
    return any(a > b and m < b for a, b in s[(d + 6) % 7])


def snapshot():
    t = time.localtime()
    wday, minute = (t.tm_wday + 1) % 7, t.tm_hour * 60 + t.tm_min
    relays = []
    for r in range(2):
        mode = state["modes"][r]
        on = mode == "on" or (mode == "auto" and on_at(r, wday, minute))
        relays.append({"name": state["names"][r], "mode": mode, "on": on})
    return {"timeValid": True, "epoch": int(time.time()), "wday": wday, "minute": minute,
            "second": t.tm_sec, "date": time.strftime("%Y-%m-%d", t), "relays": relays,
            "uptime": int(time.monotonic())}


def settings():
    return {"tz": state["tz"], "ssid": state["ssid"], "hasPass": bool(state["pass"]),
            "apSsid": "RelayTimer-3F2A", "apIp": "192.168.4.1",
            "staConnected": bool(state["ssid"]), "staIp": "192.168.1.57" if state["ssid"] else "",
            "rssi": -58, "host": "relaytimer.local", "names": state["names"]}


class Handler(BaseHTTPRequestHandler):
    def send(self, obj, code=200, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            return self.send(INDEX.read_bytes(), ctype="text/html")
        if self.path == "/api/state":
            return self.send(snapshot())
        if self.path == "/api/schedule":
            return self.send({"maxSlots": MAX_SLOTS, "relays": state["relays"]})
        if self.path == "/api/settings":
            return self.send(settings())
        if self.path == "/api/scan":
            time.sleep(1.2)
            return self.send({"networks": [{"ssid": "HomeNet", "rssi": -48, "secure": True},
                                           {"ssid": "HomeNet-5G", "rssi": -63, "secure": True},
                                           {"ssid": "Neighbor", "rssi": -81, "secure": True},
                                           {"ssid": "CoffeeShop", "rssi": -74, "secure": False}]})
        self.send({"error": "not found"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/api/schedule":
            state["relays"] = [[[s for s in day if s[0] != s[1]] for day in r] for r in body["relays"]]
            return self.send({"maxSlots": MAX_SLOTS, "relays": state["relays"]})
        if self.path == "/api/relay":
            state["modes"][body["relay"]] = body["mode"]
            return self.send(snapshot())
        if self.path == "/api/time":
            return self.send(snapshot())
        if self.path == "/api/settings":
            if "apPass" in body and len(body["apPass"]) < 8:
                return self.send({"error": "hotspot password needs 8+ characters"}, 400)
            for k in ("names", "tz", "ssid", "pass", "apPass"):
                if k in body:
                    state[k] = body[k]
            return self.send(settings())
        self.send({"error": "not found"}, 404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Mock RelayTimer on http://localhost:{port}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
