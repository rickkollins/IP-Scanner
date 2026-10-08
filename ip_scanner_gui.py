#!/usr/bin/env python3
"""IP Scanner - desktop window (Tkinter) around scanner.py.

The layout follows Advanced IP Scanner: a toolbar with the Scan button and
the IP range, then one list of hosts (Status, Name, IP, Manufacturer, MAC
address, Comments). Each host expands to show its open services.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import webbrowser
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scanner  # noqa: E402

SETTINGS = os.path.expanduser("~/.ip_scanner.json")

COLUMNS = {  # id: (heading, width, stretch)
    "name": ("Name", 230, True),
    "ip": ("IP", 120, False),
    "vendor": ("Manufacturer", 200, True),
    "mac": ("MAC address", 140, False),
    "comments": ("Comments", 260, True),
}

# How to open a service when its row is double-clicked.
HTTPS_PORTS = {443, 5001, 8443}
URL_SCHEMES = {21: "ftp", 22: "ssh", 445: "smb", 548: "afp", 5900: "vnc"}


def service_url(ip: str, port: int) -> str | None:
    if port in URL_SCHEMES:
        return f"{URL_SCHEMES[port]}://{ip}"
    if port in HTTPS_PORTS:
        return f"https://{ip}" + ("" if port == 443 else f":{port}") + "/"
    name = scanner.service_name(port)
    if port in (80, 81, 3000, 4007, 4008, 5000, 8000, 8008, 8080, 8081, 8123,
                8888, 9000, 32400) or name.startswith("HTTP"):
        return f"http://{ip}" + ("" if port == 80 else f":{port}") + "/"
    return None


def dot(color: str, size: int = 12) -> tk.PhotoImage:
    """A filled circle, used as the status icon."""
    img = tk.PhotoImage(width=size, height=size)
    c = (size - 1) / 2
    for y in range(size):
        row = []
        for x in range(size):
            inside = (x - c) ** 2 + (y - c) ** 2 <= (c - 0.5) ** 2
            row.append(color if inside else "")
        for x, px in enumerate(row):
            if px:
                img.put(px, (x, y))
    return img


def is_dark(root: tk.Tk) -> bool:
    try:
        return bool(int(root.tk.call("tk::unsupported::MacWindowStyle", "isdark", root)))
    except (tk.TclError, ValueError):
        return False


def load_settings() -> dict:
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    try:
        with open(SETTINGS, "w") as f:
            json.dump(data, f, indent=2)
    except OSError:
        pass


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.events: queue.Queue = queue.Queue()
        self.scanner: scanner.Scanner | None = None
        self.results: dict[str, scanner.HostResult] = {}
        self.sort_col, self.sort_desc = "ip", False
        self.total = 0
        self.started = 0.0
        self.dirty = False
        self.note = ""
        settings = load_settings()

        root.title("IP Scanner")
        root.geometry("1080x640")
        root.minsize(760, 400)

        self.icon_alive = dot("#2e9d44")
        self.icon_service = dot("#2f74d0", 10)

        self._build_menu()

        # Toolbar: [Scan]  range  [Detect]          search
        bar = ttk.Frame(root, padding=(10, 10, 10, 4))
        bar.pack(fill="x")
        self.scan_btn = ttk.Button(bar, text="▶  Scan", width=10, command=self.toggle_scan)
        self.scan_btn.pack(side="left")
        self.range_var = tk.StringVar(value=self.detected_range())
        rng = ttk.Entry(bar, textvariable=self.range_var, width=42)
        rng.pack(side="left", padx=(10, 4))
        rng.bind("<Return>", lambda e: self.toggle_scan())
        ttk.Button(bar, text="My network", command=self.detect).pack(side="left")
        self.search_var = tk.StringVar()
        self.search_var.trace_add("write", lambda *a: self.refresh_view())
        ttk.Entry(bar, textvariable=self.search_var, width=24).pack(side="right")
        ttk.Label(bar, text="Search:").pack(side="right", padx=(0, 4))

        hint = ttk.Frame(root, padding=(10, 0, 10, 4))
        hint.pack(fill="x")
        ttk.Label(hint, text="Example: 192.168.1.1-254, 10.0.0.0/24, 192.168.2.10",
                  foreground="gray").pack(side="left", padx=(98, 0))

        opts = ttk.Frame(root, padding=(10, 0, 10, 8))
        opts.pack(fill="x")
        ttk.Label(opts, text="Ports:").pack(side="left")
        self.ports_var = tk.StringVar(
            value=settings.get("ports") or ", ".join(map(str, scanner.DEFAULT_PORTS)))
        ttk.Entry(opts, textvariable=self.ports_var).pack(
            side="left", fill="x", expand=True, padx=(6, 4))
        ttk.Button(opts, text="Defaults", command=lambda: self.ports_var.set(
            ", ".join(map(str, scanner.DEFAULT_PORTS)))).pack(side="left")
        self.flush_var = tk.BooleanVar(value=settings.get("flush", True))
        ttk.Checkbutton(opts, text="Clear ARP & DNS cache before scan",
                        variable=self.flush_var).pack(side="left", padx=(12, 0))

        # Results list.
        frame = ttk.Frame(root, padding=(10, 0, 10, 0))
        frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(frame, columns=list(COLUMNS), selectmode="extended")
        vsb = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.heading("#0", text="Status")
        self.tree.column("#0", width=80, stretch=False)
        for col, (title, width, stretch) in COLUMNS.items():
            self.tree.heading(col, command=lambda c=col: self.sort_by(c))
            self.tree.column(col, width=width, stretch=stretch, anchor="w")
        self._update_headings()
        dark = is_dark(root)
        self.tree.tag_configure("odd", background="#2a2a2c" if dark else "#f4f5f7")
        self.tree.tag_configure("even", background="#1e1e1e" if dark else "#ffffff")
        self.tree.tag_configure("service", foreground="#6aa8ff" if dark else "#1f5fbf")
        self.tree.bind("<Double-1>", self.on_double_click)
        self.tree.bind("<Return>", self.on_double_click)
        right_clicks = ("<Button-2>", "<Control-Button-1>") if scanner.IS_MAC else ("<Button-3>",)
        for seq in right_clicks:
            self.tree.bind(seq, self.on_right_click)
        self.menu = tk.Menu(root, tearoff=False)

        # Status bar.
        status = ttk.Frame(root, padding=(10, 6, 10, 10))
        status.pack(fill="x")
        self.progress = ttk.Progressbar(status, mode="determinate", length=200)
        self.progress.pack(side="left")
        self.status = tk.StringVar(value="Ready. Press Scan to search the network.")
        ttk.Label(status, textvariable=self.status).pack(side="left", padx=10)
        self.counts = tk.StringVar()
        ttk.Label(status, textvariable=self.counts).pack(side="right")

        root.protocol("WM_DELETE_WINDOW", self.quit)
        root.after(100, self.poll)

    # ---------------------------------------------------------------- menus

    def _build_menu(self) -> None:
        mod = "Command" if scanner.IS_MAC else "Control"
        acc = "Cmd" if scanner.IS_MAC else "Ctrl"
        bar = tk.Menu(self.root)
        file = tk.Menu(bar, tearoff=False)
        file.add_command(label="Scan", accelerator=f"{acc}+R", command=self.toggle_scan)
        file.add_command(label="Export CSV…", accelerator=f"{acc}+E", command=self.export)
        if not scanner.IS_MAC:
            file.add_separator()
            file.add_command(label="Quit", command=self.quit)
        bar.add_cascade(label="File", menu=file)
        view = tk.Menu(bar, tearoff=False)
        view.add_command(label="Expand All", command=lambda: self.expand_all(True))
        view.add_command(label="Collapse All", command=lambda: self.expand_all(False))
        bar.add_cascade(label="View", menu=view)
        self.root.configure(menu=bar)
        self.root.bind_all(f"<{mod}-r>", lambda e: self.toggle_scan())
        self.root.bind_all(f"<{mod}-e>", lambda e: self.export())

    def on_right_click(self, event) -> None:
        iid = self.tree.identify_row(event.y)
        if not iid:
            return
        if iid not in self.tree.selection():
            self.tree.selection_set(iid)
        ip, port = self._row(iid)
        r = self.results[ip]
        m = self.menu
        m.delete(0, "end")
        ports = [port] if port else r.open_ports()
        for p in ports:
            url = service_url(ip, p)
            if url:
                m.add_command(label=f"Open {scanner.service_name(p)} ({p})",
                              command=lambda u=url: self.open_url(u))
        if m.index("end") is not None:
            m.add_separator()
        m.add_command(label="Copy IP", command=lambda: self.copy(ip))
        if r.hostname:
            m.add_command(label="Copy Name", command=lambda: self.copy(r.hostname))
        if r.mac:
            m.add_command(label="Copy MAC Address", command=lambda: self.copy(r.mac))
        m.add_command(label="Copy Row", command=lambda: self.copy(
            "\t".join([r.hostname, r.ip, r.vendor, r.mac, self.comments(r)])))
        m.add_separator()
        m.add_command(label="Rescan This Host", command=lambda: self.rescan(ip))
        m.tk_popup(event.x_root, event.y_root)

    def copy(self, text: str) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status.set(f"Copied {text}")

    # ---------------------------------------------------------------- list

    @staticmethod
    def _row(iid: str) -> tuple[str, int | None]:
        """Host rows are 'ip', service rows are 'ip:port'."""
        if ":" in iid:
            ip, port = iid.split(":")
            return ip, int(port)
        return iid, None

    @staticmethod
    def comments(r: scanner.HostResult) -> str:
        names = (scanner.service_name(p) for p in r.open_ports())
        return ", ".join(n if n.startswith("Port ") else f"{n} ({p})"
                         for n, p in zip(names, r.open_ports()))

    def upsert(self, r: scanner.HostResult) -> None:
        old = self.results.get(r.ip)
        # Keep the best-known values; a later update may lack a field.
        if old:
            r.hostname = r.hostname or old.hostname
            r.mac = r.mac or old.mac
            r.vendor = r.vendor or old.vendor
            r.ports = {**old.ports, **r.ports}
        self.results[r.ip] = r
        values = [r.hostname, r.ip, r.vendor, r.mac, self.comments(r)]
        if self.tree.exists(r.ip):
            self.tree.item(r.ip, values=values)
        else:
            self.tree.insert("", "end", iid=r.ip, image=self.icon_alive, values=values)
            self.dirty = True
        open_ports = set(r.open_ports())
        for child in self.tree.get_children(r.ip):
            if self._row(child)[1] not in open_ports:
                self.tree.delete(child)
        for i, p in enumerate(sorted(open_ports)):
            iid = f"{r.ip}:{p}"
            url = service_url(r.ip, p) or ""
            vals = [f"{scanner.service_name(p)}", f"port {p}", "", "", url]
            if self.tree.exists(iid):
                self.tree.item(iid, values=vals)
            else:
                self.tree.insert(r.ip, i, iid=iid, image=self.icon_service,
                                 values=vals, tags=("service",))
        if self.search_var.get():
            self.dirty = True

    def matches(self, r: scanner.HostResult, q: str) -> bool:
        if not q:
            return True
        hay = " ".join([r.ip, r.hostname, r.vendor, r.mac, self.comments(r)]).lower()
        return all(word in hay for word in q.lower().split())

    def sort_value(self, r: scanner.HostResult):
        """Value for the current sort column; None sorts last either way."""
        c = self.sort_col
        if c == "ip":
            return r.sort_key
        if c == "comments":
            return len(r.open_ports()) or None
        return getattr(r, "hostname" if c == "name" else c).lower() or None

    def refresh_view(self) -> None:
        self.dirty = False
        q = self.search_var.get().strip()
        by_ip = sorted(self.results.values(), key=lambda h: h.sort_key)
        filled = [h for h in by_ip if self.sort_value(h) is not None]
        empty = [h for h in by_ip if self.sort_value(h) is None]
        filled.sort(key=self.sort_value, reverse=self.sort_desc)
        hosts = filled + empty
        visible = [h for h in hosts if self.matches(h, q)]
        shown = {h.ip for h in visible}
        for ip in self.results:
            if ip not in shown and self.tree.exists(ip):
                self.tree.detach(ip)
        for i, h in enumerate(visible):
            self.tree.move(h.ip, "", i)
            self.tree.item(h.ip, tags=("odd" if i % 2 else "even",))
        self.update_counts()

    def sort_by(self, col: str) -> None:
        if self.sort_col == col:
            self.sort_desc = not self.sort_desc
        else:
            self.sort_col, self.sort_desc = col, False
        self._update_headings()
        self.refresh_view()

    def _update_headings(self) -> None:
        for col, (title, _, _) in COLUMNS.items():
            arrow = (" ▼" if self.sort_desc else " ▲") if col == self.sort_col else ""
            self.tree.heading(col, text=title + arrow)

    def expand_all(self, open_: bool) -> None:
        for iid in self.tree.get_children():
            self.tree.item(iid, open=open_)

    def on_double_click(self, event) -> str | None:
        iid = self.tree.focus() if event.type == tk.EventType.KeyPress \
            else self.tree.identify_row(event.y)
        if not iid:
            return None
        ip, port = self._row(iid)
        if port is None:
            return None  # default: expand / collapse
        url = service_url(ip, port)
        if url:
            self.open_url(url)
        return "break"

    def open_url(self, url: str) -> None:
        if scanner.IS_MAC:
            subprocess.Popen(["open", url])
        else:
            webbrowser.open(url)

    def update_counts(self) -> None:
        alive = len(self.results)
        shown = len(self.tree.get_children())
        parts = [f"{alive} alive"]
        if self.total and not self.scanner:
            parts.append(f"{self.total - alive} dead")
        if shown != alive:
            parts.append(f"{shown} shown")
        self.counts.set(", ".join(parts))

    # ---------------------------------------------------------------- scan

    def detected_range(self) -> str:
        return ", ".join(scanner.network_to_range(n) for n in scanner.detect_local_networks())

    def detect(self) -> None:
        rng = self.detected_range()
        if rng:
            self.range_var.set(rng)
        else:
            messagebox.showwarning("IP Scanner", "No network connection was found.")

    def _parse_inputs(self):
        try:
            targets = scanner.parse_targets(self.range_var.get())
            ports = scanner.parse_ports(self.ports_var.get())
        except ValueError as e:
            messagebox.showerror("IP Scanner", f"Invalid input: {e}")
            return None
        if not targets:
            messagebox.showerror("IP Scanner", "Enter an IP range, e.g. 192.168.1.1-254.")
            return None
        if not ports:
            messagebox.showerror("IP Scanner", "Enter at least one port.")
            return None
        return targets, ports

    def toggle_scan(self) -> None:
        if self.scanner:
            self.scanner.stop()
            self.status.set("Stopping…")
            self.scan_btn.configure(state="disabled")
            return
        parsed = self._parse_inputs()
        if not parsed:
            return
        targets, ports = parsed
        save_settings({"ports": self.ports_var.get(), "flush": self.flush_var.get()})

        self.results.clear()
        self.tree.delete(*self.tree.get_children())
        self.total = len(targets)
        self._start(targets, ports, flush=self.flush_var.get())

    def rescan(self, ip: str) -> None:
        if self.scanner:
            return
        parsed = self._parse_inputs()
        if not parsed:
            return
        self.results.pop(ip, None)
        if self.tree.exists(ip):
            self.tree.delete(ip)
        self._start([ip], parsed[1], flush=False, keep_total=True)

    def _start(self, targets, ports, flush: bool, keep_total: bool = False) -> None:
        if not keep_total:
            self.total = len(targets)
        self.started = time.monotonic()
        self.progress.configure(value=0, maximum=100)
        self.scan_btn.configure(text="■  Stop")
        self.status.set("Clearing ARP & DNS cache…" if flush else "Discovering hosts…")
        self.scanner = scanner.Scanner(
            targets, ports,
            on_host=lambda r: self.events.put(("host", r)),
            on_progress=lambda *a: self.events.put(("progress", a)),
        )
        threading.Thread(target=self._worker, args=(self.scanner, flush),
                         daemon=True).start()

    def _worker(self, sc: scanner.Scanner, flush: bool) -> None:
        try:
            if flush:
                ok, msg = scanner.flush_caches(gui=True)
                self.events.put(("note", msg))
            sc.run()
            self.events.put(("done", None))
        except Exception as e:  # surface unexpected errors in the window
            self.events.put(("error", e))

    # Each stage gets a slice of the progress bar.
    STAGES = {"discover": (0, 60, "Discovering hosts"),
              "ports": (60, 90, "Checking ports"),
              "names": (90, 100, "Resolving names")}

    def poll(self) -> None:
        try:
            for _ in range(2000):
                kind, data = self.events.get_nowait()
                if kind == "host":
                    self.upsert(data)
                elif kind == "note":
                    self.note = data
                elif kind == "progress":
                    stage, done, total = data
                    lo, hi, label = self.STAGES[stage]
                    self.progress.configure(value=lo + (hi - lo) * done / max(total, 1))
                    self.status.set(f"{label}… {done}/{total}")
                elif kind in ("done", "error"):
                    self._finished(kind, data)
        except queue.Empty:
            pass
        if self.dirty:
            self.refresh_view()
        self.root.after(100, self.poll)

    def _finished(self, kind: str, data) -> None:
        stopped = self.scanner.stopped if self.scanner else False
        self.scanner = None
        self.scan_btn.configure(text="▶  Scan", state="normal")
        self.progress.configure(value=0)
        self.refresh_view()
        if kind == "error":
            self.status.set(f"Error: {data}")
            return
        secs = time.monotonic() - self.started
        note, self.note = self.note, ""
        self.status.set(
            f"{'Scan stopped' if stopped else 'Scan completed'} in {secs:.0f} s."
            + (f"  {note}" if note else ""))

    def export(self) -> None:
        if not self.results:
            messagebox.showinfo("IP Scanner", "Nothing to export yet. Run a scan first.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".csv", initialfile="ip-scan.csv",
            filetypes=[("CSV", "*.csv")])
        if path:
            ordered = sorted(self.results.values(), key=lambda r: r.sort_key)
            scanner.write_csv(path, ordered)
            self.status.set(f"Saved {path}")

    def quit(self) -> None:
        if self.scanner:
            self.scanner.stop()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    try:
        ttk.Style().theme_use("aqua")
    except tk.TclError:
        ttk.Style().theme_use("clam")
    App(root)
    root.lift()
    root.attributes("-topmost", True)
    root.after(300, lambda: root.attributes("-topmost", False))
    root.mainloop()


if __name__ == "__main__":
    main()
