#!/usr/bin/env python3
"""IP Scanner web interface: a mobile-friendly page served from this computer.

Any phone, tablet or browser on the same network can open it. Scans run on
this computer; the page shows the results. Every request needs the access
key that is part of the link (it is then kept in a cookie), so other people
on the network can't use the scanner.

    python3 web_ui.py              # prints the link and a QR code
    python3 web_ui.py --port 9000

The desktop app starts the same server from "Open on phone".
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import secrets
import socket
import sys
import tempfile
import threading
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qr  # noqa: E402
import report  # noqa: E402
import scanner  # noqa: E402

DEFAULT_PORT = 8765
COOKIE = "ipscanner_key"
SETTINGS = os.path.expanduser("~/.ip_scanner.json")
STAGE_LABELS = {"discover": "Discovering devices", "ports": "Checking ports",
                "names": "Looking up names"}


def access_key() -> str:
    """A random key, kept in the settings file so saved links keep working."""
    try:
        with open(SETTINGS) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    key = data.get("web_key")
    if not key:
        data["web_key"] = key = secrets.token_urlsafe(12)
        try:
            with open(SETTINGS, "w") as f:
                json.dump(data, f, indent=2)
        except OSError:
            pass
    return key


def primary_ip() -> str:
    """The address other devices on the network use to reach this computer."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # UDP connect sends nothing
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def host_json(r: scanner.HostResult) -> dict:
    return {
        "ip": r.ip, "name": r.hostname, "vendor": r.vendor, "mac": r.mac,
        "services": [{"port": p, "name": scanner.service_name(p),
                      "url": scanner.service_url(r.ip, p) or ""} for p in r.open_ports()],
    }


class ScanSession:
    """One scan at a time, shared by everyone using the web page."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.scanner: scanner.Scanner | None = None
        self.hosts: dict[str, scanner.HostResult] = {}
        self.stage = ""
        self.done = self.stage_total = 0
        self.total = 0
        self.spec = ""
        self.ports: list[int] = []
        self.started = self.finished = 0.0
        self.message = "Ready. Tap Scan to search the network."
        self.default_range = ", ".join(
            scanner.network_to_range(n) for n in scanner.detect_local_networks())

    def start(self, spec: str, ports_spec: str, flush: bool) -> str | None:
        try:
            targets = scanner.parse_targets(spec or self.default_range)
            ports = scanner.parse_ports(ports_spec or ",".join(map(str, scanner.DEFAULT_PORTS)))
        except ValueError as e:
            return str(e)
        if not targets:
            return "Enter an IP range, e.g. 192.168.1.1-254."
        if not ports:
            return "Enter at least one port."
        with self.lock:
            if self.scanner:
                return "A scan is already running."
            self.hosts = {}
            self.spec = spec or self.default_range
            self.ports = ports
            self.total = len(targets)
            self.stage, self.done, self.stage_total = "discover", 0, len(targets)
            self.started, self.finished = time.time(), 0.0
            self.message = "Starting…"
            self.scanner = scanner.Scanner(targets, ports, on_host=self._on_host,
                                           on_progress=self._on_progress)
            sc = self.scanner
        threading.Thread(target=self._run, args=(sc, flush), daemon=True).start()
        return None

    def _run(self, sc: scanner.Scanner, flush: bool) -> None:
        note = ""
        try:
            if flush:
                note = scanner.flush_caches(gui=True)[1]
            sc.run()
            error = ""
        except Exception as e:  # report instead of dying silently
            error = str(e)
        with self.lock:
            secs = time.time() - self.started
            if error:
                self.message = f"Scan failed: {error}"
            else:
                self.message = (f"{'Scan stopped' if sc.stopped else 'Scan completed'} "
                                f"in {secs:.0f} s." + (f" {note}" if note else ""))
            self.scanner = None
            self.finished = time.time()

    def _on_host(self, r: scanner.HostResult) -> None:
        with self.lock:
            old = self.hosts.get(r.ip)
            if old:
                r.hostname = r.hostname or old.hostname
                r.mac = r.mac or old.mac
                r.vendor = r.vendor or old.vendor
                r.ports = {**old.ports, **r.ports}
            self.hosts[r.ip] = r

    def _on_progress(self, stage: str, done: int, total: int) -> None:
        with self.lock:
            self.stage, self.done, self.stage_total = stage, done, total
            self.message = f"{STAGE_LABELS.get(stage, stage)}… {done}/{total}"

    def stop(self) -> None:
        with self.lock:
            if self.scanner:
                self.scanner.stop()
                self.message = "Stopping…"

    def sorted_hosts(self) -> list[scanner.HostResult]:
        with self.lock:
            return sorted(self.hosts.values(), key=lambda r: r.sort_key)

    def state(self) -> dict:
        with self.lock:
            scanning = self.scanner is not None
            weights = {"discover": (0, 60), "ports": (60, 90), "names": (90, 100)}
            lo, hi = weights.get(self.stage, (0, 100))
            pct = lo + (hi - lo) * self.done / max(self.stage_total, 1) if scanning else (
                100 if self.finished else 0)
            hosts = sorted(self.hosts.values(), key=lambda r: r.sort_key)
            return {
                "version": scanner.__version__,
                "scanning": scanning,
                "percent": round(pct, 1),
                "message": self.message,
                "scanned": self.spec,
                "total": self.total,
                "alive": len(hosts),
                "finished": self.finished,
                "default_range": self.default_range,
                "default_ports": ", ".join(map(str, scanner.DEFAULT_PORTS)),
                "hosts": [host_json(h) for h in hosts],
            }


def _asset(name: str) -> bytes:
    with open(os.path.join(scanner.HERE, "data", name), "rb") as f:
        return f.read()


class Handler(BaseHTTPRequestHandler):
    server_version = "IPScanner"
    session: ScanSession
    key: str

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    # -- helpers --
    def _authorized(self, query: dict) -> bool:
        if query.get("t", [""])[0] == self.key:
            return True
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return COOKIE in jar and secrets.compare_digest(jar[COOKIE].value, self.key)

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status: int = 200) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")

    def _forbidden(self) -> None:
        page = ("<!doctype html><meta name=viewport content='width=device-width'>"
                "<title>IP Scanner</title><body style='font-family:system-ui;padding:2em;"
                "color:#17283a;background:#eaf3fc'><h2>Open the link from the app</h2>"
                "<p>This page needs the private link shown in IP Scanner under "
                "<b>Open on phone</b>. Scan its QR code or copy the link.</p>")
        self._send(403, page.encode(), "text/html; charset=utf-8")

    # -- routes --
    def do_GET(self) -> None:
        url = urlparse(self.path)
        query = parse_qs(url.query)
        path = url.path
        if path in ("/icon.png", "/manifest.webmanifest"):  # needed before the key
            if path == "/icon.png":
                return self._send(200, _asset("icon.png"), "image/png")
            manifest = {"name": "IP Scanner", "short_name": "IP Scanner", "start_url": "/",
                        "display": "standalone", "background_color": "#eaf3fc",
                        "theme_color": "#2b8be0",
                        "icons": [{"src": "/icon.png", "sizes": "256x256",
                                   "type": "image/png"}]}
            return self._send(200, json.dumps(manifest).encode(),
                              "application/manifest+json")
        if not self._authorized(query):
            return self._forbidden()
        if path == "/":
            extra = {}
            if "t" in query:  # remember the key, then drop it from the address bar
                extra["Set-Cookie"] = (f"{COOKIE}={self.key}; Path=/; HttpOnly; "
                                       "SameSite=Strict; Max-Age=31536000")
            return self._send(200, _asset("web/index.html"), "text/html; charset=utf-8",
                              extra)
        if path == "/api/state":
            return self._json(self.session.state())
        if path == "/report.pdf":
            hosts = self.session.sorted_hosts()
            fd, tmp = tempfile.mkstemp(suffix=".pdf")
            os.close(fd)
            try:
                st = self.session.state()
                report.build_pdf(hosts, tmp, scanned=st["scanned"], total=st["total"],
                                 ports=self.session.ports, paper=report.default_paper())
                with open(tmp, "rb") as f:
                    body = f.read()
            finally:
                os.unlink(tmp)
            return self._send(200, body, "application/pdf", {
                "Content-Disposition": time.strftime(
                    'inline; filename="IP Scan %Y-%m-%d.pdf"')})
        if path == "/export.csv":
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["Name", "IP", "Manufacturer", "MAC address", "Open ports"])
            for r in self.session.sorted_hosts():
                w.writerow([r.hostname, r.ip, r.vendor, r.mac, "; ".join(
                    f"{p} ({scanner.service_name(p)})" for p in r.open_ports())])
            return self._send(200, buf.getvalue().encode("utf-8-sig"), "text/csv", {
                "Content-Disposition": time.strftime(
                    'attachment; filename="IP Scan %Y-%m-%d.csv"')})
        self._send(404, b"Not found", "text/plain")

    do_HEAD = do_GET

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if not self._authorized(parse_qs(url.query)):
            return self._forbidden()
        # Only same-origin script requests (JSON) are accepted: a plain form on
        # another website can't send this content type.
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self._json({"error": "JSON expected"}, 415)
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 65536)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json({"error": "Bad request"}, 400)
        if url.path == "/api/scan":
            error = self.session.start(str(body.get("range", "")),
                                       str(body.get("ports", "")), bool(body.get("flush")))
            return self._json({"error": error} if error else {"ok": True},
                              400 if error else 200)
        if url.path == "/api/stop":
            self.session.stop()
            return self._json({"ok": True})
        self._json({"error": "Not found"}, 404)


class WebServer:
    """The web interface, running on a background thread."""

    def __init__(self, port: int = DEFAULT_PORT, host: str = "0.0.0.0",
                 session: ScanSession | None = None, key: str | None = None):
        self.session = session or ScanSession()
        self.key = key or access_key()
        handler = type("BoundHandler", (Handler,), {"session": self.session, "key": self.key})
        last_error: OSError | None = None
        for p in ([port] + list(range(port + 1, port + 20)) if port else [0]):
            try:
                self.httpd = ThreadingHTTPServer((host, p), handler)
                break
            except OSError as e:
                last_error = e
        else:
            raise last_error or OSError("No free port")
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self) -> "WebServer":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.session.stop()
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def url(self) -> str:
        return f"http://{primary_ip()}:{self.port}/?t={self.key}"

    @property
    def local_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?t={self.key}"


def terminal_qr(text: str) -> str:
    """The QR code drawn with block characters, for the command line."""
    m = qr.encode(text, "M")
    n = len(m)
    pad = 2

    def dark(x, y):
        return 0 <= x < n and 0 <= y < n and m[y][x]
    lines = []
    for y in range(-pad, n + pad, 2):
        line = ""
        for x in range(-pad, n + pad):
            top, bottom = dark(x, y), dark(x, y + 1)
            # Light-on-dark terminals: draw the light modules.
            line += {(False, False): "█", (True, False): "▄",
                     (False, True): "▀", (True, True): " "}[(top, bottom)]
        lines.append(line)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Serve the IP Scanner web interface.")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on")
    args = ap.parse_args(argv)
    server = WebServer(args.port, args.host).start()
    print(f"IP Scanner {scanner.__version__} web interface\n")
    print(terminal_qr(server.url))
    print(f"\nOpen on your phone (same Wi-Fi): {server.url}")
    print("Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
