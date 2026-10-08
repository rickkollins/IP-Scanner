"""Printable landscape PDF report of scan results (standard library only).

The PDF is written by hand using the built-in Helvetica fonts, so nothing
needs to be installed. Open it in Preview and press Cmd+P to print.
"""

from __future__ import annotations

import subprocess
import time
import zlib
from dataclasses import dataclass
from typing import Iterable

import scanner

# Page sizes in points (1/72 inch), landscape.
PAPER = {"letter": (792.0, 612.0), "a4": (841.89, 595.28)}
MARGIN = 36.0  # half an inch

# Helvetica glyph widths (per 1000 units) for ASCII 32..126, from the
# standard Adobe font metrics. Other characters use AVG_WIDTH.
_HELV = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
AVG_WIDTH = 556
BOLD_FACTOR = 1.06  # Helvetica-Bold is slightly wider


def text_width(text: str, size: float, bold: bool = False) -> float:
    units = sum(_HELV[ord(c) - 32] if 32 <= ord(c) <= 126 else AVG_WIDTH for c in text)
    return units * size / 1000 * (BOLD_FACTOR if bold else 1)


def fit(text: str, width: float, size: float, bold: bool = False) -> str:
    """Truncate text with '...' so it fits in width."""
    if text_width(text, size, bold) <= width:
        return text
    while text and text_width(text + "...", size, bold) > width:
        text = text[:-1]
    return text.rstrip() + "..."


def wrap(text: str, width: float, size: float) -> list[str]:
    """Wrap a comma-separated list onto as many lines as needed."""
    if not text:
        return [""]
    lines, line = [], ""
    for item in text.split(", "):
        candidate = f"{line}, {item}" if line else item
        if text_width(candidate, size) <= width:
            line = candidate
        else:
            if line:
                lines.append(line + ",")
            line = fit(item, width, size)
    lines.append(line)
    return lines


def default_paper() -> str:
    """A4 when macOS is set to metric units, otherwise US Letter."""
    out = ""
    if scanner.IS_MAC:
        try:
            out = subprocess.run(["defaults", "read", "-g", "AppleMetricUnits"],
                                 capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            pass
    return "a4" if out.strip() == "1" else "letter"


@dataclass
class Column:
    title: str
    share: float  # fraction of the table width


# Same columns as the app's list. Each host row is followed by one row per
# open service, like a fully expanded list in the app.
COLUMNS = [
    Column("#", 0.04),
    Column("Name", 0.24),
    Column("IP", 0.12),
    Column("Manufacturer", 0.20),
    Column("MAC address", 0.14),
    Column("Comments", 0.26),
]

ALIVE = (0.18, 0.62, 0.27)    # green status dot
SERVICE = (0.18, 0.45, 0.82)  # blue service dot and text


def _fill(color) -> str:
    if isinstance(color, tuple):
        return "%.3f %.3f %.3f rg" % color
    return f"{color:.3f} g"


class _Page:
    def __init__(self) -> None:
        self.ops: list[str] = []

    def text(self, x: float, y: float, s: str, size: float, bold: bool = False,
             gray=0.0) -> None:
        esc = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        font = "F2" if bold else "F1"
        self.ops.append(f"BT {_fill(gray)} /{font} {size:.1f} Tf {x:.2f} {y:.2f} Td ({esc}) Tj ET")

    def rect(self, x: float, y: float, w: float, h: float, gray) -> None:
        self.ops.append(f"{_fill(gray)} {x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")

    def dot(self, cx: float, cy: float, r: float, color) -> None:
        k = 0.5523 * r  # Bezier approximation of a circle
        self.ops.append(
            f"{_fill(color)} {cx + r:.2f} {cy:.2f} m "
            f"{cx + r:.2f} {cy + k:.2f} {cx + k:.2f} {cy + r:.2f} {cx:.2f} {cy + r:.2f} c "
            f"{cx - k:.2f} {cy + r:.2f} {cx - r:.2f} {cy + k:.2f} {cx - r:.2f} {cy:.2f} c "
            f"{cx - r:.2f} {cy - k:.2f} {cx - k:.2f} {cy - r:.2f} {cx:.2f} {cy - r:.2f} c "
            f"{cx + k:.2f} {cy - r:.2f} {cx + r:.2f} {cy - k:.2f} {cx + r:.2f} {cy:.2f} c f")

    def line(self, x1: float, y1: float, x2: float, y2: float, gray: float = 0.6,
             width: float = 0.5) -> None:
        self.ops.append(f"{gray:.2f} G {width:.2f} w {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")


def build_pdf(
    results: Iterable[scanner.HostResult],
    path: str,
    scanned: str = "",
    total: int = 0,
    ports: Iterable[int] = (),
    paper: str = "letter",
) -> int:
    """Write the report to path. Returns the number of pages."""
    results = list(results)
    page_w, page_h = PAPER.get(paper, PAPER["letter"])
    table_w = page_w - 2 * MARGIN
    xs, x = [], MARGIN
    for col in COLUMNS:
        xs.append(x)
        x += col.share * table_w
    widths = [c.share * table_w for c in COLUMNS]
    pad = 4.0
    size = 8.5
    host_h, svc_h = 15.0, 12.5
    indent = 14.0  # service rows sit under the host name, like the app
    stamp = time.strftime("%Y-%m-%d %H:%M")

    pages: list[_Page] = []

    def new_page() -> tuple[_Page, float]:
        pg = _Page()
        pages.append(pg)
        y = page_h - MARGIN
        if len(pages) == 1:
            pg.text(MARGIN, y - 14, "Network Scan Report", 16, bold=True)
            y -= 32
            ports_list = list(ports)
            services = sum(len(r.open_ports()) for r in results)
            details = [
                f"Scanned: {scanned}" if scanned else "",
                f"Date: {stamp}",
                f"Alive hosts: {len(results)}" + (f" of {total} addresses" if total else ""),
                f"Open services: {services}",
            ]
            pg.text(MARGIN, y, fit("     ".join(d for d in details if d), table_w, 9),
                    9, gray=0.25)
            y -= 13
            if ports_list:
                text = "Ports checked: " + ", ".join(map(str, ports_list))
                for ln in wrap(text, table_w, 8):
                    pg.text(MARGIN, y, ln, 8, gray=0.4)
                    y -= 11
                y -= 2
            y -= 6
        # Table header, repeated on every page.
        pg.rect(MARGIN, y - 16, table_w, 16, 0.85)
        for cx, col in zip(xs, COLUMNS):
            pg.text(cx + pad, y - 11.5, col.title, 8.5, bold=True)
        return pg, y - 16

    page, y = new_page()
    bottom = MARGIN + 18  # leave room for the footer
    usable = (page_h - 2 * MARGIN) - 40

    for i, r in enumerate(results, 1):
        open_ports = r.open_ports()
        block_h = host_h + len(open_ports) * svc_h + (3 if open_ports else 0)
        # Keep a host and its services together unless they need a whole page.
        if y - block_h < bottom and (block_h <= usable or y - host_h - svc_h < bottom):
            page, y = new_page()
        if i % 2 == 0:
            page.rect(MARGIN, max(y - block_h, bottom), table_w, min(block_h, y - bottom), 0.955)

        # Host row: # | dot + name | IP | manufacturer | MAC | summary
        base = y - host_h + 4.5
        count = len(open_ports)
        summary = f"{count} open port{'s' if count != 1 else ''}" if count else "No open ports"
        page.text(xs[0] + pad, base, str(i), size, gray=0.35)
        page.dot(xs[1] + pad + 3, base + 3, 3, ALIVE)
        cells = [r.hostname or "-", r.ip, r.vendor or "-", r.mac or "-", summary]
        offsets = [indent, 0, 0, 0, 0]
        for k, (cell, off) in enumerate(zip(cells, offsets), 1):
            page.text(xs[k] + pad + off, base,
                      fit(cell, widths[k] - 2 * pad - off, size), size,
                      bold=(k == 1), gray=0.45 if k == 5 else 0.0)
        y -= host_h

        # Service rows: dot + service | port N | | | link
        for p in open_ports:
            if y - svc_h < bottom:
                page, y = new_page()
            base = y - svc_h + 3.5
            page.dot(xs[1] + pad + indent + 2.5, base + 2.8, 2.3, SERVICE)
            page.text(xs[1] + pad + indent + 10, base,
                      fit(scanner.service_name(p), widths[1] - 2 * pad - indent - 10, size),
                      size, gray=SERVICE)
            page.text(xs[2] + pad, base, f"port {p}", size, gray=SERVICE)
            url = scanner.service_url(r.ip, p) or ""
            page.text(xs[5] + pad, base, fit(url, widths[5] - 2 * pad, size), size,
                      gray=SERVICE)
            y -= svc_h
        if open_ports:
            y -= 3
        page.line(MARGIN, y, MARGIN + table_w, y, gray=0.8)

    if not results:
        page.text(MARGIN + pad, y - 16, "No alive hosts found.", 10, gray=0.4)

    # Footers.
    for n, pg in enumerate(pages, 1):
        pg.text(MARGIN, MARGIN - 4, f"IP Scanner  -  {stamp}", 7.5, gray=0.5)
        label = f"Page {n} of {len(pages)}"
        pg.text(page_w - MARGIN - text_width(label, 7.5), MARGIN - 4, label, 7.5, gray=0.5)

    _write(path, pages, page_w, page_h)
    return len(pages)


def _write(path: str, pages: list[_Page], page_w: float, page_h: float) -> None:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")  # filled in below
    pages_id = add(b"")
    f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
             b"/Encoding /WinAnsiEncoding >>")
    f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
             b"/Encoding /WinAnsiEncoding >>")
    kids = []
    for pg in pages:
        data = zlib.compress("\n".join(pg.ops).encode("cp1252", "replace"))
        content = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data)
                      + data + b"\nendstream")
        kids.append(add(
            (f"<< /Type /Page /Parent {pages_id} 0 R "
             f"/MediaBox [0 0 {page_w:.2f} {page_h:.2f}] "
             f"/Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R >> >> "
             f"/Contents {content} 0 R >>").encode()))
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()
    objects[pages_id - 1] = (
        f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] "
        f"/Count {len(kids)} >>").encode()

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objects) + 1, catalog, xref))
    with open(path, "wb") as f:
        f.write(out)
