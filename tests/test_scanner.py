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

    def test_parse_networks_limit(self):
        with self.assertRaises(ValueError):
            scanner.parse_networks(["10.0.0.0/8"])
        self.assertEqual(scanner.parse_networks(["10.0.0.5/24"]),
                         [ipaddress.IPv4Network("10.0.0.0/24")])


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
                    [ipaddress.IPv4Network("127.0.0.0/30")], ports=[port, 1],
                    timeout=0.5, on_host=found.append,
                ).run()
        finally:
            srv.close()
        self.assertEqual([r.ip for r in results], ["127.0.0.1"])
        self.assertEqual(results[0].ports, {1: False, port: True})
        self.assertEqual(results[0].hostname, "localhost")
        self.assertTrue(found)


if __name__ == "__main__":
    unittest.main()
