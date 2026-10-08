#!/usr/bin/env python3
"""IP Scanner - desktop window (Tkinter) around scanner.py."""

from __future__ import annotations

import os
import queue
import sys
import threading
import webbrowser
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scanner  # noqa: E402

OPEN, CLOSED = "● open", "–"


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.events: queue.Queue = queue.Queue()
        self.scanner: scanner.Scanner | None = None
        self.results: dict[str, scanner.HostResult] = {}
        self.ports = list(scanner.DEFAULT_PORTS)

        root.title("IP Scanner")
        root.geometry("980x600")
        root.minsize(720, 380)

        top = ttk.Frame(root, padding=(12, 12, 12, 6))
        top.pack(fill="x")
        ttk.Label(top, text="Network(s):").pack(side="left")
        self.net_var = tk.StringVar(
            value=", ".join(map(str, scanner.detect_local_networks()))
        )
        ttk.Entry(top, textvariable=self.net_var, width=34).pack(side="left", padx=6)
        ttk.Label(top, text="Ports:").pack(side="left", padx=(8, 0))
        self.ports_var = tk.StringVar(value=", ".join(map(str, self.ports)))
        ttk.Entry(top, textvariable=self.ports_var, width=22).pack(side="left", padx=6)
        self.scan_btn = ttk.Button(top, text="Scan", command=self.toggle_scan)
        self.scan_btn.pack(side="left", padx=(8, 0))
        self.export_btn = ttk.Button(top, text="Export CSV…", command=self.export,
                                     state="disabled")
        self.export_btn.pack(side="right")

        mid = ttk.Frame(root, padding=(12, 0))
        mid.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(mid, show="headings", selectmode="browse")
        vsb = ttk.Scrollbar(mid, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.tag_configure("web", foreground="#1a7f37")
        self.tree.bind("<Double-1>", self.open_in_browser)
        self._build_columns()

        bottom = ttk.Frame(root, padding=(12, 6, 12, 12))
        bottom.pack(fill="x")
        self.progress = ttk.Progressbar(bottom, mode="determinate", length=220)
        self.progress.pack(side="left")
        self.status = tk.StringVar(value="Ready. Double-click an open port to open it in a browser.")
        ttk.Label(bottom, textvariable=self.status).pack(side="left", padx=10)

        root.after(100, self.poll)

    # ---------------------------------------------------------------- table

    def _build_columns(self) -> None:
        cols = ["ip", "hostname", "mac"] + [f"p{p}" for p in self.ports]
        self.tree.configure(columns=cols)
        heads = {"ip": ("IP Address", 130), "hostname": ("Hostname", 260),
                 "mac": ("MAC Address", 150)}
        for c in cols:
            title, width = heads.get(c, (f"Port {c[1:]}", 80))
            self.tree.heading(c, text=title, command=lambda c=c: self.sort_by(c))
            self.tree.column(c, width=width, anchor="center" if c[0] == "p" else "w",
                             stretch=c == "hostname")

    def upsert(self, r: scanner.HostResult) -> None:
        self.results[r.ip] = r
        values = [r.ip, r.hostname, r.mac] + [
            OPEN if r.ports.get(p) else CLOSED for p in self.ports
        ]
        tags = ("web",) if r.open_ports() else ()
        if self.tree.exists(r.ip):
            self.tree.item(r.ip, values=values, tags=tags)
            return
        # Keep rows in numeric IP order as they arrive.
        key = r.sort_key
        index = "end"
        for i, iid in enumerate(self.tree.get_children()):
            if self.results[iid].sort_key > key:
                index = i
                break
        self.tree.insert("", index, iid=r.ip, values=values, tags=tags)

    def sort_by(self, col: str) -> None:
        def key(iid):
            r = self.results[iid]
            if col == "ip":
                return (0, r.sort_key)
            if col == "hostname":
                return (not r.hostname, r.hostname.lower(), r.sort_key)
            if col == "mac":
                return (not r.mac, r.mac, r.sort_key)
            return (not r.ports.get(int(col[1:])), r.sort_key)
        for i, iid in enumerate(sorted(self.tree.get_children(), key=key)):
            self.tree.move(iid, "", i)

    def open_in_browser(self, event) -> None:
        iid = self.tree.identify_row(event.y)
        col = self.tree.identify_column(event.x)
        if not iid:
            return
        r = self.results[iid]
        idx = int(col[1:]) - 1 - 3  # first three columns are ip/hostname/mac
        open_ports = r.open_ports()
        if 0 <= idx < len(self.ports) and r.ports.get(self.ports[idx]):
            port = self.ports[idx]
        elif open_ports:
            port = open_ports[0]
        else:
            return
        webbrowser.open(f"http://{r.ip}" + ("" if port == 80 else f":{port}") + "/")

    # ---------------------------------------------------------------- scan

    def toggle_scan(self) -> None:
        if self.scanner:
            self.scanner.stop()
            self.status.set("Stopping…")
            self.scan_btn.configure(state="disabled")
            return
        try:
            nets = scanner.parse_networks(
                s for s in self.net_var.get().replace(";", ",").split(",") if s.strip()
            )
            ports = [int(p) for p in self.ports_var.get().replace(" ", "").split(",") if p]
            if not all(0 < p < 65536 for p in ports):
                raise ValueError("Ports must be between 1 and 65535.")
        except ValueError as e:
            messagebox.showerror("IP Scanner", str(e))
            return
        if not nets:
            messagebox.showerror(
                "IP Scanner",
                "No network detected. Enter one, e.g. 192.168.1.0/24.")
            return
        if not ports:
            messagebox.showerror("IP Scanner", "Enter at least one port.")
            return

        self.ports = sorted(set(ports))
        self.results.clear()
        self.tree.delete(*self.tree.get_children())
        self._build_columns()
        total = sum(n.num_addresses for n in nets)
        self.progress.configure(value=0, maximum=max(total, 1))
        self.status.set(f"Scanning {', '.join(map(str, nets))}…")
        self.scan_btn.configure(text="Stop")
        self.export_btn.configure(state="disabled")

        self.scanner = scanner.Scanner(
            nets, self.ports,
            on_host=lambda r: self.events.put(("host", r)),
            on_progress=lambda d, t: self.events.put(("progress", (d, t))),
        )
        threading.Thread(target=self._worker, args=(self.scanner,), daemon=True).start()

    def _worker(self, sc: scanner.Scanner) -> None:
        try:
            sc.run()
            self.events.put(("done", None))
        except Exception as e:  # surface unexpected errors in the window
            self.events.put(("error", e))

    def poll(self) -> None:
        try:
            while True:
                kind, data = self.events.get_nowait()
                if kind == "host":
                    self.upsert(data)
                elif kind == "progress":
                    done, total = data
                    self.progress.configure(value=done, maximum=total)
                    if done == total:
                        self.status.set("Resolving hostnames…")
                    else:
                        self.status.set(f"Probed {done}/{total} addresses, "
                                        f"{len(self.results)} alive")
                elif kind in ("done", "error"):
                    stopped = self.scanner.stopped if self.scanner else False
                    self.scanner = None
                    self.scan_btn.configure(text="Scan", state="normal")
                    self.export_btn.configure(state="normal" if self.results else "disabled")
                    self.progress.configure(value=self.progress["maximum"])
                    web = sum(1 for r in self.results.values() if r.open_ports())
                    if kind == "error":
                        self.status.set(f"Error: {data}")
                    else:
                        self.status.set(
                            f"{'Stopped' if stopped else 'Done'}: {len(self.results)} alive "
                            f"host(s), {web} with an open port.")
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def export(self) -> None:
        path = filedialog.asksaveasfilename(
            defaultextension=".csv", initialfile="ip-scan.csv",
            filetypes=[("CSV", "*.csv")])
        if path:
            ordered = sorted(self.results.values(), key=lambda r: r.sort_key)
            scanner.write_csv(path, ordered, self.ports)
            self.status.set(f"Saved {path}")


def main() -> None:
    root = tk.Tk()
    try:
        ttk.Style().theme_use("aqua")
    except tk.TclError:
        pass
    App(root)
    root.lift()
    root.attributes("-topmost", True)
    root.after(300, lambda: root.attributes("-topmost", False))
    root.mainloop()


if __name__ == "__main__":
    main()
