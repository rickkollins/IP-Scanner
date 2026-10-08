#!/usr/bin/env python3
"""IPv4 network scanner core (standard library only).

Finds alive hosts on the local network(s), resolves their names, looks up
the manufacturer from the MAC address and checks a set of TCP ports. Can be
used on its own from the command line:

    python3 scanner.py                         # scan all detected local subnets
    python3 scanner.py 192.168.1.1-254         # a range (CIDR and single IPs work too)
    python3 scanner.py --flush --csv out.csv   # wipe ARP/DNS caches first, save CSV
"""

from __future__ import annotations

import argparse
import csv
import gzip
import ipaddress
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace
from typing import Callable, Iterable

__version__ = "2.1.0"

# Port -> service name. These are all checked by default.
SERVICES: dict[int, str] = {
    21: "FTP",
    22: "SSH",
    23: "Telnet",
    25: "SMTP",
    53: "DNS",
    80: "HTTP",
    81: "HTTP (alt)",
    110: "POP3",
    135: "MS RPC",
    139: "NetBIOS",
    143: "IMAP",
    443: "HTTPS",
    445: "SMB",
    548: "AFP",
    554: "RTSP",
    631: "IPP (printing)",
    993: "IMAPS",
    995: "POP3S",
    1883: "MQTT",
    3000: "HTTP (dev)",
    3306: "MySQL",
    3389: "RDP",
    4007: "Port 4007",
    4008: "Port 4008",
    5000: "HTTP (UPnP / Synology)",
    5001: "HTTPS (Synology)",
    5432: "PostgreSQL",
    5900: "VNC / Screen Sharing",
    7000: "AirPlay",
    8000: "HTTP (alt)",
    8008: "HTTP (alt)",
    8080: "HTTP proxy",
    8081: "HTTP (alt)",
    8123: "Home Assistant",
    8443: "HTTPS (alt)",
    8888: "HTTP (alt)",
    9000: "HTTP (alt)",
    9100: "Printer (JetDirect)",
    32400: "Plex",
    62078: "Apple device sync",
}
DEFAULT_PORTS = tuple(SERVICES)

# Ranges bigger than this are refused, so a typo doesn't turn into a
# 16-million-host scan.
MAX_HOSTS = 65536

IS_MAC = sys.platform == "darwin"
# Inside the bundled app (PyInstaller) data files live in sys._MEIPASS.
HERE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


@dataclass
class HostResult:
    ip: str
    hostname: str = ""
    mac: str = ""
    vendor: str = ""
    ports: dict[int, bool] = field(default_factory=dict)

    @property
    def sort_key(self) -> int:
        return int(ipaddress.IPv4Address(self.ip))

    def open_ports(self) -> list[int]:
        return sorted(p for p, is_open in self.ports.items() if is_open)


def service_name(port: int) -> str:
    return SERVICES.get(port, f"Port {port}")


# How to open each service (used for double-click in the app and the report).
HTTPS_PORTS = {443, 5001, 8443}
URL_SCHEMES = {21: "ftp", 22: "ssh", 445: "smb", 548: "afp", 5900: "vnc"}


def service_url(ip: str, port: int) -> str | None:
    if port in URL_SCHEMES:
        return f"{URL_SCHEMES[port]}://{ip}"
    if port in HTTPS_PORTS:
        return f"https://{ip}" + ("" if port == 443 else f":{port}") + "/"
    name = service_name(port)
    if port in (80, 81, 3000, 4007, 4008, 5000, 8000, 8008, 8080, 8081, 8123,
                8888, 9000, 32400) or name.startswith("HTTP"):
        return f"http://{ip}" + ("" if port == 80 else f":{port}") + "/"
    return None


# --------------------------------------------------------------------------
# Targets
# --------------------------------------------------------------------------

def _run(cmd: list[str], timeout: float = 5.0) -> str:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def parse_ifconfig(output: str) -> list[ipaddress.IPv4Interface]:
    """Parse macOS/BSD `ifconfig` output into IPv4 interfaces."""
    result = []
    for m in re.finditer(
        r"inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-fA-F]+|\d+\.\d+\.\d+\.\d+)",
        output,
    ):
        addr, mask = m.groups()
        if mask.startswith("0x"):
            mask = str(ipaddress.IPv4Address(int(mask, 16)))
        result.append(ipaddress.IPv4Interface(f"{addr}/{mask}"))
    return result


def parse_ip_addr(output: str) -> list[ipaddress.IPv4Interface]:
    """Parse Linux `ip -o -4 addr show` output into IPv4 interfaces."""
    return [
        ipaddress.IPv4Interface(m.group(1))
        for m in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+/\d+)", output)
    ]


def _interfaces() -> list[ipaddress.IPv4Interface]:
    if shutil.which("ifconfig") and (IS_MAC or not shutil.which("ip")):
        return parse_ifconfig(_run(["ifconfig"]))
    return parse_ip_addr(_run(["ip", "-o", "-4", "addr", "show"]))


def detect_local_networks() -> list[ipaddress.IPv4Network]:
    """Return the IPv4 networks this machine is directly attached to."""
    networks = []
    for iface in _interfaces():
        ip = iface.ip
        if ip.is_loopback or ip.is_link_local or iface.network.prefixlen >= 31:
            continue
        if iface.network not in networks:
            networks.append(iface.network)
    return networks


def local_ips() -> set[str]:
    return {str(i.ip) for i in _interfaces()}


def network_to_range(net: ipaddress.IPv4Network) -> str:
    """192.168.1.0/24 -> '192.168.1.1-254' (Advanced IP Scanner style)."""
    if net.prefixlen < 24 or net.prefixlen >= 31:
        return str(net)
    first = net.network_address + 1
    last = net.broadcast_address - 1
    return f"{first}-{str(last).rsplit('.', 1)[1]}"


def parse_targets(spec: str) -> list[str]:
    """Expand '192.168.1.1-254, 10.0.0.0/24, 10.0.1.5-10.0.1.9, 10.0.2.7'."""
    out: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[,;\s]+", spec.strip()):
        if not part:
            continue
        if "/" in part:
            net = ipaddress.IPv4Network(part, strict=False)
            if net.num_addresses > MAX_HOSTS:
                raise ValueError(f"{part} is too large (limit is a /16).")
            ips = list(net.hosts()) if net.prefixlen < 31 else list(net)
        elif "-" in part:
            start_s, end_s = part.split("-", 1)
            start = ipaddress.IPv4Address(start_s)
            if "." in end_s:
                end = ipaddress.IPv4Address(end_s)
            else:
                end = ipaddress.IPv4Address(start_s.rsplit(".", 1)[0] + "." + end_s)
            if end < start:
                raise ValueError(f"{part}: range end is before its start.")
            if int(end) - int(start) + 1 > MAX_HOSTS:
                raise ValueError(f"{part} is too large (limit is 65,536 addresses).")
            ips = [ipaddress.IPv4Address(i) for i in range(int(start), int(end) + 1)]
        else:
            ips = [ipaddress.IPv4Address(part)]
        for ip in ips:
            s = str(ip)
            if s not in seen:
                seen.add(s)
                out.append(s)
    if len(out) > MAX_HOSTS:
        raise ValueError("Too many addresses (limit is 65,536).")
    return out


def parse_ports(spec: str) -> list[int]:
    """'22, 80, 8000-8010' -> sorted list of ports."""
    ports: set[int] = set()
    for part in re.split(r"[,;\s]+", spec.strip()):
        if not part:
            continue
        if "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
            ports.update(range(a, b + 1))
        else:
            ports.add(int(part))
    if not all(0 < p < 65536 for p in ports):
        raise ValueError("Ports must be between 1 and 65535.")
    return sorted(ports)


# --------------------------------------------------------------------------
# Caches
# --------------------------------------------------------------------------

def flush_commands() -> list[list[str]]:
    """Commands that wipe the ARP and DNS caches (they need root)."""
    if IS_MAC:
        return [
            ["arp", "-a", "-d"],
            ["dscacheutil", "-flushcache"],
            ["killall", "-HUP", "mDNSResponder"],
        ]
    cmds = [["ip", "-s", "-s", "neigh", "flush", "all"]]
    if shutil.which("resolvectl"):
        cmds.append(["resolvectl", "flush-caches"])
    return cmds


def flush_caches(gui: bool = False) -> tuple[bool, str]:
    """Wipe the ARP and DNS caches before discovery.

    As root the commands run directly. Otherwise the GUI asks for an
    administrator password with the standard macOS dialog, and the CLI uses
    sudo (which prompts in the terminal).
    """
    cmds = flush_commands()
    shell = "; ".join(" ".join(c) for c in cmds)
    try:
        if os.geteuid() == 0:
            for c in cmds:
                subprocess.run(c, capture_output=True, timeout=15)
            return True, "ARP and DNS caches cleared."
        if gui and IS_MAC:
            script = (
                f'do shell script "{shell} >/dev/null 2>&1; true" '
                f'with prompt "IP Scanner wants to clear the ARP and DNS caches '
                f'before scanning." with administrator privileges'
            )
            r = subprocess.run(["osascript", "-e", script],
                               capture_output=True, text=True, timeout=300)
        elif gui:
            r = subprocess.run(["pkexec", "sh", "-c", shell + "; true"],
                               capture_output=True, text=True, timeout=300)
        else:
            r = subprocess.run(["sudo", "sh", "-c", shell + " >/dev/null 2>&1; true"],
                               timeout=300)
    except (OSError, subprocess.SubprocessError) as e:
        return False, f"Could not clear caches: {e}"
    if r.returncode == 0:
        return True, "ARP and DNS caches cleared."
    return False, "Caches not cleared (administrator access was declined)."


# --------------------------------------------------------------------------
# Probing
# --------------------------------------------------------------------------

def ping(ip: str, timeout_ms: int = 1000) -> bool:
    if IS_MAC:
        cmd = ["ping", "-c", "1", "-W", str(timeout_ms), "-q", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", str(max(1, timeout_ms // 1000)), "-q", ip]
    try:
        return subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_ms / 1000 + 2,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def check_port(ip: str, port: int, timeout: float = 1.0) -> tuple[bool, bool]:
    """Return (is_open, host_responded).

    A refused connection still proves the host is alive.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        try:
            err = s.connect_ex((ip, port))
        except OSError:
            return False, False
    if err == 0:
        return True, True
    # ECONNREFUSED: 61 on macOS, 111 on Linux
    return False, err in (61, 111)


def arp_table() -> dict[str, str]:
    """IP -> MAC from the system ARP cache."""
    table = {}
    for m in re.finditer(
        r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]+)", _run(["arp", "-an"])
    ):
        ip, mac = m.groups()
        if mac.count(":") == 5 and mac.lower() != "ff:ff:ff:ff:ff:ff":
            # macOS drops leading zeros (e.g. 0:1a:...), normalise them.
            table[ip] = ":".join(part.zfill(2) for part in mac.lower().split(":"))
    if not table and shutil.which("ip"):
        for m in re.finditer(
            r"(\d+\.\d+\.\d+\.\d+) .*lladdr ([0-9a-f:]{17})",
            _run(["ip", "neigh", "show"]),
        ):
            table[m.group(1)] = m.group(2)
    return table


def local_macs() -> dict[str, str]:
    """IP -> MAC for this machine's own interfaces (not in the ARP cache)."""
    out = {}
    if IS_MAC or not shutil.which("ip"):
        blocks = re.split(r"\n(?=\S)", _run(["ifconfig"]))
        mac_re = r"ether ([0-9a-f:]{17})"
    else:
        blocks = re.split(r"\n(?=\d)", _run(["ip", "addr", "show"]))
        mac_re = r"link/ether ([0-9a-f:]{17})"
    for block in blocks:
        mac = re.search(mac_re, block)
        if mac:
            for ip in re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", block):
                out[ip] = mac.group(1)
    return out


_OUI: dict[str, str] | None = None
_OUI_LOCK = threading.Lock()


def vendor_for_mac(mac: str) -> str:
    """Manufacturer from the IEEE OUI list (data/oui.txt.gz)."""
    global _OUI
    if not mac:
        return ""
    with _OUI_LOCK:
        if _OUI is None:
            _OUI = {}
            path = os.path.join(HERE, "data", "oui.txt.gz")
            try:
                with gzip.open(path, "rt", encoding="utf-8") as f:
                    for line in f:
                        prefix, _, name = line.rstrip("\n").partition("\t")
                        _OUI[prefix] = name
            except OSError:
                pass
    octets = mac.split(":")
    if int(octets[0], 16) & 0x02:
        # Locally administered bit: phones and laptops use a random
        # per-network address that has no manufacturer.
        return "Private (randomized MAC)"
    return _OUI.get("".join(octets[:3]).upper(), "")


def netbios_name(ip: str, timeout: float = 1.0) -> str:
    """Windows/Samba computer name via a NetBIOS node status query."""
    tid = os.urandom(2)
    # Header (1 question) + encoded wildcard name '*' + NBSTAT/IN.
    packet = (tid + b"\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
              + b"\x20CK" + b"A" * 30 + b"\x00" + b"\x00\x21\x00\x01")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        try:
            s.sendto(packet, (ip, 137))
            data, _ = s.recvfrom(2048)
        except OSError:
            return ""
    try:
        if data[:2] != tid:
            return ""
        offset = 12 + 34 + 4 + 4 + 2  # header, name, type/class, ttl, rdlength
        count = data[offset]
        offset += 1
        for _ in range(count):
            raw = data[offset:offset + 15]
            suffix = data[offset + 15]
            flags = struct.unpack(">H", data[offset + 16:offset + 18])[0]
            offset += 18
            if suffix == 0x00 and not flags & 0x8000:  # workstation, unique
                return raw.decode("ascii", "replace").strip()
    except (IndexError, struct.error):
        pass
    return ""


def resolve_hostname(ip: str) -> str:
    """Reverse DNS, then Bonjour/mDNS, then NetBIOS."""
    try:
        name = socket.gethostbyaddr(ip)[0]
        if name and name != ip:
            return name.rstrip(".")
    except (OSError, UnicodeError):
        pass
    if shutil.which("dig"):
        out = _run(
            ["dig", "+short", "+time=1", "+tries=1", "-p", "5353",
             "@224.0.0.251", "-x", ip],
            timeout=3,
        ).strip()
        for line in out.splitlines():
            line = line.strip()
            if line and not line.startswith(";"):
                return line.rstrip(".")
    return netbios_name(ip)


# --------------------------------------------------------------------------
# Scanner
# --------------------------------------------------------------------------

class Scanner:
    """Runs a scan in phases, reporting through callbacks.

    on_host(result) is called whenever a host is found or updated (MAC, a
    newly open port, name), so a UI can show results live.
    on_progress(stage, done, total) reports progress per stage:
    "discover", "ports", "names".
    """

    def __init__(
        self,
        targets: Iterable[str],
        ports: Iterable[int] = DEFAULT_PORTS,
        workers: int = 128,
        timeout: float = 1.0,
        on_host: Callable[[HostResult], None] | None = None,
        on_progress: Callable[[str, int, int], None] | None = None,
    ):
        self.targets = list(targets)
        self.ports = sorted(set(ports))
        self.workers = workers
        self.timeout = timeout
        self.on_host = on_host
        self.on_progress = on_progress
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def _report(self, r: HostResult) -> None:
        if self.on_host:
            # Hand out a copy: the scan keeps filling in ports from other threads.
            self.on_host(replace(r, ports=dict(r.ports)))

    def _progress(self, stage: str, done: int, total: int) -> None:
        if self.on_progress:
            self.on_progress(stage, done, total)

    def _ping(self, ip: str) -> bool:
        return not self.stopped and ping(ip, int(self.timeout * 1000))

    def _port(self, ip: str, port: int) -> bool:
        return not self.stopped and check_port(ip, port, self.timeout)[0]

    def _name(self, ip: str) -> str:
        return "" if self.stopped else resolve_hostname(ip)

    def run(self) -> list[HostResult]:
        mine = local_ips()
        results: dict[str, HostResult] = {}
        total = len(self.targets)

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            # Phase 1: ping sweep.
            futures = {pool.submit(self._ping, ip): ip for ip in self.targets}
            for done, fut in enumerate(as_completed(futures), 1):
                ip = futures[fut]
                if fut.result() or ip in mine:
                    results[ip] = HostResult(ip=ip)
                    self._report(results[ip])
                self._progress("discover", done, total)

            # The sweep filled the ARP cache, so hosts that ignore ping
            # (firewalled Macs, Windows PCs, ...) show up there.
            arp = arp_table()
            arp.update(local_macs())
            if not self.stopped:
                wanted = set(self.targets)
                for ip in arp:
                    if ip in wanted and ip not in results:
                        results[ip] = HostResult(ip=ip)
            for r in results.values():
                r.mac = arp.get(r.ip, "")
                r.vendor = vendor_for_mac(r.mac)
                self._report(r)

            # Phase 2: every port on every alive host, all in parallel.
            jobs = {
                pool.submit(self._port, ip, port): (ip, port)
                for ip in results for port in self.ports
            }
            for done, fut in enumerate(as_completed(jobs), 1):
                ip, port = jobs[fut]
                results[ip].ports[port] = fut.result()
                if fut.result():
                    self._report(results[ip])
                self._progress("ports", done, len(jobs))

            # Phase 3: names.
            names = {pool.submit(self._name, ip): ip for ip in results}
            for done, fut in enumerate(as_completed(names), 1):
                r = results[names[fut]]
                r.hostname = fut.result()
                self._report(r)
                self._progress("names", done, len(names))

        return sorted(results.values(), key=lambda r: r.sort_key)


def write_csv(path: str, results: list[HostResult]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Status", "Name", "IP", "Manufacturer", "MAC address", "Open ports"])
        for r in results:
            w.writerow([
                "Alive", r.hostname, r.ip, r.vendor, r.mac,
                "; ".join(f"{p} ({service_name(p)})" for p in r.open_ports()),
            ])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scan the local IPv4 network.")
    ap.add_argument("targets", nargs="*",
                    help="ranges, e.g. 192.168.1.1-254 or 10.0.0.0/24 (default: auto-detect)")
    ap.add_argument("-p", "--ports", default=",".join(map(str, DEFAULT_PORTS)),
                    help="ports, e.g. 22,80,8000-8010 (default: common ports)")
    ap.add_argument("-t", "--timeout", type=float, default=1.0)
    ap.add_argument("-w", "--workers", type=int, default=128)
    ap.add_argument("--no-flush", action="store_true",
                    help="don't wipe the ARP and DNS caches before scanning")
    ap.add_argument("--csv", help="also write results to this CSV file")
    ap.add_argument("--pdf", help="also write a printable landscape PDF report")
    ap.add_argument("--paper", choices=("letter", "a4"),
                    help="PDF paper size (default: from your Mac's region settings)")
    args = ap.parse_args(argv)

    try:
        spec = " ".join(args.targets) or ", ".join(
            network_to_range(n) for n in detect_local_networks())
        targets = parse_targets(spec)
        ports = parse_ports(args.ports)
    except ValueError as e:
        ap.error(str(e))
    if not targets:
        ap.error("no local IPv4 network detected; pass a range such as 192.168.1.1-254")

    if not args.no_flush:
        print(flush_caches()[1], file=sys.stderr)

    print(f"Scanning {spec} ({len(targets)} addresses, {len(ports)} ports)",
          file=sys.stderr)
    labels = {"discover": "Discovering", "ports": "Checking ports", "names": "Resolving names"}

    def progress(stage: str, done: int, total: int) -> None:
        print(f"\r  {labels[stage]}: {done}/{total}\033[K", end="", file=sys.stderr, flush=True)

    scanner = Scanner(targets, ports, args.workers, args.timeout, on_progress=progress)
    try:
        results = scanner.run()
    except KeyboardInterrupt:
        scanner.stop()
        return 130
    print(file=sys.stderr)

    header = f"{'IP':<16} {'Name':<32} {'Manufacturer':<26} {'MAC address':<18} Open ports"
    print(header)
    print("-" * (len(header) + 20))
    for r in results:
        print(f"{r.ip:<16} {(r.hostname or '-')[:32]:<32} {(r.vendor or '-')[:26]:<26} "
              f"{(r.mac or '-'):<18} {', '.join(map(str, r.open_ports())) or '-'}")
    print(f"\n{len(results)} alive, {len(targets) - len(results)} dead.")

    if args.csv:
        write_csv(args.csv, results)
        print(f"Saved {args.csv}", file=sys.stderr)
    if args.pdf:
        import report
        report.build_pdf(results, args.pdf, scanned=spec, total=len(targets),
                         ports=ports, paper=args.paper or report.default_paper())
        print(f"Saved {args.pdf}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
