#!/usr/bin/env python3
"""System Monitor: live memory and disk usage for macOS (Tkinter).

Run from the repository:  python3 system_monitor/monitor_gui.py
Build the app:            ./system_monitor/build_app.sh
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import font as tkfont
from tkinter import messagebox, ttk

HERE = os.path.dirname(os.path.abspath(__file__))
# theme.py sits next to this file in the .app, and one level up in the repo.
for _path in (HERE, os.path.dirname(HERE)):
    if os.path.exists(os.path.join(_path, "theme.py")) and _path not in sys.path:
        sys.path.insert(0, _path)

import sysmon  # noqa: E402
import theme  # noqa: E402
from sysmon import format_bytes  # noqa: E402

SETTINGS = os.path.expanduser("~/.system_monitor.json")
INTERVALS = (1, 2, 5, 10)
HISTORY = 150  # samples kept for the memory graph

# Memory segment colours (light, dark), in the order they are drawn.
SEGMENTS = [
    ("app", "App memory", ("#2b8be0", "#4fb3ff")),
    ("wired", "Wired", ("#e0861f", "#ffad4f")),
    ("compressed", "Compressed", ("#9b59d0", "#c08cff")),
    ("cached", "Cached files", ("#8fc3ef", "#2f6a99")),
]
LEVELS = {  # usage colours (light, dark)
    "ok": ("#21a35b", "#3ddc84"),
    "warn": ("#e0a21f", "#ffc94f"),
    "danger": ("#d9443b", "#ff6b61"),
}
PRESSURE_LEVEL = {"normal": "ok", "warning": "warn", "critical": "danger"}


def load_settings() -> dict:
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    try:
        with open(SETTINGS, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except OSError:
        pass


def level_for(percent: float) -> str:
    return "danger" if percent >= 90 else "warn" if percent >= 75 else "ok"


# ---------------------------------------------------------------------------
# Canvas widgets
# ---------------------------------------------------------------------------

class UsageBar(tk.Canvas):
    """A pill-shaped bar made of coloured segments (fractions of 0..1)."""

    def __init__(self, master, height: int = 14, **kw):
        super().__init__(master, height=height, highlightthickness=0, borderwidth=0, **kw)
        self.h = height
        self.segments: list[tuple[float, str]] = []
        self.trough = "#eeeeee"
        self.bind("<Configure>", lambda e: self.redraw())

    def set(self, segments: list[tuple[float, str]], trough: str, bg: str) -> None:
        self.segments, self.trough = segments, trough
        self.configure(background=bg)
        self.redraw()

    def _pill(self, x0: float, x1: float, color: str, left: bool, right: bool) -> None:
        h, r = self.h, self.h / 2
        if x1 - x0 < 0.5:
            return
        a, b = (x0 + r if left else x0), (x1 - r if right else x1)
        if b > a:
            self.create_rectangle(a, 0, b, h, fill=color, outline=color)
        if left:
            self.create_oval(x0, 0, x0 + h, h, fill=color, outline=color)
        if right:
            self.create_oval(x1 - h, 0, x1, h, fill=color, outline=color)

    def redraw(self) -> None:
        self.delete("all")
        w = max(self.winfo_width(), 2 * self.h)
        self._pill(0, w, self.trough, True, True)
        x, r = 0.0, self.h / 2
        for frac, color in self.segments:
            if frac <= 0:
                continue
            x1 = min(x + frac * w, w)
            # Round the ends that touch the ends of the bar.
            self._pill(x, x1, color, x < r, x1 > w - r)
            x = x1


class Graph(tk.Canvas):
    """Area chart of the last HISTORY percentages (0..100)."""

    def __init__(self, master, **kw):
        super().__init__(master, height=72, highlightthickness=0, borderwidth=0, **kw)
        self.values: list[float] = []
        self.colors = {"line": "#2b8be0", "fill": "#d9ebfb", "grid": "#e5eef7",
                       "text": "#888888", "bg": "#ffffff"}
        self.font = None
        self.bind("<Configure>", lambda e: self.redraw())

    def set(self, values: list[float], colors: dict, font) -> None:
        self.values, self.colors, self.font = values, colors, font
        self.configure(background=colors["bg"])
        self.redraw()

    def redraw(self) -> None:
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 10 or h < 10:
            return
        c, top, bottom = self.colors, 4, h - 2
        if len(self.values) >= 2:
            self._area(w, top, bottom)
        for pct in (50, 100):  # grid on top of the area so the labels stay visible
            y = bottom - (bottom - top) * pct / 100
            self.create_line(0, y, w, y, fill=c["grid"], dash=(2, 3))
            self.create_text(w - 2, y + 1, text=f"{pct}%", anchor="ne", fill=c["text"],
                             font=self.font)

    def _area(self, w: int, top: int, bottom: int) -> None:
        c = self.colors
        step = w / (HISTORY - 1)
        x0 = w - step * (len(self.values) - 1)
        pts = [(x0 + i * step, bottom - (bottom - top) * min(v, 100) / 100)
               for i, v in enumerate(self.values)]
        poly = [(pts[0][0], bottom)] + pts + [(pts[-1][0], bottom)]
        self.create_polygon(*[c for p in poly for c in p], fill=c["fill"], outline="")
        self.create_line(*[c for p in pts for c in p], fill=c["line"], width=2, smooth=True)


# ---------------------------------------------------------------------------
# Background sampler
# ---------------------------------------------------------------------------

class Sampler(threading.Thread):
    """Collects a snapshot every `interval` seconds off the UI thread."""

    def __init__(self, interval: float):
        super().__init__(daemon=True)
        self.interval = interval
        self.results: queue.Queue = queue.Queue()
        self.wake = threading.Event()
        self.stopped = False

    def run(self) -> None:
        while not self.stopped:
            try:
                self.results.put(sysmon.snapshot())
            except Exception as exc:  # keep sampling if one read fails
                self.results.put(exc)
            self.wake.wait(self.interval)
            self.wake.clear()

    def refresh(self) -> None:
        self.wake.set()

    def stop(self) -> None:
        self.stopped = True
        self.wake.set()


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------

class App:
    def __init__(self, root: tk.Tk, sample: bool = True):
        self.root = root
        self.settings = load_settings()
        self.history: list[float] = []
        self.snapshot: sysmon.Snapshot | None = None
        self.disk_rows: dict[str, dict] = {}

        root.title("System Monitor")
        root.geometry("780x920")
        root.minsize(620, 640)

        self.theme = theme.Theme(root)
        self.mode = self.settings.get("appearance", "system")
        if self.mode not in theme.MODES:
            self.mode = "system"
        self.theme.apply(self.mode)
        base = self.theme.fonts["base"]
        self.big_font = tkfont.Font(family=base.actual("family"),
                                    size=base.actual("size") + 14, weight="bold")
        interval = self.settings.get("interval", 2)
        self.interval = tk.IntVar(value=interval if interval in INTERVALS else 2)
        self.on_top = tk.BooleanVar(value=bool(self.settings.get("on_top", False)))
        root.attributes("-topmost", self.on_top.get())

        self._build_menu()
        self._build_header()
        body = ttk.Frame(root)
        body.pack(fill="both", expand=True, padx=16, pady=(14, 0))
        self._build_memory(body)
        self._build_disks(body)
        self._build_processes(body)
        status = ttk.Frame(root, padding=(18, 6, 18, 10))
        status.pack(fill="x", side="bottom")
        self.status = tk.StringVar(value="Reading…")
        ttk.Label(status, textvariable=self.status, style="Status.TLabel").pack(side="left")
        ttk.Button(status, text="Activity Monitor",
                   command=lambda: self._open(["-a", "Activity Monitor"])).pack(side="right")
        self._recolor()

        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.sampler = Sampler(self.interval.get())
        if sample:
            self.sampler.start()
            root.after(100, self._poll)

    # -- layout --------------------------------------------------------------

    def _build_menu(self) -> None:
        mod = "Command" if sys.platform == "darwin" else "Control"
        acc = "⌘" if sys.platform == "darwin" else "Ctrl+"
        menubar = tk.Menu(self.root)
        view = tk.Menu(menubar, tearoff=False)
        view.add_command(label="Refresh Now", accelerator=f"{acc}R", command=self.refresh)
        view.add_separator()
        every = tk.Menu(view, tearoff=False)
        for sec in INTERVALS:
            every.add_radiobutton(label=f"{sec} second{'s' if sec > 1 else ''}", value=sec,
                                  variable=self.interval, command=self._set_interval)
        view.add_cascade(label="Update Every", menu=every)
        view.add_checkbutton(label="Keep Window on Top", variable=self.on_top,
                             command=self._set_on_top)
        view.add_separator()
        self.appearance = tk.StringVar(value=self.mode)
        look = tk.Menu(view, tearoff=False)
        for mode, label in (("system", "Match System"), ("light", "Light"), ("dark", "Dark")):
            look.add_radiobutton(label=label, value=mode, variable=self.appearance,
                                 command=lambda m=mode: self.set_theme(m))
        view.add_cascade(label="Appearance", menu=look)
        menubar.add_cascade(label="View", menu=view)
        self.root.config(menu=menubar)
        self.root.bind_all(f"<{mod}-r>", lambda e: self.refresh())

    def _build_header(self) -> None:
        header = ttk.Frame(self.root, style="Header.TFrame", padding=(18, 12))
        header.pack(fill="x")
        titles = ttk.Frame(header, style="Header.TFrame")
        titles.pack(side="left")
        ttk.Label(titles, text="System Monitor", style="Title.TLabel").pack(anchor="w")
        self.subtitle = tk.StringVar(value=self._machine())
        ttk.Label(titles, textvariable=self.subtitle, style="Subtitle.TLabel").pack(anchor="w")
        self.theme_btn = ttk.Button(header, style="Header.TButton", command=self.toggle_theme)
        self.theme_btn.pack(side="right")

    def _card(self, parent, title: str, expand: bool = False) -> ttk.Frame:
        card = ttk.Frame(parent, style="Card.TFrame", padding=(16, 12))
        card.pack(fill="both" if expand else "x", expand=expand, pady=(0, 12))
        head = ttk.Frame(card, style="Inner.TFrame")
        head.pack(fill="x")
        ttk.Label(head, text=title.upper(), style="CardMuted.TLabel").pack(side="left")
        card.head = head  # type: ignore[attr-defined]
        return card

    def _build_memory(self, parent) -> None:
        card = self._card(parent, "Memory")
        self.pressure = ttk.Label(card.head, style="Pill.TLabel")
        self.pressure.pack(side="right")
        top = ttk.Frame(card, style="Inner.TFrame")
        top.pack(fill="x", pady=(6, 8))
        self.mem_pct = ttk.Label(top, style="Card.TLabel", font=self.big_font)
        self.mem_pct.pack(side="left")
        self.mem_text = tk.StringVar()
        ttk.Label(top, textvariable=self.mem_text, style="CardMuted.TLabel",
                  justify="left").pack(side="left", padx=(12, 0), anchor="s", pady=(0, 6))
        self.mem_bar = UsageBar(card, height=16)
        self.mem_bar.pack(fill="x")

        legend = ttk.Frame(card, style="Inner.TFrame")
        legend.pack(fill="x", pady=(10, 4))
        self.legend: dict[str, tuple[tk.Canvas, tk.StringVar]] = {}
        for i, (key, label, _) in enumerate(SEGMENTS + [("free", "Free", None),
                                                        ("swap", "Swap used", None)]):
            cell = ttk.Frame(legend, style="Inner.TFrame")
            cell.grid(row=i // 3, column=i % 3, sticky="w", padx=(0, 18), pady=2)
            dot = tk.Canvas(cell, width=10, height=10, highlightthickness=0, borderwidth=0)
            dot.pack(side="left", padx=(0, 6))
            var = tk.StringVar(value=label)
            ttk.Label(cell, textvariable=var, style="Card.TLabel").pack(side="left")
            self.legend[key] = (dot, var)
        for col in range(3):
            legend.columnconfigure(col, weight=1)
        self.graph = Graph(card)
        self.graph.pack(fill="x", pady=(8, 0))

    def _build_disks(self, parent) -> None:
        card = self._card(parent, "Disks")
        self.disk_count = ttk.Label(card.head, style="CardMuted.TLabel")
        self.disk_count.pack(side="right")
        self.disk_frame = ttk.Frame(card, style="Inner.TFrame")
        self.disk_frame.pack(fill="x", pady=(4, 0))
        self.disk_menu = tk.Menu(self.root, tearoff=False)

    def _build_processes(self, parent) -> None:
        card = self._card(parent, "Top memory users", expand=True)
        frame = ttk.Frame(card, style="Inner.TFrame")
        frame.pack(fill="both", expand=True, pady=(6, 0))
        self.tree = ttk.Treeview(frame, columns=("name", "pid", "mem"), show="headings",
                                 height=6, selectmode="browse")
        for col, text, width, anchor in (("name", "Process", 320, "w"),
                                         ("pid", "PID", 80, "e"),
                                         ("mem", "Real memory", 120, "e")):
            self.tree.heading(col, text=text, anchor=anchor)
            self.tree.column(col, width=width, anchor=anchor, stretch=(col == "name"))
        self.tree.pack(fill="both", expand=True)

    # -- theme ---------------------------------------------------------------

    def _c(self, pair: tuple[str, str]) -> str:
        return pair[1] if self.theme.palette["name"] == "dark" else pair[0]

    def set_theme(self, mode: str) -> None:
        self.mode = mode
        self.appearance.set(mode)
        self.settings["appearance"] = mode
        save_settings(self.settings)
        self.theme.apply(mode)
        self._recolor()

    def toggle_theme(self) -> None:
        self.set_theme("light" if self.theme.palette["name"] == "dark" else "dark")

    def _recolor(self) -> None:
        p = self.theme.palette
        self.theme_btn.configure(text="☀  Light" if p["name"] == "dark" else "☾  Dark")
        self.tree.tag_configure("odd", background=p["stripe"])
        for key, (dot, _) in self.legend.items():
            dot.configure(background=p["surface"])
        self._render()

    # -- updates -------------------------------------------------------------

    def _poll(self) -> None:
        latest = None
        try:
            while True:
                latest = self.sampler.results.get_nowait()
        except queue.Empty:
            pass
        if isinstance(latest, Exception):
            self.status.set(f"Couldn't read system stats: {latest}")
        elif latest is not None:
            self.snapshot = latest
            self.history = (self.history + [latest.memory.percent])[-HISTORY:]
            self.status.set(f"Updated {time.strftime('%H:%M:%S')} · every "
                            f"{self.interval.get()} s")
            self._render()
        self.root.after(200, self._poll)

    def show(self, snap: sysmon.Snapshot) -> None:
        """Displays a snapshot directly (used by the self-test)."""
        self.snapshot = snap
        self.history = (self.history + [snap.memory.percent])[-HISTORY:]
        self._render()

    def _render(self) -> None:
        snap = self.snapshot
        if snap is None:
            return
        self._render_memory(snap.memory)
        self._render_disks(snap.volumes)
        self._render_processes(snap.processes)

    def _render_memory(self, m: sysmon.Memory) -> None:
        p = self.theme.palette
        fb = lambda n: format_bytes(n, binary=True)  # noqa: E731
        self.mem_pct.configure(text=f"{m.percent:.0f}%")
        self.mem_text.set(f"{fb(m.used)} used of {fb(m.total)}\n{fb(m.free)} free")
        total = m.total or 1
        self.mem_bar.set([(getattr(m, key) / total, self._c(colors))
                          for key, _, colors in SEGMENTS], p["stripe"], p["surface"])
        values = {key: getattr(m, key) for key, _, _ in SEGMENTS}
        values["free"] = m.free
        colors = {key: self._c(c) for key, _, c in SEGMENTS}
        colors["free"] = p["stripe"]
        colors["swap"] = p["muted"]
        for key, label, _ in SEGMENTS + [("free", "Free", None)]:
            dot, var = self.legend[key]
            var.set(f"{label}  {fb(values[key])}")
        dot, var = self.legend["swap"]
        var.set(f"Swap used  {fb(m.swap_used)}" +
                (f" of {fb(m.swap_total)}" if m.swap_total else ""))
        for key, (dot, _) in self.legend.items():
            dot.delete("all")
            dot.create_oval(1, 1, 9, 9, fill=colors[key],
                            outline=p["border"] if key == "free" else colors[key])
        lvl = PRESSURE_LEVEL.get(m.pressure, "ok")
        self.pressure.configure(text=f"●  Pressure: {m.pressure.capitalize()}",
                                foreground=self._c(LEVELS[lvl]))
        self.graph.set(self.history, {
            "line": self._c(SEGMENTS[0][2]), "fill": p["select"] if p["name"] == "light"
            else p["pill"], "grid": p["border"], "text": p["muted"], "bg": p["surface"],
        }, self.theme.fonts["small"])

    def _render_disks(self, vols: list[sysmon.Volume]) -> None:
        p = self.theme.palette
        mounts = [v.mount for v in vols]
        if mounts != list(self.disk_rows):
            for row in self.disk_rows.values():
                row["frame"].destroy()
            self.disk_rows = {}
            for v in vols:
                self.disk_rows[v.mount] = self._disk_row(v)
        self.disk_count.configure(
            text=f"{len(vols)} volume{'s' if len(vols) != 1 else ''}" if vols else "")
        if not vols:
            if not hasattr(self, "no_disks"):
                self.no_disks = ttk.Label(self.disk_frame, text="No volumes found",
                                          style="CardMuted.TLabel")
                self.no_disks.pack(anchor="w")
            return
        for v in vols:
            row = self.disk_rows[v.mount]
            kind = v.kind + (" · read-only" if v.read_only and v.mount != "/" else "")
            row["name"].set(v.name)
            row["kind"].set(kind)
            row["pct"].set(f"{v.percent:.0f}%")
            row["detail"].set(f"{format_bytes(v.used)} used of {format_bytes(v.total)}  ·  "
                              f"{format_bytes(v.free)} free")
            row["pct_label"].configure(foreground=self._c(LEVELS[level_for(v.percent)]))
            row["bar"].set([(v.percent / 100, self._c(LEVELS[level_for(v.percent)]))],
                           p["stripe"], p["surface"])

    def _disk_row(self, v: sysmon.Volume) -> dict:
        frame = ttk.Frame(self.disk_frame, style="Inner.TFrame")
        frame.pack(fill="x", pady=(6, 4))
        row = {"frame": frame, "name": tk.StringVar(), "kind": tk.StringVar(),
               "pct": tk.StringVar(), "detail": tk.StringVar()}
        line = ttk.Frame(frame, style="Inner.TFrame")
        line.pack(fill="x")
        ttk.Label(line, textvariable=row["name"], style="Card.TLabel",
                  font=self.theme.fonts["bold"]).pack(side="left")
        ttk.Label(line, textvariable=row["kind"], style="CardMuted.TLabel").pack(
            side="left", padx=(8, 0))
        row["pct_label"] = ttk.Label(line, textvariable=row["pct"], style="Card.TLabel",
                                     font=self.theme.fonts["bold"])
        row["pct_label"].pack(side="right")
        row["bar"] = UsageBar(frame, height=10)
        row["bar"].pack(fill="x", pady=(4, 2))
        ttk.Label(frame, textvariable=row["detail"], style="CardMuted.TLabel").pack(anchor="w")
        widgets = [frame, line, row["bar"], *line.winfo_children(), *frame.winfo_children()]
        for w in widgets:
            w.bind("<Double-Button-1>", lambda e, m=v.mount: self._open([m]))
            for seq in ("<Button-2>", "<Button-3>", "<Control-Button-1>"):
                w.bind(seq, lambda e, vol=v: self._disk_popup(e, vol))
        return row

    def _disk_popup(self, event, v: sysmon.Volume) -> None:
        m = self.disk_menu
        m.delete(0, "end")
        m.add_command(label=f"Open “{v.name}” in Finder", command=lambda: self._open([v.mount]))
        m.add_command(label="Copy Path", command=lambda: self._copy(v.mount))
        if v.mount != "/" and sys.platform == "darwin":
            m.add_separator()
            m.add_command(label=f"Eject “{v.name}”", command=lambda: self._eject(v))
        m.tk_popup(event.x_root, event.y_root)

    def _render_processes(self, procs: list[sysmon.Process]) -> None:
        self.tree.delete(*self.tree.get_children())
        for i, proc in enumerate(procs):
            self.tree.insert("", "end", values=(proc.name, proc.pid,
                                                format_bytes(proc.rss, binary=True)),
                             tags=("odd",) if i % 2 else ())

    # -- actions -------------------------------------------------------------

    def refresh(self) -> None:
        self.status.set("Refreshing…")
        self.sampler.refresh()

    def _set_interval(self) -> None:
        self.sampler.interval = self.interval.get()
        self.settings["interval"] = self.interval.get()
        save_settings(self.settings)
        self.sampler.refresh()

    def _set_on_top(self) -> None:
        self.root.attributes("-topmost", self.on_top.get())
        self.settings["on_top"] = self.on_top.get()
        save_settings(self.settings)

    def _open(self, args: list[str]) -> None:
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        try:
            subprocess.Popen([opener, *args], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        except OSError as exc:
            self.status.set(f"Couldn't open: {exc}")

    def _copy(self, text: str) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status.set(f"Copied {text}")

    def _eject(self, v: sysmon.Volume) -> None:
        def work():
            out = subprocess.run(["/usr/sbin/diskutil", "eject", v.mount],
                                 capture_output=True, text=True, check=False)
            msg = (out.stdout or out.stderr).strip()
            self.root.after(0, lambda: self._ejected(v, out.returncode == 0, msg))
        self.status.set(f"Ejecting {v.name}…")
        threading.Thread(target=work, daemon=True).start()

    def _ejected(self, v: sysmon.Volume, ok: bool, msg: str) -> None:
        if ok:
            self.status.set(f"Ejected {v.name}")
            self.refresh()
        else:
            self.status.set(f"Couldn't eject {v.name}")
            messagebox.showwarning("System Monitor", f"Couldn't eject “{v.name}”.\n\n{msg}")

    @staticmethod
    def _machine() -> str:
        if sys.platform == "darwin":
            ver = subprocess.run(["sw_vers", "-productVersion"], capture_output=True,
                                 text=True, check=False).stdout.strip()
            model = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.model"],
                                   capture_output=True, text=True, check=False).stdout.strip()
            host = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True,
                                  text=True, check=False).stdout.strip()
            parts = [host, f"macOS {ver}" if ver else "", model]
            return "  ·  ".join(p for p in parts if p)
        return os.uname().nodename if hasattr(os, "uname") else "Memory and disk usage"

    def quit(self) -> None:
        self.sampler.stop()
        self.root.destroy()


def self_test(report_path: str) -> int:
    """Checks the packaged app without showing a window. Used by the build."""
    import traceback
    lines, ok = [f"System Monitor {sysmon.__version__} self-test"], False
    try:
        snap = sysmon.snapshot()
        m = snap.memory
        lines.append(f"memory: {m.percent:.0f}% of {format_bytes(m.total, True)}, "
                     f"pressure {m.pressure}")
        lines.append(f"volumes: {[(v.name, v.kind, round(v.percent)) for v in snap.volumes]}")
        lines.append(f"processes: {len(snap.processes)}")
        root = tk.Tk()
        root.withdraw()
        app = App(root, sample=False)
        app.show(snap)
        for mode in ("light", "dark"):  # both themes must build and draw
            app.theme.apply(mode)
            app._recolor()
            root.update()
        root.destroy()
        lines.append("window + light/dark themes: ok")
        ok = m.total > 0 and m.used > 0 and bool(snap.volumes) and bool(snap.processes)
    except Exception:
        lines.append(traceback.format_exc())
    lines.append(f"result: {'PASS' if ok else 'FAIL'}")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return 0 if ok else 1


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--self-test":
        sys.exit(self_test(sys.argv[2]))
    root = tk.Tk()
    icon = os.path.join(HERE, "icon.png")
    if os.path.exists(icon):
        try:
            root.iconphoto(True, tk.PhotoImage(file=icon))
        except tk.TclError:
            pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
