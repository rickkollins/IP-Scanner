#!/usr/bin/env python3
"""Book Scanner - scan a book page by page and save it as a Word document.

Toolbar: pick a scanner (camera or flatbed), capture pages (Space, or hands
free with Auto-capture), import images, export .docx. The left list shows
every page with the book page number found on it; the middle shows the
camera or the selected page; the right shows the page's text, which can be
corrected by hand.
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw, ImageTk  # noqa: E402

import capture  # noqa: E402
import export_docx  # noqa: E402
import ocr  # noqa: E402
from book import INFERRED, MANUAL, PRINTED, Book, Page  # noqa: E402

__version__ = "1.0.0"

SETTINGS = os.path.expanduser("~/.book_scanner.json")
LIBRARY = os.path.expanduser("~/Documents/Book Scanner")
IMAGE_TYPES = [("Images", "*.png *.jpg *.jpeg *.tif *.tiff *.heic *.bmp"), ("All files", "*")]
FLATBED = "Flatbed scanner"
SOURCE_LABEL = {PRINTED: "found on page", INFERRED: "counted", MANUAL: "set by hand"}


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


def new_book_folder(title: str) -> str:
    safe = re.sub(r"[^\w\- ]+", "", title).strip() or "Book"
    base = os.path.join(LIBRARY, safe)
    folder, n = base, 2
    while os.path.exists(folder):
        folder, n = f"{base} {n}", n + 1
    return folder


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.settings = load_settings()
        self.events: queue.Queue = queue.Queue()
        self.ocr_jobs: queue.Queue = queue.Queue()
        self.camera: capture.Camera | None = None
        self.watcher = capture.PageWatcher()
        self.preview_photo: ImageTk.PhotoImage | None = None
        self.last_capture = 0.0
        self.flash_until = 0.0
        self.text_dirty = False
        self.shown_page: Page | None = None

        self.book = self._open_last_book()
        self.engines = ocr.engines()

        root.title("Book Scanner")
        root.geometry(self.settings.get("geometry", "1280x800"))
        root.minsize(980, 600)
        self._build_menu()
        self._build_toolbar()
        self._build_body()
        self._build_status()
        self._bind_keys()

        threading.Thread(target=self._ocr_worker, daemon=True).start()
        self._refresh_list()
        self._queue_unread_pages()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(100, self._poll_events)
        root.after(300, self._find_cameras)
        if not self.engines:
            self.root.after(500, lambda: messagebox.showwarning(
                "Book Scanner",
                "No text recognition engine was found, so pages will be scanned but "
                "not converted to text.\n\nOn a Mac, install the requirements "
                "(see the README). Elsewhere, install Tesseract."))

    # ------------------------------------------------------------ layout
    def _build_menu(self) -> None:
        menubar = tk.Menu(self.root)
        file_menu = tk.Menu(menubar, tearoff=False)
        file_menu.add_command(label="New Book…", command=self.new_book, accelerator="Cmd+N")
        file_menu.add_command(label="Open Book…", command=self.open_book, accelerator="Cmd+O")
        file_menu.add_command(label="Show Book Folder", command=self.show_folder)
        file_menu.add_separator()
        file_menu.add_command(label="Import Images…", command=self.import_images,
                              accelerator="Cmd+I")
        file_menu.add_command(label="Export Word Document…", command=self.export,
                              accelerator="Cmd+E")
        menubar.add_cascade(label="File", menu=file_menu)
        page_menu = tk.Menu(menubar, tearoff=False)
        page_menu.add_command(label="Capture Page", command=self.capture, accelerator="Space")
        page_menu.add_command(label="Set Page Number…", command=self.set_number)
        page_menu.add_command(label="Use Detected/Counted Number", command=self.clear_number)
        page_menu.add_command(label="Rotate 90°", command=self.rotate)
        page_menu.add_command(label="Read Text Again", command=self.reread)
        page_menu.add_separator()
        page_menu.add_command(label="Move Up", command=lambda: self.move(-1))
        page_menu.add_command(label="Move Down", command=lambda: self.move(1))
        page_menu.add_command(label="Delete Page", command=self.delete_pages)
        menubar.add_cascade(label="Page", menu=page_menu)
        self.root.config(menu=menubar)

    def _build_toolbar(self) -> None:
        bar = ttk.Frame(self.root, padding=(8, 6))
        bar.pack(fill="x")

        ttk.Label(bar, text="Scanner:").pack(side="left")
        self.source_var = tk.StringVar(value="Looking for cameras…")
        self.source_box = ttk.Combobox(bar, textvariable=self.source_var, width=18,
                                       state="readonly")
        self.source_box.pack(side="left", padx=(4, 4))
        self.source_box.bind("<<ComboboxSelected>>", lambda e: self.start_source())
        self.camera_btn = ttk.Button(bar, text="Start", command=self.toggle_camera)
        self.camera_btn.pack(side="left")
        self.capture_btn = ttk.Button(bar, text="Capture Page  ␣", command=self.capture)
        self.capture_btn.pack(side="left", padx=(8, 0))

        self.auto_var = tk.BooleanVar(value=self.settings.get("auto", False))
        ttk.Checkbutton(bar, text="Auto-capture", variable=self.auto_var,
                        command=self._settings_changed).pack(side="left", padx=(10, 0))
        self.spread_var = tk.BooleanVar(value=self.settings.get("spread", False))
        ttk.Checkbutton(bar, text="Two pages per shot", variable=self.spread_var,
                        command=self._settings_changed).pack(side="left", padx=(10, 0))
        self.crop_var = tk.BooleanVar(value=self.settings.get("crop", True))
        ttk.Checkbutton(bar, text="Find page edges", variable=self.crop_var,
                        command=self._settings_changed).pack(side="left", padx=(10, 0))

        ttk.Button(bar, text="Export .docx…", command=self.export).pack(side="right")
        ttk.Button(bar, text="Import Images…", command=self.import_images).pack(
            side="right", padx=(0, 6))

    def _build_body(self) -> None:
        panes = ttk.PanedWindow(self.root, orient="horizontal")
        panes.pack(fill="both", expand=True, padx=8)

        left = ttk.Frame(panes)
        self.title_var = tk.StringVar(value=self.book.title)
        title = ttk.Entry(left, textvariable=self.title_var, font=("TkDefaultFont", 13, "bold"))
        title.pack(fill="x", pady=(0, 4))
        title.bind("<FocusOut>", lambda e: self._title_changed())
        title.bind("<Return>", lambda e: self._title_changed())
        first = ttk.Frame(left)
        first.pack(fill="x", pady=(0, 4))
        ttk.Label(first, text="First scanned page is page").pack(side="left")
        self.first_var = tk.StringVar(value=str(self.book.first_page))
        spin = ttk.Spinbox(first, from_=1, to=9999, width=5, textvariable=self.first_var,
                           command=self._first_page_changed)
        spin.pack(side="left", padx=4)
        spin.bind("<Return>", lambda e: self._first_page_changed())
        spin.bind("<FocusOut>", lambda e: self._first_page_changed())
        cols = ("page", "source", "words")
        self.tree = ttk.Treeview(left, columns=cols, show="headings", selectmode="extended")
        for cid, head, width in (("page", "Book page", 75), ("source", "Number", 110),
                                 ("words", "Words", 55)):
            self.tree.heading(cid, text=head)
            self.tree.column(cid, width=width, anchor="center" if cid != "source" else "w")
        self.tree.tag_configure("pending", foreground="#888")
        self.tree.tag_configure(INFERRED, foreground="#b06000")
        self.tree.tag_configure(MANUAL, foreground="#2060c0")
        scroll = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="top", fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._show_selected())
        self.tree.bind("<Double-1>", lambda e: self.set_number())
        buttons = ttk.Frame(left)
        buttons.pack(fill="x", pady=4)
        for text, cmd in (("▲", lambda: self.move(-1)), ("▼", lambda: self.move(1)),
                          ("⟳", self.rotate), ("#", self.set_number),
                          ("Delete", self.delete_pages)):
            ttk.Button(buttons, text=text, width=7 if len(text) > 1 else 3,
                       command=cmd).pack(side="left", padx=1)
        panes.add(left, weight=1)

        middle = ttk.Frame(panes)
        self.canvas = tk.Canvas(middle, background="#2b2b2b", highlightthickness=0,
                                width=560)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda e: self._redraw_still())
        panes.add(middle, weight=3)

        right = ttk.Frame(panes)
        ttk.Label(right, text="Page text (you can correct it here)").pack(anchor="w")
        self.text = tk.Text(right, wrap="word", undo=True, font=("Georgia", 13),
                            padx=8, pady=8, width=40)
        self.text.pack(fill="both", expand=True)
        self.text.bind("<<Modified>>", self._text_modified)
        panes.add(right, weight=2)

    def _build_status(self) -> None:
        bar = ttk.Frame(self.root, padding=(8, 2, 8, 6))
        bar.pack(fill="x")
        self.status_var = tk.StringVar()
        ttk.Label(bar, textvariable=self.status_var).pack(side="left")
        engine = self.engines[0] if self.engines else "none"
        ttk.Label(bar, text=f"Text recognition: {engine}").pack(side="right")
        self._status("Choose a scanner and press Start, or import images.")

    def _bind_keys(self) -> None:
        mod = "Command" if sys.platform == "darwin" else "Control"
        self.root.bind(f"<{mod}-n>", lambda e: self.new_book())
        self.root.bind(f"<{mod}-o>", lambda e: self.open_book())
        self.root.bind(f"<{mod}-i>", lambda e: self.import_images())
        self.root.bind(f"<{mod}-e>", lambda e: self.export())

        def space(event):
            if event.widget in (self.text,) or isinstance(event.widget, (ttk.Entry, tk.Entry)):
                return None
            self.capture()
            return "break"
        self.root.bind_all("<space>", space)
        self.tree.bind("<BackSpace>", lambda e: self.delete_pages())
        self.tree.bind("<Delete>", lambda e: self.delete_pages())

    def _status(self, msg: str) -> None:
        self.status_var.set(msg)

    # ------------------------------------------------------------ books
    def _open_last_book(self) -> Book:
        last = self.settings.get("book")
        if last and os.path.exists(os.path.join(last, Book.PROJECT_FILE)):
            try:
                return Book.load(last)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        book = Book(folder=new_book_folder("Untitled book"))
        return book

    def _set_book(self, book: Book) -> None:
        self._save_text()
        self.book = book
        self.settings["book"] = book.folder
        save_settings(self.settings)
        self.title_var.set(book.title)
        self.first_var.set(str(book.first_page))
        self.shown_page = None
        self._refresh_list()
        self._queue_unread_pages()
        self._show_selected()

    def new_book(self) -> None:
        title = simpledialog.askstring("New Book", "Title of the book:", parent=self.root)
        if not title:
            return
        book = Book(folder=new_book_folder(title), title=title.strip())
        book.save()
        self._set_book(book)
        self._status(f"New book “{book.title}”. Start with page one.")

    def open_book(self) -> None:
        folder = filedialog.askdirectory(title="Open a book folder", initialdir=LIBRARY
                                         if os.path.isdir(LIBRARY) else None)
        if not folder:
            return
        try:
            book = Book.load(folder)
        except (OSError, ValueError, KeyError, TypeError) as e:
            messagebox.showerror("Book Scanner", f"That folder is not a scanned book.\n\n{e}")
            return
        self._set_book(book)

    def show_folder(self) -> None:
        self.book.save()
        if sys.platform == "darwin":
            subprocess.run(["open", self.book.folder])
        else:
            messagebox.showinfo("Book Scanner", self.book.folder)

    def _title_changed(self) -> None:
        title = self.title_var.get().strip()
        if title and title != self.book.title:
            self.book.title = title
            self._save()

    def _first_page_changed(self) -> None:
        try:
            first = max(1, int(self.first_var.get()))
        except ValueError:
            self.first_var.set(str(self.book.first_page))
            return
        if first != self.book.first_page:
            self.book.first_page = first
            self._save()
            self._refresh_list()

    def _save(self) -> None:
        try:
            self.book.save()
            self.settings["book"] = self.book.folder
            save_settings(self.settings)
        except OSError as e:
            self._status(f"Could not save the book: {e}")

    def _settings_changed(self) -> None:
        self.settings.update(auto=self.auto_var.get(), spread=self.spread_var.get(),
                             crop=self.crop_var.get())
        self.watcher.reset()
        save_settings(self.settings)

    # ------------------------------------------------------------ scanners
    def _find_cameras(self) -> None:
        def work():
            try:
                cams = capture.list_cameras()
            except Exception:  # noqa: BLE001 - no camera support at all
                cams = []
            self.events.put(("sources", cams))
        threading.Thread(target=work, daemon=True).start()

    def _set_sources(self, cams: list[int]) -> None:
        names = [f"Camera {i + 1}" for i in cams]
        if capture.flatbed_available():
            names.append(FLATBED)
        self.source_box["values"] = names
        saved = self.settings.get("source")
        if saved in names:
            self.source_var.set(saved)
        elif names:
            self.source_var.set(names[0])
        else:
            self.source_var.set("No scanner found")
            self._status("No camera or scanner found - you can still import images.")
        self._update_buttons()

    def _source_is_camera(self) -> bool:
        return self.source_var.get().startswith("Camera ")

    def start_source(self) -> None:
        self.settings["source"] = self.source_var.get()
        save_settings(self.settings)
        self.stop_camera()
        if self._source_is_camera():
            self.start_camera()
        self._update_buttons()

    def toggle_camera(self) -> None:
        if self.camera:
            self.stop_camera()
        else:
            self.start_source()

    def start_camera(self) -> None:
        index = int(self.source_var.get().split()[-1]) - 1
        try:
            self.camera = capture.Camera(index)
        except RuntimeError as e:
            messagebox.showerror("Book Scanner", str(e))
            return
        self.watcher.reset()
        self.tree.selection_set(())
        self._status("Camera on. Lay the book flat, page one first, and press Space "
                     "(or turn on Auto-capture).")
        self._update_buttons()
        self.root.after(30, self._preview_loop)

    def stop_camera(self) -> None:
        if self.camera:
            cam, self.camera = self.camera, None
            threading.Thread(target=cam.close, daemon=True).start()
            self._update_buttons()
            self._show_selected()

    def _update_buttons(self) -> None:
        if self._source_is_camera():
            self.camera_btn.configure(text="Stop" if self.camera else "Start",
                                      state="normal")
            self.capture_btn.configure(state="normal" if self.camera else "disabled")
        elif self.source_var.get() == FLATBED:
            self.camera_btn.configure(text="Start", state="disabled")
            self.capture_btn.configure(state="normal")
        else:
            self.camera_btn.configure(state="disabled")
            self.capture_btn.configure(state="disabled")

    def _preview_loop(self) -> None:
        cam = self.camera
        if cam is None:
            return
        if not cam.alive:
            self.stop_camera()
            self._status("The camera stopped sending pictures.")
            return
        frame = cam.frame()
        if frame is not None:
            corners = capture.find_page(frame) if self.crop_var.get() else None
            self._draw_frame(frame, corners)
            if (self.auto_var.get() and self.watcher.update(frame)
                    and time.monotonic() - self.last_capture > 1.5):
                self.capture()
        self.root.after(66, self._preview_loop)

    def _draw_frame(self, frame, corners) -> None:
        fh, fw = frame.shape[:2]
        cw, ch = max(self.canvas.winfo_width(), 1), max(self.canvas.winfo_height(), 1)
        scale = min(cw / fw, ch / fh)
        size = (max(1, int(fw * scale)), max(1, int(fh * scale)))
        shown = capture.to_pil(capture.cv2.resize(frame, size,
                                                  interpolation=capture.cv2.INTER_AREA))
        draw = ImageDraw.Draw(shown)
        if corners is not None:
            pts = [tuple(p * scale) for p in corners]
            draw.line(pts + [pts[0]], fill=(60, 200, 90), width=3)
        if self.spread_var.get():
            x = shown.width // 2
            draw.line([(x, 0), (x, shown.height)], fill=(240, 180, 40), width=1)
        if time.monotonic() < self.flash_until:
            draw.rectangle([0, 0, shown.width - 1, shown.height - 1],
                           outline=(255, 255, 255), width=8)
        self._put_on_canvas(shown)

    def _put_on_canvas(self, image: Image.Image) -> None:
        self.preview_photo = ImageTk.PhotoImage(image)
        cw, ch = self.canvas.winfo_width(), self.canvas.winfo_height()
        self.canvas.delete("all")
        self.canvas.create_image(cw // 2, ch // 2, image=self.preview_photo, anchor="center")

    # ------------------------------------------------------------ capturing
    def capture(self) -> None:
        if self.camera:
            frame = self.camera.frame()
            if frame is None:
                return
            self.last_capture = time.monotonic()
            self.flash_until = self.last_capture + 0.25
            images = capture.process_capture(frame, self.crop_var.get(),
                                             self.spread_var.get())
            self._add_images(images)
        elif self.source_var.get() == FLATBED:
            self.capture_btn.configure(state="disabled")
            self._status("Scanning on the flatbed…")
            spread = self.spread_var.get()

            def work():
                try:
                    img = capture.scan_flatbed()
                    self.events.put(("scanned", capture.process_image(img, spread)))
                except Exception as e:  # noqa: BLE001 - shown to the user
                    self.events.put(("error", str(e)))
            threading.Thread(target=work, daemon=True).start()

    def import_images(self) -> None:
        paths = filedialog.askopenfilenames(title="Import page images",
                                            filetypes=IMAGE_TYPES)
        if not paths:
            return
        images = []
        for path in sorted(paths, key=natural_key):
            try:
                with Image.open(path) as img:
                    images.extend(capture.process_image(img, self.spread_var.get()))
            except OSError as e:
                messagebox.showerror("Book Scanner", f"Could not open {path}:\n{e}")
        self._add_images(images)

    def _add_images(self, images: list[Image.Image]) -> None:
        os.makedirs(self.book.folder, exist_ok=True)
        for img in images:
            name = self.book.next_image_name()
            img.save(os.path.join(self.book.folder, name))
            page = Page(image=name, width=img.width, height=img.height)
            self.book.pages.append(page)
            self.ocr_jobs.put(page)
        if images:
            self._save()
            self._refresh_list(select_last=self.camera is None)
            n = len(self.book.pages)
            self._status(f"Captured. {n} page{'s' if n != 1 else ''} so far - "
                         "turn the page.")

    # ------------------------------------------------------------ OCR
    def _queue_unread_pages(self) -> None:
        for page in self.book.pages:
            if not page.recognised:
                self.ocr_jobs.put(page)

    def _ocr_worker(self) -> None:
        while True:
            page = self.ocr_jobs.get()
            book = self.book
            if not self.engines or page not in book.pages or page.recognised:
                continue
            try:
                with Image.open(book.image_path(page)) as img:
                    lines = ocr.recognize(img)
                self.events.put(("ocr", (book, page, lines)))
            except Exception as e:  # noqa: BLE001 - shown to the user
                self.events.put(("error", f"Text recognition failed: {e}"))

    def _pending_count(self) -> int:
        return sum(1 for p in self.book.pages if not p.recognised)

    # ------------------------------------------------------------ events
    def _poll_events(self) -> None:
        try:
            while True:
                kind, data = self.events.get_nowait()
                if kind == "sources":
                    self._set_sources(data)
                elif kind == "scanned":
                    self._add_images(data)
                    self._update_buttons()
                elif kind == "error":
                    self._update_buttons()
                    self._status(data)
                    messagebox.showerror("Book Scanner", data)
                elif kind == "ocr":
                    book, page, lines = data
                    if book is self.book and page in book.pages:
                        page.lines = lines
                        self._save()
                        self._refresh_list()
                        if page is self.shown_page:
                            self._show_page(page)
                        left = self._pending_count()
                        if left:
                            self._status(f"Reading text… {left} page(s) to go.")
                        else:
                            self._status(f"All {len(book.pages)} pages read. "
                                         "Export when you are done.")
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    # ------------------------------------------------------------ page list
    def _refresh_list(self, select_last: bool = False) -> None:
        self.book.renumber()
        selected = [self.tree.index(i) for i in self.tree.selection()]
        self.tree.delete(*self.tree.get_children())
        for i, page in enumerate(self.book.pages):
            if page.recognised:
                values = (page.number, SOURCE_LABEL[page.number_source], page.word_count())
                tag = page.number_source
            else:
                values = (page.number, "reading…", "")
                tag = "pending"
            self.tree.insert("", "end", iid=str(i), values=values, tags=(tag,))
        children = self.tree.get_children()
        if select_last and children:
            self.tree.selection_set(children[-1])
            self.tree.see(children[-1])
        else:
            keep = [children[i] for i in selected if i < len(children)]
            if keep:
                self.tree.selection_set(keep)
            elif children:
                self.tree.see(children[-1])

    def _selected_pages(self) -> list[Page]:
        return [self.book.pages[int(i)] for i in self.tree.selection()
                if int(i) < len(self.book.pages)]

    def _show_selected(self) -> None:
        pages = self._selected_pages()
        if pages and self.camera is None:
            self._show_page(pages[0])
        elif pages:
            self._show_text(pages[0])
        elif self.camera is None:
            self._save_text()
            self.shown_page = None
            self.canvas.delete("all")
            self._set_text("")

    def _show_page(self, page: Page) -> None:
        self._show_text(page)
        self._redraw_still()

    def _redraw_still(self) -> None:
        page = self.shown_page
        if self.camera is not None or page is None:
            return
        try:
            image = Image.open(self.book.image_path(page)).convert("RGB")
        except OSError:
            self.canvas.delete("all")
            return
        cw, ch = max(self.canvas.winfo_width(), 1), max(self.canvas.winfo_height(), 1)
        scale = min(cw / image.width, ch / image.height)
        shown = image.resize((max(1, int(image.width * scale)),
                              max(1, int(image.height * scale))))
        if page.number_line is not None and page.lines:
            ln = page.lines[page.number_line]
            draw = ImageDraw.Draw(shown)
            pad = 4
            draw.rectangle([ln.x * scale - pad, ln.y * scale - pad,
                            ln.right * scale + pad, ln.bottom * scale + pad],
                           outline=(40, 170, 80), width=3)
        self._put_on_canvas(shown)
        label = self.canvas.create_text(16, 14, anchor="nw", fill="#fff",
                                        font=("TkDefaultFont", 14, "bold"),
                                        text=f"Page {page.number}")
        x0, y0, x1, y1 = self.canvas.bbox(label)
        box = self.canvas.create_rectangle(x0 - 6, y0 - 3, x1 + 6, y1 + 3,
                                           fill="#2b7a3d", outline="")
        self.canvas.tag_lower(box, label)

    def _show_text(self, page: Page) -> None:
        if page is self.shown_page and self.text_dirty:
            return
        self._save_text()
        self.shown_page = page
        if not page.recognised and page.text_override is None:
            self._set_text("Reading text…" if self.engines else "")
        else:
            self._set_text(page.text())

    def _set_text(self, text: str) -> None:
        self.text.delete("1.0", "end")
        self.text.insert("1.0", text)
        self.text.edit_modified(False)
        self.text.edit_reset()
        self.text_dirty = False

    def _text_modified(self, _event=None) -> None:
        if self.text.edit_modified():
            self.text_dirty = True

    def _save_text(self) -> None:
        page = self.shown_page
        if page is None or not self.text_dirty:
            return
        self.text_dirty = False
        text = self.text.get("1.0", "end").rstrip()
        if page in self.book.pages and text != page.text():
            page.text_override = text
            self._save()
            self._refresh_list()

    # ------------------------------------------------------------ page actions
    def set_number(self) -> None:
        pages = self._selected_pages()
        if not pages:
            return
        page = pages[0]
        n = simpledialog.askinteger(
            "Page number", "Book page number for this page\n"
            "(the pages after it follow on from it):",
            initialvalue=page.number, minvalue=1, maxvalue=99999, parent=self.root)
        if n is None:
            return
        if self.book.pages.index(page) == 0 and page.manual_number is None:
            self.book.first_page = n
            self.first_var.set(str(n))
        else:
            page.manual_number = n
        self._save()
        self._refresh_list()
        self._show_selected()

    def clear_number(self) -> None:
        for page in self._selected_pages():
            page.manual_number = None
        self._save()
        self._refresh_list()
        self._show_selected()

    def rotate(self) -> None:
        pages = self._selected_pages()
        for page in pages:
            path = self.book.image_path(page)
            with Image.open(path) as img:
                turned = img.rotate(-90, expand=True)
            turned.save(path)
            page.width, page.height = turned.size
            page.lines = None
            page.text_override = None
            self.ocr_jobs.put(page)
        if pages:
            self._save()
            self._refresh_list()
            self._show_selected()

    def reread(self) -> None:
        for page in self._selected_pages():
            page.lines = None
            page.text_override = None
            self.ocr_jobs.put(page)
        self.shown_page = None
        self._refresh_list()
        self._show_selected()

    def move(self, step: int) -> None:
        idx = sorted(int(i) for i in self.tree.selection())
        if not idx:
            return
        pages = self.book.pages
        if (step < 0 and idx[0] == 0) or (step > 0 and idx[-1] == len(pages) - 1):
            return
        for i in (idx if step < 0 else reversed(idx)):
            pages[i], pages[i + step] = pages[i + step], pages[i]
        self._save()
        self._refresh_list()
        self.tree.selection_set([str(i + step) for i in idx])

    def delete_pages(self) -> None:
        pages = self._selected_pages()
        if not pages:
            return
        noun = "this page" if len(pages) == 1 else f"these {len(pages)} pages"
        if not messagebox.askyesno("Delete", f"Delete {noun}?", parent=self.root):
            return
        self.text_dirty = False
        for page in pages:
            self.book.pages.remove(page)
            try:
                os.remove(self.book.image_path(page))
            except OSError:
                pass
        self.shown_page = None
        self._save()
        self.tree.selection_set(())
        self._refresh_list()
        self._show_selected()

    # ------------------------------------------------------------ export
    def export(self) -> None:
        self._save_text()
        self._title_changed()
        if not self.book.pages:
            messagebox.showinfo("Book Scanner", "Scan or import some pages first.")
            return
        left = self._pending_count()
        if left and self.engines and not messagebox.askyesno(
                "Export", f"{left} page(s) are still being read and will be empty in the "
                "document. Export anyway?"):
            return
        paper = PaperDialog(self.root, self.settings.get("paper")).result
        if paper is None:
            return
        self.settings["paper"] = paper
        save_settings(self.settings)
        name = re.sub(r"[^\w\- ]+", "", self.book.title).strip() or "Book"
        path = filedialog.asksaveasfilename(
            title="Save Word document", defaultextension=".docx", initialfile=f"{name}.docx",
            initialdir=self.settings.get("export_dir") or os.path.expanduser("~/Documents"),
            filetypes=[("Word document", "*.docx")])
        if not path:
            return
        try:
            count = export_docx.export(self.book, path, paper)
        except Exception as e:  # noqa: BLE001 - shown to the user
            messagebox.showerror("Book Scanner", f"Could not save the document:\n{e}")
            return
        self.settings["export_dir"] = os.path.dirname(path)
        save_settings(self.settings)
        first, last = self.book.pages[0].number, self.book.pages[-1].number
        self._status(f"Saved {count} pages (book pages {first}–{last}) to {path}")
        if sys.platform == "darwin" and messagebox.askyesno(
                "Exported", f"Saved {count} pages to\n{path}\n\nOpen it now?"):
            subprocess.run(["open", path])

    def on_close(self) -> None:
        self._save_text()
        self._title_changed()
        if self.book.pages:
            self._save()
        self.stop_camera()
        self.settings["geometry"] = self.root.geometry()
        save_settings(self.settings)
        self.root.destroy()


class PaperDialog(simpledialog.Dialog):
    def __init__(self, parent, current):
        self.current = current if current in export_docx.PAPER_SIZES else None
        self.result = None
        super().__init__(parent, "Export Word document")

    def body(self, master):
        ttk.Label(master, text="Paper size for the Word document:").pack(anchor="w")
        self.var = tk.StringVar(value=self.current or next(iter(export_docx.PAPER_SIZES)))
        for name in export_docx.PAPER_SIZES:
            ttk.Radiobutton(master, text=name, value=name, variable=self.var).pack(
                anchor="w", padx=12)
        ttk.Label(master, text="Each book page starts a new page in Word and keeps\n"
                  "the book's page number in the footer.",
                  foreground="#666").pack(anchor="w", pady=(8, 0))
        return None

    def apply(self):
        self.result = self.var.get()


def natural_key(path: str):
    """Sort 'scan 2.jpg' before 'scan 10.jpg'."""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", os.path.basename(path))]


def main() -> None:
    root = tk.Tk()
    try:
        style = ttk.Style(root)
        if sys.platform != "darwin" and "clam" in style.theme_names():
            style.theme_use("clam")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
