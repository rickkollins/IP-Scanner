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
             mock.patch.object(scanner, "IS_WINDOWS", False), \
             mock.patch.object(scanner, "_run", return_value=MAC_IFCONFIG), \
             mock.patch.object(scanner.shutil, "which", return_value="/sbin/ifconfig"):
            nets = scanner.detect_local_networks()
        self.assertEqual(nets, [ipaddress.IPv4Network("192.168.1.0/24")])

    def test_arp_table(self):
        with mock.patch.object(scanner, "_run", return_value=MAC_ARP), \
             mock.patch.object(scanner, "IS_WINDOWS", False):
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
        with mock.patch.object(scanner, "IS_MAC", True), \
             mock.patch.object(scanner, "IS_WINDOWS", False):
            cmds = scanner.flush_commands()
        self.assertIn(["arp", "-a", "-d"], cmds)
        self.assertIn(["dscacheutil", "-flushcache"], cmds)


WINDOWS_ARP = """
Interface: 192.168.0.12 --- 0x7
  Internet Address      Physical Address      Type
  192.168.0.1           00-1a-2b-3c-4d-5e     dynamic
  192.168.0.25          00-11-32-aa-bb-cc     dynamisch
  192.168.0.255         ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
"""

WINDOWS_ADAPTERS = (
    '[{"ip":"192.168.0.12","prefix":24,"mac":"A4-83-E7-12-34-56","gw":true},'
    '{"ip":"172.25.144.1","prefix":20,"mac":"00-15-5D-01-02-03","gw":false}]')


class WindowsParsingTests(unittest.TestCase):
    def test_arp(self):
        self.assertEqual(scanner.parse_windows_arp(WINDOWS_ARP), {
            "192.168.0.1": "00:1a:2b:3c:4d:5e", "192.168.0.25": "00:11:32:aa:bb:cc"})

    def test_adapters(self):
        adapters = scanner.parse_windows_adapters(WINDOWS_ADAPTERS)
        self.assertEqual([str(a.interface) for a in adapters],
                         ["192.168.0.12/24", "172.25.144.1/20"])
        self.assertEqual(adapters[0].mac, "a4:83:e7:12:34:56")
        self.assertTrue(adapters[0].gateway)
        self.assertFalse(adapters[1].gateway)
        # PowerShell emits a bare object when there is only one adapter.
        one = scanner.parse_windows_adapters(
            '{"ip":"10.0.0.5","prefix":8,"mac":null,"gw":false}')
        self.assertEqual(one[0].mac, "")
        self.assertEqual(scanner.parse_windows_adapters("not json"), [])

    def test_detect_prefers_networks_with_a_gateway(self):
        adapters = scanner.parse_windows_adapters(WINDOWS_ADAPTERS)
        with mock.patch.object(scanner, "IS_WINDOWS", True), \
             mock.patch.object(scanner, "_windows_adapters", return_value=adapters):
            self.assertEqual(scanner.detect_local_networks(),
                             [ipaddress.IPv4Network("192.168.0.0/24")])
            self.assertEqual(scanner.local_macs()["192.168.0.12"], "a4:83:e7:12:34:56")

    def test_flush_commands_on_windows(self):
        with mock.patch.object(scanner, "IS_WINDOWS", True):
            cmds = scanner.flush_commands()
        self.assertIn(["netsh", "interface", "ip", "delete", "arpcache"], cmds)
        self.assertIn(["ipconfig", "/flushdns"], cmds)


class MdnsTests(unittest.TestCase):
    def test_reverse_lookup_against_fake_responder(self):
        """A fake Bonjour responder answering with a compressed PTR record."""
        import threading
        srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        srv.bind(("127.0.0.1", 0))
        port = srv.getsockname()[1]
        real_sendto = socket.socket.sendto

        def answer():
            data, addr = srv.recvfrom(2048)
            qend = data.index(b"\x00", 12) + 5
            question = data[12:qend]
            rdata = b"\x0bKOLLINS-NAS\x05local\x00"
            reply = (data[:2] + b"\x84\x00\x00\x01\x00\x01\x00\x00\x00\x00" + question
                     + b"\xc0\x0c" + b"\x00\x0c\x00\x01" + b"\x00\x00\x00\x0a"
                     + len(rdata).to_bytes(2, "big") + rdata)
            real_sendto(srv, reply, addr)

        t = threading.Thread(target=answer)
        t.start()

        def redirect(self, data, addr):
            return real_sendto(self, data, ("127.0.0.1", port))
        try:
            with mock.patch.object(socket.socket, "sendto", redirect):
                self.assertEqual(scanner.mdns_name("192.168.0.25"), "KOLLINS-NAS.local")
        finally:
            t.join(2)
            srv.close()

    def test_no_responder(self):
        # TEST-NET-1 never answers. (Not 127.0.0.1: a Mac's own Bonjour
        # service answers there with the Mac's name.)
        self.assertEqual(scanner.mdns_name("192.0.2.1", timeout=0.2), "")


@unittest.skipUnless(sys.platform == "win32", "Windows only")
class WindowsLiveTests(unittest.TestCase):
    """Runs the real Windows code paths (on the GitHub Windows runner)."""

    def test_ping_localhost(self):
        self.assertTrue(scanner.ping("127.0.0.1"))
        self.assertFalse(scanner.ping("192.0.2.1", 300))  # TEST-NET, never answers

    def test_adapters_and_arp(self):
        adapters = scanner._windows_adapters()
        print("adapters:", adapters)
        self.assertTrue(adapters)
        print("networks:", scanner.detect_local_networks())
        print("arp entries:", len(scanner.arp_table()))

    def test_refused_port_counts_as_alive(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()  # nothing listens there now
        # Windows retries a refused connection for about a second first.
        self.assertEqual(scanner.check_port("127.0.0.1", port, timeout=5), (False, True))


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
