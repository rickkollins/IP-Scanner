#!/usr/bin/env python3
"""Background Remover - desktop window (Tkinter) around bgremove.py.

Open an image, click Remove Background, then save the result as a
transparent PNG. Shares the light-blue / dark theme with IP Scanner.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageTk

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.dirname(HERE))  # theme.py lives in the repo root
FROZEN = getattr(sys, "frozen", False)
ASSETS = os.path.join(getattr(sys, "_MEIPASS", HERE), "assets")
for _name in ("stdout", "stderr"):
    # A windowed Windows build has no console: rembg's download progress
    # bar would crash writing to None.
    if getattr(sys, _name) is None:
        setattr(sys, _name, open(os.devnull, "w"))
if FROZEN:
    # pymatting's numba functions cache compiled code next to the package,
    # which is read-only inside an app bundle.
    os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(
        os.path.expanduser("~"), ".cache", "bg-remover", "numba"))
import bgremove  # noqa: E402
import theme  # noqa: E402

SETTINGS = os.path.expanduser("~/.bg_remover.json")
CHECKER = 10  # checkerboard square size in preview pixels


def load_settings() -> dict:
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    try:
        with open(SETTINGS, "w") as f:
            json.dump({**load_settings(), **data}, f, indent=2)
    except OSError:
        pass


def checkerboard(size: tuple[int, int], dark: bool) -> Image.Image:
    a, b = ((58, 66, 78), (44, 52, 63)) if dark else ((255, 255, 255), (222, 228, 236))
    tile = Image.new("RGB", (CHECKER * 2, CHECKER * 2), a)
    tile.paste(b, (0, 0, CHECKER, CHECKER))
    tile.paste(b, (CHECKER, CHECKER, CHECKER * 2, CHECKER * 2))
    board = Image.new("RGB", size)
    for x in range(0, size[0], tile.width):
        for y in range(0, size[1], tile.height):
            board.paste(tile, (x, y))
    return board


class Preview(ttk.Frame):
    """A titled card with a canvas that shows an image scaled to fit."""

    def __init__(self, master, title: str, app: "App"):
        super().__init__(master, style="Card.TFrame")
        self.app = app
        self.image: Image.Image | None = None
        self.photo: ImageTk.PhotoImage | None = None
        self.hint = ""
        ttk.Label(self, text=title, style="Card.TLabel",
                  font=app.theme.fonts["bold"]).pack(anchor="w", padx=14, pady=(12, 8))
        self.canvas = tk.Canvas(self, highlightthickness=0, bd=0, width=360, height=320)
        self.canvas.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        self.canvas.bind("<Configure>", lambda e: self.redraw())

    def show(self, image: Image.Image | None, hint: str = "") -> None:
        self.image, self.hint = image, hint
        self.redraw()

    def redraw(self) -> None:
        p = self.app.palette
        c = self.canvas
        c.configure(background=p["surface"])
        c.delete("all")
        w, h = c.winfo_width(), c.winfo_height()
        if w < 4 or h < 4:
            return
        if self.image is None:
            c.create_text(w // 2, h // 2, text=self.hint, fill=p["muted"],
                          font=self.app.theme.fonts["base"], width=w - 40, justify="center")
            return
        img = self.image
        scale = min(w / img.width, h / img.height, 1.0)
        size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
        shown = img.resize(size, Image.LANCZOS) if scale < 1 else img
        if shown.mode == "RGBA":
            board = checkerboard(size, p["name"] == "dark")
            board.paste(shown, (0, 0), shown)
            shown = board
        self.photo = ImageTk.PhotoImage(shown)
        c.create_image(w // 2, h // 2, image=self.photo, anchor="center")


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.settings = load_settings()
        self.events: queue.Queue = queue.Queue()
        self.src_path: str | None = None
        self.original: Image.Image | None = None
        self.result: Image.Image | None = None
        self.busy = False

        root.title("Background Remover")
        try:
            self.icon = tk.PhotoImage(file=os.path.join(ASSETS, "icon.png"))
            root.iconphoto(True, self.icon)
        except tk.TclError:
            pass
        root.geometry(self.settings.get("geometry", "980x640"))
        root.minsize(640, 480)
        self.theme = theme.Theme(root)
        self.palette = self.theme.apply(self.settings.get("theme", "system"))

        self.model_label = tk.StringVar(value=self._label_for(
            self.settings.get("model", bgremove.DEFAULT_MODEL)))
        self.refine = tk.BooleanVar(value=self.settings.get("refine", False))
        self.crop = tk.BooleanVar(value=self.settings.get("crop", False))
        self.status = tk.StringVar(value="Open an image to get started.")

        self._build()
        self._bind_keys()
        self._update_buttons()
        root.protocol("WM_DELETE_WINDOW", self.quit)
        root.after(100, self._poll)

    # ---------------------------------------------------------------- layout
    def _build(self) -> None:
        header = ttk.Frame(self.root, style="Header.TFrame", padding=(18, 14))
        header.pack(fill="x")
        titles = ttk.Frame(header, style="Header.TFrame")
        titles.pack(side="left")
        ttk.Label(titles, text="Background Remover", style="Title.TLabel").pack(anchor="w")
        ttk.Label(titles, text="AI cut-outs that run on your computer - nothing is uploaded",
                  style="Subtitle.TLabel").pack(anchor="w")
        self.theme_btn = ttk.Button(header, style="Header.TButton", command=self.cycle_theme,
                                    text=self._theme_text())
        self.theme_btn.pack(side="right")

        bar = ttk.Frame(self.root, padding=(18, 12, 18, 0))
        bar.pack(fill="x")
        self.open_btn = ttk.Button(bar, text="Open Image…", command=self.open_image)
        self.open_btn.pack(side="left")
        self.run_btn = ttk.Button(bar, text="Remove Background", style="Accent.TButton",
                                  command=self.run)
        self.run_btn.pack(side="left", padx=(8, 0))
        self.save_btn = ttk.Button(bar, text="Save PNG…", command=self.save)
        self.save_btn.pack(side="left", padx=(8, 0))

        opts = ttk.Frame(self.root, padding=(18, 10, 18, 0))
        opts.pack(fill="x")
        ttk.Label(opts, text="Model").pack(side="left", padx=(2, 6))
        self.model_box = ttk.Combobox(opts, textvariable=self.model_label, state="readonly",
                                      values=list(bgremove.MODELS), width=22)
        self.model_box.pack(side="left")
        ttk.Checkbutton(opts, text="Refine edges", variable=self.refine,
                        style="Plain.TCheckbutton").pack(side="left", padx=(16, 0))
        ttk.Checkbutton(opts, text="Crop to subject", variable=self.crop,
                        style="Plain.TCheckbutton", command=self._recrop
                        ).pack(side="left", padx=(16, 0))
        self._style_extras()

        panes = ttk.Frame(self.root, padding=(18, 12))
        panes.pack(fill="both", expand=True)
        panes.columnconfigure((0, 1), weight=1, uniform="pane")
        panes.rowconfigure(0, weight=1)
        self.before = Preview(panes, "Original", self)
        self.before.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        self.after = Preview(panes, "Result", self)
        self.after.grid(row=0, column=1, sticky="nsew", padx=(6, 0))
        self.before.show(None, "Click Open Image… (Ctrl/⌘+O)\n\nPNG, JPEG, WebP, BMP, TIFF")
        self.after.show(None, "The cut-out with a transparent background appears here.")

        foot = ttk.Frame(self.root, padding=(18, 0, 18, 12))
        foot.pack(fill="x")
        self.progress = ttk.Progressbar(foot, mode="indeterminate", length=140)
        ttk.Label(foot, textvariable=self.status, style="Status.TLabel").pack(side="left")
        self.progress.pack(side="right")
        self.progress.pack_forget()

    def _bind_keys(self) -> None:
        mod = "Command" if sys.platform == "darwin" else "Control"
        self.root.bind(f"<{mod}-o>", lambda e: self.open_image())
        self.root.bind(f"<{mod}-s>", lambda e: self.save())
        self.root.bind("<Return>", lambda e: self.run())

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _label_for(model: str) -> str:
        for label, name in bgremove.MODELS.items():
            if name == model:
                return label
        return next(iter(bgremove.MODELS))

    def _model(self) -> str:
        return bgremove.MODELS.get(self.model_label.get(), bgremove.DEFAULT_MODEL)

    def _theme_text(self) -> str:
        mode = self.settings.get("theme", "system")
        return {"system": "Theme: System", "light": "Theme: Light", "dark": "Theme: Dark"}[mode]

    def _style_extras(self) -> None:
        """Styles theme.py doesn't define: checkboxes on the window and the model box."""
        p, s = self.palette, self.theme.style
        s.configure("Plain.TCheckbutton", background=p["bg"])
        s.map("Plain.TCheckbutton", background=[("active", p["bg"])])
        s.configure("TCombobox", fieldbackground=p["field"], background=p["surface2"],
                    foreground=p["text"], arrowcolor=p["muted"], bordercolor=p["border"],
                    lightcolor=p["field"], darkcolor=p["field"], padding=(6, 3))
        s.map("TCombobox", fieldbackground=[("readonly", p["field"])],
              foreground=[("readonly", p["text"])],
              selectbackground=[("readonly", p["field"])],
              selectforeground=[("readonly", p["text"])])
        self.root.option_add("*TCombobox*Listbox.background", p["surface"])
        self.root.option_add("*TCombobox*Listbox.foreground", p["text"])
        self.root.option_add("*TCombobox*Listbox.selectBackground", p["select"])
        self.root.option_add("*TCombobox*Listbox.selectForeground", p["select_text"])

    def _update_buttons(self) -> None:
        def state(on: bool) -> list[str]:
            return ["!disabled"] if on and not self.busy else ["disabled"]
        self.open_btn.state(state(True))
        self.run_btn.state(state(self.original is not None))
        self.save_btn.state(state(self.result is not None))
        self.model_box.state(["readonly"] + (["disabled"] if self.busy else ["!disabled"]))

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        if busy:
            self.progress.pack(side="right")
            self.progress.start(12)
            self.root.configure(cursor="watch")
        else:
            self.progress.stop()
            self.progress.pack_forget()
            self.root.configure(cursor="")
        self._update_buttons()

    def _shown_result(self) -> Image.Image | None:
        if self.result is None:
            return None
        return bgremove.crop_to_subject(self.result) if self.crop.get() else self.result

    def _recrop(self) -> None:
        if self.result is not None:
            self.after.show(self._shown_result())

    # ---------------------------------------------------------------- actions
    def open_image(self) -> None:
        if self.busy:
            return
        patterns = " ".join(f"*{ext}" for ext in bgremove.OPEN_TYPES)
        path = filedialog.askopenfilename(
            title="Open image", initialdir=self.settings.get("open_dir") or None,
            filetypes=[("Images", patterns), ("All files", "*.*")])
        if path:
            self.load(path)

    def load(self, path: str) -> None:
        try:
            img = bgremove.load_image(path)
        except Exception as exc:
            messagebox.showerror("Can't open image", f"{os.path.basename(path)}\n\n{exc}")
            return
        self.src_path, self.original, self.result = path, img, None
        self.settings["open_dir"] = os.path.dirname(path)
        self.before.show(img)
        self.after.show(None, "Click Remove Background (Enter).")
        self.status.set(f"{os.path.basename(path)} — {img.width} × {img.height}")
        self._update_buttons()

    def run(self) -> None:
        if self.busy or self.original is None:
            return
        model = self._model()
        if bgremove.model_is_downloaded(model):
            self.status.set("Removing background…")
        else:
            self.status.set("Downloading the AI model (first use only, up to 180 MB)…")
        self._set_busy(True)
        img, refine = self.original, self.refine.get()

        def work() -> None:
            try:
                self.events.put(("done", bgremove.remove_background(img, model, refine)))
            except Exception as exc:
                self.events.put(("error", exc))

        threading.Thread(target=work, daemon=True).start()

    def _poll(self) -> None:
        try:
            while True:
                kind, value = self.events.get_nowait()
                self._set_busy(False)
                if kind == "done":
                    self.result = value
                    self.after.show(self._shown_result())
                    self.status.set("Done. Save the transparent PNG with Save PNG… (Ctrl/⌘+S)")
                else:
                    self.status.set("Background removal failed.")
                    messagebox.showerror("Background removal failed", str(value))
                self._update_buttons()
        except queue.Empty:
            pass
        self.root.after(100, self._poll)

    def save(self) -> None:
        out = self._shown_result()
        if self.busy or out is None:
            return
        suggested = bgremove.default_output_path(self.src_path or "image.png")
        path = filedialog.asksaveasfilename(
            title="Save transparent PNG", defaultextension=".png",
            initialdir=self.settings.get("save_dir") or os.path.dirname(suggested),
            initialfile=os.path.basename(suggested), filetypes=[("PNG image", "*.png")])
        if not path:
            return
        try:
            path = bgremove.save_png(out, path)
        except OSError as exc:
            messagebox.showerror("Can't save", str(exc))
            return
        self.settings["save_dir"] = os.path.dirname(path)
        self.status.set(f"Saved {path}")

    def cycle_theme(self) -> None:
        modes = theme.MODES
        mode = modes[(modes.index(self.settings.get("theme", "system")) + 1) % len(modes)]
        self.settings["theme"] = mode
        self.palette = self.theme.apply(mode)
        self._style_extras()
        self.theme_btn.configure(text=self._theme_text())
        self.before.redraw()
        self.after.redraw()

    def quit(self) -> None:
        self.settings.update(geometry=self.root.geometry(), model=self._model(),
                             refine=self.refine.get(), crop=self.crop.get())
        save_settings(self.settings)
        self.root.destroy()


def self_test(report: str) -> int:
    """bgremove.self_test plus a check that results can be drawn in a Tk window."""
    code = bgremove.self_test(report)
    try:
        root = tk.Tk()
        ImageTk.PhotoImage(checkerboard((40, 40), False), master=root)
        root.destroy()
        line = "Tk preview: OK"
    except Exception as exc:  # e.g. PIL's Tk bridge missing from a frozen build
        line, code = f"Tk preview: FAIL {exc!r}", 1
    with open(report, "a") as f:
        f.write(line + "\n")
    return code


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "--self-test":
        sys.exit(self_test(sys.argv[2]))
    root = tk.Tk()
    app = App(root)
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        root.after(50, lambda: app.load(sys.argv[1]))
    if sys.platform == "darwin":
        # Images dropped on the Dock icon or opened with "Open With" in Finder.
        root.createcommand("::tk::mac::OpenDocument",
                           lambda *paths: paths and app.load(paths[0]))
    root.mainloop()


if __name__ == "__main__":
    main()
