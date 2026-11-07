"""Reads memory and disk usage on macOS (standard library only).

Memory figures follow Activity Monitor's Memory tab:
  App memory   = anonymous pages - purgeable pages
  Wired        = pages wired down
  Compressed   = pages occupied by the compressor
  Cached files = file-backed pages + purgeable pages
  Used         = app + wired + compressed
Disk figures come from statvfs(), like `df`: used = size - free.

Linux is supported too (via /proc), so the code can be tested anywhere.
"""

from __future__ import annotations

import os
import plistlib
import re
import subprocess
import sys
from dataclasses import dataclass, field

__version__ = "1.0.0"

IS_MAC = sys.platform == "darwin"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class Memory:
    total: int = 0
    app: int = 0
    wired: int = 0
    compressed: int = 0
    cached: int = 0
    swap_total: int = 0
    swap_used: int = 0
    pressure: str = "normal"   # normal / warning / critical

    @property
    def used(self) -> int:
        return min(self.app + self.wired + self.compressed, self.total)

    @property
    def free(self) -> int:
        return max(self.total - self.used - self.cached, 0)

    @property
    def percent(self) -> float:
        return 100.0 * self.used / self.total if self.total else 0.0


@dataclass
class Volume:
    name: str
    mount: str
    device: str
    fstype: str
    kind: str          # Internal / External / Network / Disk image
    total: int
    free: int
    read_only: bool = False

    @property
    def used(self) -> int:
        return max(self.total - self.free, 0)

    @property
    def percent(self) -> float:
        return 100.0 * self.used / self.total if self.total else 0.0


@dataclass
class Process:
    pid: int
    name: str
    rss: int


@dataclass
class Snapshot:
    memory: Memory
    volumes: list[Volume] = field(default_factory=list)
    processes: list[Process] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(args: list[str], timeout: float = 5.0) -> str:
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                             check=False)
        return out.stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _sysctl(key: str) -> str:
    return _run(["/usr/sbin/sysctl", "-n", key]).strip()


_UNITS = {"": 1, "B": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4}


def _size(text: str) -> int:
    """'1024.50M' -> bytes."""
    m = re.match(r"\s*([\d.]+)\s*([KMGT]?)", text, re.I)
    if not m:
        return 0
    return int(float(m.group(1)) * _UNITS[m.group(2).upper()])


def format_bytes(n: float, binary: bool = False) -> str:
    """Apple-style sizes: decimal for disks (like Finder), binary for memory
    (like Activity Monitor). Both are labelled KB/MB/GB/TB as Apple does."""
    step = 1024.0 if binary else 1000.0
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if abs(n) < step or unit == "TB":
            if unit == "bytes":
                return f"{int(n)} bytes"
            return f"{n:.2f} {unit}" if n < 100 else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} PB"


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------

def parse_vm_stat(text: str) -> tuple[int, dict[str, int]]:
    """Returns (page size, {label: page count}) from `vm_stat` output."""
    page = 4096
    m = re.search(r"page size of (\d+) bytes", text)
    if m:
        page = int(m.group(1))
    pages = {}
    for line in text.splitlines():
        m = re.match(r'\s*"?([^":]+?)"?:\s+(\d+)\.?\s*$', line)
        if m:
            pages[m.group(1).strip()] = int(m.group(2))
    return page, pages


def parse_swapusage(text: str) -> tuple[int, int]:
    """'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'."""
    total = re.search(r"total\s*=\s*([\d.]+[KMGT]?)", text)
    used = re.search(r"used\s*=\s*([\d.]+[KMGT]?)", text)
    return (_size(total.group(1)) if total else 0, _size(used.group(1)) if used else 0)


PRESSURE_LEVELS = {"1": "normal", "2": "warning", "4": "critical"}


def memory_from_vm_stat(text: str, total: int) -> Memory:
    page, p = parse_vm_stat(text)
    anon = p.get("Anonymous pages", p.get("Pages active", 0))
    purgeable = p.get("Pages purgeable", 0)
    file_backed = p.get("File-backed pages", p.get("Pages inactive", 0))
    return Memory(
        total=total,
        app=max(anon - purgeable, 0) * page,
        wired=p.get("Pages wired down", 0) * page,
        compressed=p.get("Pages occupied by compressor", 0) * page,
        cached=(file_backed + purgeable) * page,
    )


def _memory_mac() -> Memory:
    total = int(_sysctl("hw.memsize") or 0)
    mem = memory_from_vm_stat(_run(["/usr/bin/vm_stat"]), total)
    mem.swap_total, mem.swap_used = parse_swapusage(_sysctl("vm.swapusage"))
    mem.pressure = PRESSURE_LEVELS.get(_sysctl("kern.memorystatus_vm_pressure_level"),
                                       "normal")
    return mem


def memory_from_meminfo(text: str) -> Memory:
    info = {}
    for line in text.splitlines():
        m = re.match(r"(\w+(?:\(\w+\))?):\s+(\d+)", line)
        if m:
            info[m.group(1)] = int(m.group(2)) * 1024
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", info.get("MemFree", 0))
    cached = info.get("Cached", 0) + info.get("Buffers", 0)
    used = max(total - available, 0)
    mem = Memory(total=total, app=used, cached=min(cached, total - used),
                 swap_total=info.get("SwapTotal", 0),
                 swap_used=info.get("SwapTotal", 0) - info.get("SwapFree", 0))
    pct = used / total if total else 0
    mem.pressure = "critical" if pct > 0.95 else "warning" if pct > 0.85 else "normal"
    return mem


def memory() -> Memory:
    if IS_MAC:
        return _memory_mac()
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            return memory_from_meminfo(f.read())
    except OSError:
        return Memory()


# ---------------------------------------------------------------------------
# Disks
# ---------------------------------------------------------------------------

_MOUNT_RE = re.compile(r"^(.+?) on (.+) \(([^()]*)\)\s*$")
NETWORK_FS = {"smbfs", "afpfs", "nfs", "webdav", "cifs", "nfs4", "sshfs", "fuse.sshfs"}


def parse_mount(text: str) -> list[tuple[str, str, str, list[str]]]:
    """macOS `mount` output -> [(device, mount point, fs type, options)] for the
    volumes Finder shows: the startup disk and anything under /Volumes."""
    out = []
    for line in text.splitlines():
        m = _MOUNT_RE.match(line)
        if not m:
            continue
        device, mount, opts = m.group(1), m.group(2), [o.strip() for o in m.group(3).split(",")]
        fstype = opts[0] if opts else ""
        if "nobrowse" in opts:
            continue
        if mount != "/" and not mount.startswith("/Volumes/"):
            continue
        if not (device.startswith("/dev/") or device.startswith("//") or fstype in NETWORK_FS):
            continue
        out.append((device, mount, fstype, opts))
    return out


def parse_proc_mounts(text: str) -> list[tuple[str, str, str, list[str]]]:
    out, seen = [], set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        device, mount, fstype, opts = parts[0], parts[1].replace("\\040", " "), parts[2], \
            parts[3].split(",")
        real = device.startswith("/dev/") and not device.startswith("/dev/loop")
        if not (real or fstype in NETWORK_FS) or device in seen:
            continue
        if mount.startswith(("/snap/", "/boot/efi")):
            continue
        seen.add(device)
        out.append((device, mount, fstype, opts))
    return out


_disk_info: dict[str, dict] = {}


def _diskutil(device: str) -> dict:
    if device not in _disk_info:
        try:
            _disk_info[device] = plistlib.loads(
                _run(["/usr/sbin/diskutil", "info", "-plist", device]).encode())
        except (ValueError, plistlib.InvalidFileException):
            _disk_info[device] = {}
    return _disk_info[device]


def _describe(device: str, mount: str, fstype: str) -> tuple[str, str]:
    """(display name, kind) for a volume."""
    name = os.path.basename(mount.rstrip("/")) or "Macintosh HD"
    if fstype in NETWORK_FS or device.startswith("//"):
        return name, "Network"
    if not IS_MAC:
        return (name if mount != "/" else "System"), "Internal"
    info = _diskutil(device)
    if mount == "/":
        name = info.get("VolumeName") or "Macintosh HD"
    if info.get("BusProtocol") == "Disk Image":
        return name, "Disk image"
    if info.get("Internal") is False or info.get("RemovableMediaOrExternalDevice"):
        return name, "External"
    return name, "Internal"


def volumes() -> list[Volume]:
    if IS_MAC:
        entries = parse_mount(_run(["/sbin/mount"]))
    else:
        try:
            with open("/proc/mounts", encoding="utf-8") as f:
                entries = parse_proc_mounts(f.read())
        except OSError:
            entries = []
    vols = []
    for device, mount, fstype, opts in entries:
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total <= 0:
            continue
        name, kind = _describe(device, mount, fstype)
        vols.append(Volume(name=name, mount=mount, device=device, fstype=fstype, kind=kind,
                           total=total, free=st.f_bavail * st.f_frsize,
                           read_only="read-only" in opts or "ro" in opts))
    # The startup disk first, then by name.
    vols.sort(key=lambda v: (v.mount != "/", v.name.lower()))
    return vols


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

def parse_ps(text: str) -> list[Process]:
    procs = []
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        name = os.path.basename(parts[2].strip()) or parts[2].strip()
        procs.append(Process(pid=int(parts[0]), name=name, rss=int(parts[1]) * 1024))
    procs.sort(key=lambda p: p.rss, reverse=True)
    return procs


def top_processes(count: int = 10) -> list[Process]:
    flag = "-ax" if IS_MAC else "-e"
    return parse_ps(_run(["ps", flag, "-o", "pid=,rss=,comm="]))[:count]


def snapshot(process_count: int = 10) -> Snapshot:
    return Snapshot(memory=memory(), volumes=volumes(),
                    processes=top_processes(process_count))


def main() -> None:
    """Prints a one-off summary: python3 sysmon.py"""
    snap = snapshot()
    m = snap.memory
    print(f"Memory  {format_bytes(m.used, True)} used of {format_bytes(m.total, True)} "
          f"({m.percent:.0f}%), pressure {m.pressure}")
    print(f"        app {format_bytes(m.app, True)}, wired {format_bytes(m.wired, True)}, "
          f"compressed {format_bytes(m.compressed, True)}, "
          f"cached files {format_bytes(m.cached, True)}")
    print(f"Swap    {format_bytes(m.swap_used, True)} used of {format_bytes(m.swap_total, True)}")
    print()
    for v in snap.volumes:
        print(f"{v.name:<24} {format_bytes(v.used):>10} used of {format_bytes(v.total):>10}  "
              f"{format_bytes(v.free):>10} free  ({v.percent:.0f}%)  {v.kind}  {v.mount}")
    print()
    for p in snap.processes:
        print(f"{p.pid:>7}  {format_bytes(p.rss, True):>10}  {p.name}")


if __name__ == "__main__":
    main()
