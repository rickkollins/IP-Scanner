import ipaddress
import os
import socket
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import scanner  # noqa: E402

MAC_IFCONFIG = """\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether a4:83:e7:12:34:56
\tinet 192.168.1.23 netmask 0xffffff00 broadcast 192.168.1.255
bridge100: flags=8863<UP> mtu 1500
\tinet 169.254.10.1 netmask 0xffff0000 broadcast 169.254.255.255
"""

MAC_ARP = """\
? (192.168.1.1) at 0:1a:2b:3c:4d:5e on en0 ifscope [ethernet]
? (192.168.1.40) at (incomplete) on en0 ifscope [ethernet]
? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]
"""


class ParsingTests(unittest.TestCase):
    def test_parse_ifconfig(self):
        ifaces = scanner.parse_ifconfig(MAC_IFCONFIG)
        self.assertIn(ipaddress.IPv4Interface("192.168.1.23/24"), ifaces)
        self.assertIn(ipaddress.IPv4Interface("127.0.0.1/8"), ifaces)

    def test_detect_skips_loopback_and_link_local(self):
        with mock.patch.object(scanner, "IS_MAC", True), \
             mock.patch.object(scanner, "_run", return_value=MAC_IFCONFIG), \
             mock.patch.object(scanner.shutil, "which", return_value="/sbin/ifconfig"):
            nets = scanner.detect_local_networks()
        self.assertEqual(nets, [ipaddress.IPv4Network("192.168.1.0/24")])

    def test_arp_table(self):
        with mock.patch.object(scanner, "_run", return_value=MAC_ARP):
            table = scanner.arp_table()
        self.assertEqual(table["192.168.1.1"], "00:1a:2b:3c:4d:5e")
        self.assertNotIn("192.168.1.40", table)

    def test_parse_targets(self):
        self.assertEqual(scanner.parse_targets("192.168.1.1-3"),
                         ["192.168.1.1", "192.168.1.2", "192.168.1.3"])
        self.assertEqual(scanner.parse_targets("10.0.0.0/30, 10.0.0.2 10.0.0.9-10.0.0.10"),
                         ["10.0.0.1", "10.0.0.2", "10.0.0.9", "10.0.0.10"])
        self.assertEqual(len(scanner.parse_targets("192.168.0.0/16")), 65534)
        with self.assertRaises(ValueError):
            scanner.parse_targets("10.0.0.0/8")
        with self.assertRaises(ValueError):
            scanner.parse_targets("10.0.0.9-3")

    def test_network_to_range(self):
        self.assertEqual(scanner.network_to_range(ipaddress.IPv4Network("192.168.1.0/24")),
                         "192.168.1.1-254")
        self.assertEqual(scanner.network_to_range(ipaddress.IPv4Network("10.0.0.0/22")),
                         "10.0.0.0/22")

    def test_parse_ports(self):
        self.assertEqual(scanner.parse_ports("443, 22,8000-8002"), [22, 443, 8000, 8001, 8002])
        with self.assertRaises(ValueError):
            scanner.parse_ports("70000")

    def test_default_ports_include_requested(self):
        for p in (22, 80, 81, 443, 4007, 4008, 8000, 8081, 8123):
            self.assertIn(p, scanner.DEFAULT_PORTS)

    def test_vendor_lookup(self):
        self.assertEqual(scanner.vendor_for_mac("b8:27:eb:00:11:22"), "Raspberry Pi Foundation")
        self.assertEqual(scanner.vendor_for_mac("f0:d1:a9:00:11:22"), "Apple, Inc.")
        self.assertEqual(scanner.vendor_for_mac("da:a1:19:00:11:22"), "Private (randomized MAC)")
        self.assertEqual(scanner.vendor_for_mac(""), "")

    def test_flush_commands_on_mac(self):
        with mock.patch.object(scanner, "IS_MAC", True):
            cmds = scanner.flush_commands()
        self.assertIn(["arp", "-a", "-d"], cmds)
        self.assertIn(["dscacheutil", "-flushcache"], cmds)


class ScanTests(unittest.TestCase):
    def test_scan_finds_open_port(self):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        port = srv.getsockname()[1]
        found = []
        try:
            with mock.patch.object(scanner, "ping", side_effect=lambda ip, t: ip == "127.0.0.1"), \
                 mock.patch.object(scanner, "arp_table", return_value={}), \
                 mock.patch.object(scanner, "resolve_hostname", return_value="localhost"):
                results = scanner.Scanner(
                    scanner.parse_targets("127.0.0.0/30"), ports=[port, 1],
                    timeout=0.5, on_host=found.append,
                ).run()
        finally:
            srv.close()
        self.assertEqual([r.ip for r in results], ["127.0.0.1"])
        self.assertEqual(results[0].ports, {1: False, port: True})
        self.assertEqual(results[0].hostname, "localhost")
        self.assertTrue(found)
        # Reported results are copies, safe to read from another thread.
        self.assertIsNot(found[-1], results[0])
        self.assertEqual(found[-1].ports, {1: False, port: True})


class ReportTests(unittest.TestCase):
    def test_pdf_is_landscape_and_paginates(self):
        import tempfile
        import zlib
        import report
        hosts = []
        for i in range(1, 120):
            r = scanner.HostResult(ip=f"10.0.0.{i}", hostname=f"host-{i} (lab)",
                                   mac="b8:27:eb:00:00:01", vendor="Raspberry Pi Foundation")
            r.ports = {22: True, 80: True, 443: i % 2 == 0}
            hosts.append(r)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "r.pdf")
            pages = report.build_pdf(hosts, path, "10.0.0.1-254", 254, [22, 80, 443])
            with open(path, "rb") as f:
                data = f.read()
        self.assertGreater(pages, 1)
        self.assertTrue(data.startswith(b"%PDF-1.4"))
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))
        self.assertIn(b"/MediaBox [0 0 792.00 612.00]", data)  # wider than tall
        self.assertIn(b"/Count %d" % pages, data)
        first = data.index(b"stream\n") + 7
        text = zlib.decompress(data[first:data.index(b"\nendstream", first)])
        self.assertIn(b"(Network Scan Report)", text)
        self.assertIn(b"host-1 \\(lab\\)", text)  # parentheses escaped
        # Expanded service rows, like the app's list.
        self.assertIn(b"(SSH)", text)
        self.assertIn(b"(port 22)", text)
        self.assertIn(b"(ssh://10.0.0.1)", text)
        self.assertIn(b"(https://10.0.0.2/)", text)

    def test_fit_and_wrap(self):
        import report
        self.assertEqual(report.fit("short", 100, 9), "short")
        long = report.fit("x" * 200, 50, 9)
        self.assertTrue(long.endswith("..."))
        self.assertLessEqual(report.text_width(long, 9), 50)
        lines = report.wrap("22 SSH, 80 HTTP, 443 HTTPS, 8123 Home Assistant", 60, 9)
        self.assertGreater(len(lines), 1)


if __name__ == "__main__":
    unittest.main()
