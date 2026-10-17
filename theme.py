"""Light-blue and dark themes for the IP Scanner window (standard library only).

Tk has no rounded widgets, so buttons, input boxes and cards use small
anti-aliased rounded-rectangle images that stretch to any size (9-slice).
Everything else is ttk styling on top of the built-in "clam" theme.
"""

from __future__ import annotations

import sys
import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk

LIGHT = {
    "name": "light",
    "bg": "#eaf3fc",          # window: very light blue
    "header": "#d4e9fb",      # header band
    "header_text": "#0d3a63",
    "surface": "#ffffff",     # cards
    "surface2": "#f2f8fe",    # secondary buttons
    "surface2_hover": "#e3f0fc",
    "surface2_pressed": "#d2e7fa",
    "field": "#f8fbff",
    "border": "#cfe1f3",
    "accent": "#2b8be0",      # light blue
    "accent_hover": "#45a0ee",
    "accent_pressed": "#1d74c2",
    "accent_text": "#ffffff",
    "text": "#17283a",
    "muted": "#5f7489",
    "stripe": "#f4f9fe",
    "select": "#cfe6fb",
    "select_text": "#0b3459",
    "service": "#1f74c9",
    "alive": "#21a35b",
    "pill": "#e1effc",
}

DARK = {
    "name": "dark",
    "bg": "#0e1621",
    "header": "#122438",
    "header_text": "#d8ecff",
    "surface": "#152131",
    "surface2": "#1b2a3d",
    "surface2_hover": "#223650",
    "surface2_pressed": "#2a4260",
    "field": "#101b29",
    "border": "#263a52",
    "accent": "#4fb3ff",      # bright light blue
    "accent_hover": "#6fc2ff",
    "accent_pressed": "#3a9be6",
    "accent_text": "#04213b",
    "text": "#e2ecf6",
    "muted": "#8ea4ba",
    "stripe": "#182638",
    "select": "#1e4568",
    "select_text": "#ffffff",
    "service": "#7cc6ff",
    "alive": "#3ddc84",
    "pill": "#1d3249",
}

MODES = ("system", "light", "dark")


# ---------------------------------------------------------------------------
# Detecting the system appearance
# ---------------------------------------------------------------------------

def system_is_dark(root: tk.Misc) -> bool:
    if sys.platform == "darwin":
        try:
            return bool(int(root.tk.call("tk::unsupported::MacWindowStyle", "isdark", root)))
        except (tk.TclError, ValueError):
            return False
    if sys.platform == "win32":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                 r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            return winreg.QueryValueEx(key, "AppsUseLightTheme")[0] == 0
        except OSError:
            return False
    return False


def palette_for(mode: str, root: tk.Misc) -> dict:
    if mode == "dark" or (mode == "system" and system_is_dark(root)):
        return DARK
    return LIGHT


# ---------------------------------------------------------------------------
# Rounded-rectangle images
# ---------------------------------------------------------------------------

def _rgb(color: str) -> tuple[int, int, int]:
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def _inside(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    dx = max(x0 + r - px, 0.0, px - (x1 - r))
    dy = max(y0 + r - py, 0.0, py - (y1 - r))
    return dx * dx + dy * dy <= r * r


def rounded_image(size: int, radius: float, fill: str, border: str, bg: str,
                  border_width: float = 1.0) -> tk.PhotoImage:
    """A size x size rounded rectangle, anti-aliased against bg."""
    fill_c, border_c, bg_c = _rgb(fill), _rgb(border), _rgb(bg)
    samples = [(i + 0.5) / 4 for i in range(4)]
    n = len(samples) ** 2
    bw = border_width
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            outer = inner = 0
            for sy in samples:
                for sx in samples:
                    px, py = x + sx, y + sy
                    if _inside(px, py, 0, 0, size, size, radius):
                        outer += 1
                        if _inside(px, py, bw, bw, size - bw, size - bw, max(radius - bw, 0)):
                            inner += 1
            a_border = (outer - inner) / n
            a_fill = inner / n
            a_bg = 1 - outer / n
            rgb = tuple(round(b * a_bg + e * a_border + f * a_fill)
                        for b, e, f in zip(bg_c, border_c, fill_c))
            row.append("#%02x%02x%02x" % rgb)
        rows.append("{" + " ".join(row) + "}")
    img = tk.PhotoImage(width=size, height=size)
    img.put(" ".join(rows))
    return img


def dot_image(img: tk.PhotoImage, color: str) -> tk.PhotoImage:
    """(Re)draw a filled circle into img, used for the status icons."""
    size = img.width()
    c = (size - 1) / 2
    img.blank()
    for y in range(size):
        for x in range(size):
            if (x - c) ** 2 + (y - c) ** 2 <= (c - 0.5) ** 2:
                img.put(color, (x, y))
    return img


# ---------------------------------------------------------------------------
# Applying a theme
# ---------------------------------------------------------------------------

def _fonts() -> dict[str, tkfont.Font]:
    base = tkfont.nametofont("TkDefaultFont")
    if sys.platform == "win32":
        family, size = "Segoe UI", 10
    elif sys.platform == "darwin":
        family, size = base.actual("family"), 13
    else:
        family, size = base.actual("family"), 10
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
        try:
            tkfont.nametofont(name).configure(family=family, size=size)
        except tk.TclError:
            pass
    return {
        "base": tkfont.Font(family=family, size=size),
        "bold": tkfont.Font(family=family, size=size, weight="bold"),
        "small": tkfont.Font(family=family, size=size - 1),
        "title": tkfont.Font(family=family, size=size + 6, weight="bold"),
        "heading": tkfont.Font(family=family, size=size - 1, weight="bold"),
    }


class Theme:
    """Creates one ttk theme per palette and switches between them."""

    def __init__(self, root: tk.Tk):
        self.root = root
        self.style = ttk.Style(root)
        self.fonts = _fonts()
        self.images: dict[str, dict[str, tk.PhotoImage]] = {}
        self.palette = LIGHT

    def apply(self, mode: str) -> dict:
        p = palette_for(mode, self.root)
        self.palette = p
        name = f"ipscanner-{p['name']}"
        if name not in self.style.theme_names():
            self._create(name, p)
        self.style.theme_use(name)
        self.root.configure(background=p["bg"])
        self.root.option_add("*Menu.background", p["surface"])
        self.root.option_add("*Menu.foreground", p["text"])
        self.root.option_add("*Menu.activeBackground", p["select"])
        self.root.option_add("*Menu.activeForeground", p["select_text"])
        self._title_bar(p["name"] == "dark")
        return p

    # One-time creation of a ttk theme with rounded elements.
    def _create(self, name: str, p: dict) -> None:
        s = self.style
        s.theme_create(name, parent="clam")
        s.theme_use(name)
        f = self.fonts
        img = self.images[name] = {
            "card": rounded_image(32, 10, p["surface"], p["border"], p["bg"]),
            "btn": rounded_image(24, 7, p["surface2"], p["border"], p["surface"]),
            "btn_hover": rounded_image(24, 7, p["surface2_hover"], p["border"], p["surface"]),
            "btn_pressed": rounded_image(24, 7, p["surface2_pressed"], p["border"], p["surface"]),
            "btn_disabled": rounded_image(24, 7, p["surface"], p["border"], p["surface"]),
            "accent": rounded_image(24, 7, p["accent"], p["accent"], p["surface"]),
            "accent_hover": rounded_image(24, 7, p["accent_hover"], p["accent_hover"],
                                          p["surface"]),
            "accent_pressed": rounded_image(24, 7, p["accent_pressed"], p["accent_pressed"],
                                            p["surface"]),
            "header_btn": rounded_image(24, 12, p["surface"], p["border"], p["header"]),
            "header_btn_hover": rounded_image(24, 12, p["surface2_hover"], p["border"],
                                              p["header"]),
            "entry": rounded_image(24, 7, p["field"], p["border"], p["surface"]),
            "entry_focus": rounded_image(24, 7, p["field"], p["accent"], p["surface"], 2),
            "pill": rounded_image(20, 10, p["pill"], p["pill"], p["surface"]),
        }

        s.configure(".", background=p["bg"], foreground=p["text"], font=f["base"],
                    bordercolor=p["border"], lightcolor=p["surface"], darkcolor=p["border"],
                    troughcolor=p["stripe"], focuscolor=p["accent"],
                    selectbackground=p["select"], selectforeground=p["select_text"],
                    fieldbackground=p["field"], insertcolor=p["text"])
        s.configure("TFrame", background=p["bg"])
        s.configure("TLabel", background=p["bg"], foreground=p["text"])

        # Cards: white rounded panels on the light-blue window.
        s.element_create("Card.bg", "image", img["card"], border=12, padding=0, sticky="nsew")
        s.layout("Card.TFrame", [("Card.bg", {"sticky": "nsew"})])
        s.configure("Card.TFrame", padding=(14, 12))
        s.configure("Card.TLabel", background=p["surface"])
        s.configure("Inner.TFrame", background=p["surface"])
        s.configure("CardMuted.TLabel", background=p["surface"], foreground=p["muted"],
                    font=f["small"])
        s.configure("Card.TCheckbutton", background=p["surface"])

        # Header band.
        s.configure("Header.TFrame", background=p["header"])
        s.configure("Header.TLabel", background=p["header"], foreground=p["header_text"])
        s.configure("Title.TLabel", background=p["header"], foreground=p["header_text"],
                    font=f["title"])
        s.configure("Subtitle.TLabel", background=p["header"], foreground=p["muted"],
                    font=f["small"])
        s.element_create("HeaderButton.bg", "image", img["header_btn"],
                         ("active", img["header_btn_hover"]), border=10, padding=0, sticky="nsew")
        s.layout("Header.TButton", [("HeaderButton.bg", {"sticky": "nsew", "children": [
            ("Button.padding", {"sticky": "nsew", "children": [
                ("Button.label", {"sticky": "nsew"})]})]})])
        s.configure("Header.TButton", padding=(14, 6), foreground=p["header_text"],
                    anchor="center")

        # Buttons.
        s.element_create("Rounded.bg", "image", img["btn"],
                         ("disabled", img["btn_disabled"]), ("pressed", img["btn_pressed"]),
                         ("active", img["btn_hover"]), border=8, padding=0, sticky="nsew")
        button_layout = [("Rounded.bg", {"sticky": "nsew", "children": [
            ("Button.padding", {"sticky": "nsew", "children": [
                ("Button.label", {"sticky": "nsew"})]})]})]
        s.layout("TButton", button_layout)
        s.configure("TButton", padding=(12, 6), anchor="center", foreground=p["text"])
        s.map("TButton", foreground=[("disabled", p["muted"])])

        s.element_create("Accent.bg", "image", img["accent"],
                         ("pressed", img["accent_pressed"]), ("active", img["accent_hover"]),
                         border=8, padding=0, sticky="nsew")
        s.layout("Accent.TButton", [("Accent.bg", {"sticky": "nsew", "children": [
            ("Button.padding", {"sticky": "nsew", "children": [
                ("Button.label", {"sticky": "nsew"})]})]})])
        s.configure("Accent.TButton", padding=(16, 6), anchor="center",
                    foreground=p["accent_text"], font=f["bold"])
        s.map("Accent.TButton", foreground=[("disabled", p["muted"])])

        # Input boxes.
        s.element_create("Rounded.field", "image", img["entry"], ("focus", img["entry_focus"]),
                         border=8, padding=0, sticky="nsew")
        s.layout("TEntry", [("Rounded.field", {"sticky": "nsew", "children": [
            ("Entry.padding", {"sticky": "nsew", "children": [
                ("Entry.textarea", {"sticky": "nsew"})]})]})])
        s.configure("TEntry", padding=(10, 6), foreground=p["text"],
                    selectbackground=p["select"], selectforeground=p["select_text"])

        # Checkbox.
        s.configure("TCheckbutton", background=p["surface"], foreground=p["text"],
                    indicatorbackground=p["field"], indicatorforeground=p["accent_text"],
                    upperbordercolor=p["border"], lowerbordercolor=p["border"],
                    indicatormargin=(0, 0, 6, 0), indicatorsize=14)
        s.map("TCheckbutton",
              indicatorbackground=[("selected", p["accent"]), ("active", p["surface2_hover"])],
              background=[("active", p["surface"])])

        # Results list.
        s.layout("Treeview", [("Treeview.treearea", {"sticky": "nsew"})])
        s.configure("Treeview", background=p["surface"], fieldbackground=p["surface"],
                    foreground=p["text"], rowheight=int(f["base"].metrics("linespace") * 1.9),
                    borderwidth=0, font=f["base"])
        s.map("Treeview", background=[("selected", p["select"])],
              foreground=[("selected", p["select_text"])])
        s.configure("Treeview.Heading", background=p["surface"], foreground=p["muted"],
                    font=f["heading"], relief="flat", borderwidth=0, padding=(6, 6),
                    bordercolor=p["surface"], lightcolor=p["surface"], darkcolor=p["border"])
        s.map("Treeview.Heading", background=[("active", p["stripe"])],
              foreground=[("active", p["text"])])

        # Scrollbar and progress bar.
        for orient in ("Vertical", "Horizontal"):
            s.configure(f"{orient}.TScrollbar", background=p["surface2"],
                        troughcolor=p["surface"], bordercolor=p["surface"],
                        lightcolor=p["surface2"], darkcolor=p["surface2"],
                        arrowcolor=p["muted"], gripcount=0, arrowsize=12)
            s.map(f"{orient}.TScrollbar", background=[("active", p["surface2_hover"])])
        s.configure("Horizontal.TProgressbar", background=p["accent"], troughcolor=p["stripe"],
                    bordercolor=p["bg"], lightcolor=p["accent"], darkcolor=p["accent"],
                    thickness=6)

        # Status bar.
        s.configure("Status.TLabel", background=p["bg"], foreground=p["muted"])
        s.element_create("Pill.bg", "image", img["pill"], border=9, padding=0, sticky="nsew")
        s.layout("Pill.TLabel", [("Pill.bg", {"sticky": "nsew", "children": [
            ("Label.padding", {"sticky": "nsew", "children": [
                ("Label.label", {"sticky": "nsew"})]})]})])
        s.configure("Pill.TLabel", padding=(10, 2), foreground=p["select_text"],
                    font=f["small"])

    def _title_bar(self, dark: bool) -> None:
        """Dark window title bar to match (Windows 10/11 and macOS)."""
        root = self.root
        if sys.platform == "win32":
            try:
                import ctypes
                root.update_idletasks()
                hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
                value = ctypes.c_int(1 if dark else 0)
                for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE (new, old builds)
                    if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                            hwnd, attr, ctypes.byref(value), ctypes.sizeof(value)) == 0:
                        break
            except (AttributeError, OSError):
                pass
        elif sys.platform == "darwin":
            try:
                root.tk.call("::tk::unsupported::MacWindowStyle", "appearance", root,
                             "darkaqua" if dark else "aqua")
            except tk.TclError:
                pass
