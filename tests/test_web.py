import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import qr  # noqa: E402
import scanner  # noqa: E402
import web_ui  # noqa: E402


class QrTests(unittest.TestCase):
    def test_structure(self):
        m = qr.encode("http://192.168.1.20:8765/?t=abc", "M")
        self.assertEqual(len(m), 29)  # 31 bytes fit version 3 (29x29) at level M
        for x0, y0 in ((0, 0), (len(m) - 7, 0), (0, len(m) - 7)):  # finder patterns
            self.assertTrue(all(m[y0][x0 + i] for i in range(7)))
            self.assertFalse(m[y0 + 1][x0 + 1])
            self.assertTrue(m[y0 + 3][x0 + 3])

    def test_too_long(self):
        with self.assertRaises(ValueError):
            qr.encode("x" * 5000)

    @unittest.skipUnless(shutil.which("zbarimg"), "zbarimg not installed")
    def test_decodes_with_zbar(self):
        for text in ("http://10.0.0.5:8765/?t=Zx9_-a1", "x" * 200):
            m = qr.encode(text, "M")
            n, scale, quiet = len(m), 4, 4
            size = (n + 2 * quiet) * scale
            rows = [" ".join("1" if 0 <= y // scale - quiet < n and 0 <= x // scale - quiet < n
                             and m[y // scale - quiet][x // scale - quiet] else "0"
                             for x in range(size)) for y in range(size)]
            with tempfile.NamedTemporaryFile("w", suffix=".pbm", delete=False) as f:
                f.write(f"P1\n{size} {size}\n" + "\n".join(rows) + "\n")
            try:
                out = subprocess.run(["zbarimg", "-q", "--raw", f.name],
                                     capture_output=True, text=True).stdout.rstrip("\n")
            finally:
                os.unlink(f.name)
            self.assertEqual(out, text)


class WebTests(unittest.TestCase):
    def setUp(self):
        self.srv_sock = socket.socket()
        self.srv_sock.bind(("127.0.0.1", 0))
        self.srv_sock.listen()
        self.open_port = self.srv_sock.getsockname()[1]
        patches = [
            mock.patch.object(scanner, "ping", side_effect=lambda ip, t: ip == "127.0.0.1"),
            mock.patch.object(scanner, "arp_table", return_value={"127.0.0.1": "b8:27:eb:00:00:01"}),
            mock.patch.object(scanner, "local_macs", return_value={}),
            mock.patch.object(scanner, "resolve_hostname", return_value="pi.local"),
            mock.patch.object(scanner, "detect_local_networks", return_value=[]),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.server = web_ui.WebServer(0, "127.0.0.1", key="k3y").start()
        self.base = f"http://127.0.0.1:{self.server.port}"
        self.addCleanup(self.server.stop)
        self.addCleanup(self.srv_sock.close)

    def get(self, path, cookie=None):
        req = urllib.request.Request(self.base + path)
        if cookie:
            req.add_header("Cookie", cookie)
        return urllib.request.urlopen(req, timeout=10)

    def post(self, path, body, ctype="application/json", cookie="ipscanner_key=k3y"):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": ctype, "Cookie": cookie})
        return urllib.request.urlopen(req, timeout=10)

    def test_key_required(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/state")
        self.assertEqual(e.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/", cookie="ipscanner_key=wrong")
        self.assertEqual(e.exception.code, 403)
        # The icon and manifest load without the key (needed for "Add to Home Screen").
        self.assertEqual(self.get("/icon.png").status, 200)

    def test_link_sets_cookie_and_serves_page(self):
        r = self.get("/?t=k3y")
        self.assertIn("ipscanner_key=k3y", r.headers["Set-Cookie"])
        self.assertIn("HttpOnly", r.headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", r.headers["Set-Cookie"])
        self.assertIn(b"pill", r.read())

    def test_post_needs_json(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/scan", {}, ctype="text/plain")
        self.assertEqual(e.exception.code, 415)

    def test_scan_flow(self):
        r = self.post("/api/scan", {"range": "127.0.0.1-3", "ports": f"{self.open_port}, 1"})
        self.assertEqual(json.loads(r.read()), {"ok": True})
        for _ in range(100):
            state = json.loads(self.get("/api/state", "ipscanner_key=k3y").read())
            if not state["scanning"]:
                break
            time.sleep(0.1)
        self.assertEqual(state["total"], 3)
        self.assertEqual(state["alive"], 1)
        host = state["hosts"][0]
        self.assertEqual((host["ip"], host["name"]), ("127.0.0.1", "pi.local"))
        self.assertEqual(host["vendor"], "Raspberry Pi Foundation")
        self.assertEqual([s["port"] for s in host["services"]], [self.open_port])
        self.assertEqual(state["percent"], 100)
        csv_text = self.get("/export.csv", "ipscanner_key=k3y").read().decode("utf-8-sig")
        self.assertIn("pi.local,127.0.0.1", csv_text)
        pdf = self.get("/report.pdf", "ipscanner_key=k3y").read()
        self.assertTrue(pdf.startswith(b"%PDF"))

    def test_bad_range(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/scan", {"range": "10.0.0.0/8"})
        self.assertEqual(e.exception.code, 400)
        self.assertIn("too large", json.loads(e.exception.read())["error"])


if __name__ == "__main__":
    unittest.main()
