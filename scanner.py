#!/usr/bin/env python3
"""IPv4 network scanner core (standard library only).

Finds alive hosts on the local network(s), resolves their hostnames and
checks a set of TCP ports. Can be used on its own from the command line:

    python3 scanner.py                    # scan all detected local subnets
    python3 scanner.py 192.168.1.0/24     # scan a specific subnet
    python3 scanner.py --csv results.csv
"""

from __future__ import annotations

import argparse
import csv
import ipaddress
import re
import shutil
import socket
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable, Iterable

DEFAULT_PORTS = (80, 8000, 8081, 8123)
# Subnets bigger than this are refused unless explicitly allowed, so a
# misdetected /8 doesn't turn into a 16-million-host scan.
MAX_HOSTS = 65536

IS_MAC = sys.platform == "darwin"


@dataclass
class HostResult:
    ip: str
    hostname: str = ""
    mac: str = ""
    ports: dict[int, bool] = field(default_factory=dict)

    @property
    def sort_key(self) -> int:
        return int(ipaddress.IPv4Address(self.ip))

    def open_ports(self) -> list[int]:
        return sorted(p for p, is_open in self.ports.items() if is_open)


# --------------------------------------------------------------------------
# Subnet detection
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


def detect_local_networks() -> list[ipaddress.IPv4Network]:
    """Return the IPv4 networks this machine is directly attached to."""
    if shutil.which("ifconfig") and (IS_MAC or not shutil.which("ip")):
        interfaces = parse_ifconfig(_run(["ifconfig"]))
    else:
        interfaces = parse_ip_addr(_run(["ip", "-o", "-4", "addr", "show"]))

    networks = []
    for iface in interfaces:
        ip = iface.ip
        if ip.is_loopback or ip.is_link_local or iface.network.prefixlen >= 31:
            continue
        if iface.network not in networks:
            networks.append(iface.network)
    return networks


def local_ips() -> set[str]:
    if IS_MAC or not shutil.which("ip"):
        return {str(i.ip) for i in parse_ifconfig(_run(["ifconfig"]))}
    return {str(i.ip) for i in parse_ip_addr(_run(["ip", "-o", "-4", "addr", "show"]))}


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
        if mac.count(":") == 5:
            # macOS drops leading zeros (e.g. 0:1a:...), normalise them.
            table[ip] = ":".join(part.zfill(2) for part in mac.lower().split(":"))
    if not table and shutil.which("ip"):
        for m in re.finditer(
            r"(\d+\.\d+\.\d+\.\d+) .*lladdr ([0-9a-f:]{17})",
            _run(["ip", "neigh", "show"]),
        ):
            table[m.group(1)] = m.group(2)
    return table


def resolve_hostname(ip: str) -> str:
    """Reverse DNS, falling back to a multicast DNS (Bonjour) query."""
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
    return ""


# --------------------------------------------------------------------------
# Scanner
# --------------------------------------------------------------------------

class Scanner:
    def __init__(
        self,
        networks: Iterable[ipaddress.IPv4Network],
        ports: Iterable[int] = DEFAULT_PORTS,
        workers: int = 128,
        timeout: float = 1.0,
        on_host: Callable[[HostResult], None] | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ):
        self.networks = list(networks)
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

    def targets(self) -> list[str]:
        seen, out = set(), []
        for net in self.networks:
            for ip in net.hosts():
                s = str(ip)
                if s not in seen:
                    seen.add(s)
                    out.append(s)
        return out

    def _check_ports(self, ip: str) -> HostResult:
        ports = {}
        for port in self.ports:
            if self.stopped:
                break
            ports[port] = check_port(ip, port, self.timeout)[0]
        return HostResult(ip=ip, ports=ports)

    def _probe(self, ip: str, known_alive: bool) -> HostResult | None:
        if self.stopped:
            return None
        if known_alive or ping(ip, int(self.timeout * 1000)):
            return self._check_ports(ip)
        return None

    def _collect(self, futures, results, report, progress=False) -> None:
        for fut in as_completed(futures):
            r = fut.result()
            if r:
                results[r.ip] = r
                report(r)
            if progress:
                self._done += 1
                if self.on_progress:
                    self.on_progress(self._done, self._total)

    def run(self) -> list[HostResult]:
        targets = self.targets()
        self._total, self._done = len(targets), 0
        mine = local_ips()
        results: dict[str, HostResult] = {}

        def report(r: HostResult) -> None:
            if self.on_host:
                self.on_host(r)

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            # Phase 1: ping sweep; alive hosts get their ports checked.
            self._collect(
                [pool.submit(self._probe, ip, ip in mine) for ip in targets],
                results, report, progress=True,
            )

            # Phase 2: the sweep filled the ARP cache, so hosts that ignore
            # ping (firewalled Macs, Windows PCs, ...) still show up here.
            arp = arp_table()
            if not self.stopped:
                wanted = set(targets)
                missed = [ip for ip in arp if ip in wanted and ip not in results]
                self._collect(
                    [pool.submit(self._check_ports, ip) for ip in missed],
                    results, report,
                )

            # Phase 3: MAC addresses and hostnames.
            for r in results.values():
                r.mac = arp.get(r.ip, "")

            def named(r: HostResult) -> HostResult:
                if not self.stopped:
                    r.hostname = resolve_hostname(r.ip)
                return r

            self._collect(
                [pool.submit(named, r) for r in list(results.values())],
                results, report,
            )
        return sorted(results.values(), key=lambda r: r.sort_key)


def write_csv(path: str, results: list[HostResult], ports: list[int]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["IP", "Hostname", "MAC"] + [f"Port {p}" for p in ports])
        for r in results:
            w.writerow(
                [r.ip, r.hostname, r.mac]
                + ["open" if r.ports.get(p) else "closed" for p in ports]
            )


def parse_networks(specs: Iterable[str]) -> list[ipaddress.IPv4Network]:
    nets = []
    for spec in specs:
        net = ipaddress.IPv4Network(spec.strip(), strict=False)
        if net.num_addresses > MAX_HOSTS:
            raise ValueError(
                f"{net} has {net.num_addresses:,} addresses; "
                f"the limit is {MAX_HOSTS:,} (/16)."
            )
        nets.append(net)
    return nets


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scan the local IPv4 network.")
    ap.add_argument("networks", nargs="*", help="CIDR(s), default: auto-detect")
    ap.add_argument("-p", "--ports", default=",".join(map(str, DEFAULT_PORTS)),
                    help="comma-separated TCP ports (default: %(default)s)")
    ap.add_argument("-t", "--timeout", type=float, default=1.0)
    ap.add_argument("-w", "--workers", type=int, default=128)
    ap.add_argument("--csv", help="also write results to this CSV file")
    args = ap.parse_args(argv)

    try:
        nets = parse_networks(args.networks) if args.networks else detect_local_networks()
        ports = [int(p) for p in args.ports.split(",") if p.strip()]
    except ValueError as e:
        ap.error(str(e))
    if not nets:
        ap.error("no local IPv4 network detected; pass a CIDR such as 192.168.1.0/24")

    print("Scanning " + ", ".join(map(str, nets)) + f" on ports {ports}", file=sys.stderr)

    def progress(done: int, total: int) -> None:
        print(f"\r  {done}/{total} addresses probed", end="", file=sys.stderr, flush=True)

    scanner = Scanner(nets, ports, args.workers, args.timeout, on_progress=progress)
    try:
        results = scanner.run()
    except KeyboardInterrupt:
        scanner.stop()
        return 130
    print(file=sys.stderr)

    header = f"{'IP':<16} {'Hostname':<36} {'MAC':<18} " + " ".join(f"{p:>5}" for p in ports)
    print(header)
    print("-" * len(header))
    for r in results:
        cells = " ".join(f"{'open' if r.ports.get(p) else '-':>5}" for p in ports)
        print(f"{r.ip:<16} {(r.hostname or '-')[:36]:<36} {(r.mac or '-'):<18} {cells}")
    print(f"\n{len(results)} alive host(s).")

    if args.csv:
        write_csv(args.csv, results, ports)
        print(f"Saved {args.csv}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
