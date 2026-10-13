"""A scanned book: its pages, their printed page numbers and their text.

Page numbers
------------
Scanning starts at page one (or whatever `Book.first_page` says). For every
page the printed number is looked for in the header and footer area of the
OCR result. A number that fits the sequence (the expected next number, or a
little further on when pages were skipped) is used and the line it sits on
is left out of the text. When no number is printed - chapter openers, blank
or illustrated pages - the number is inferred from the previous page. A
number typed in by hand always wins and the pages after it follow on.
"""

from __future__ import annotations

import json
import os
import re
import statistics
from dataclasses import dataclass, field

from ocr import Line

HEADER_FOOTER_ZONE = 0.12   # top/bottom share of the page searched for numbers
MAX_SKIP = 10               # accept a printed number this far past the expected one

PRINTED, INFERRED, MANUAL = "printed", "inferred", "manual"

_DIGITISH = str.maketrans({"O": "0", "o": "0", "D": "0", "l": "1", "I": "1",
                           "|": "1", "i": "1", "S": "5", "B": "8", "Z": "2"})
_DASHES = "-–—~·•.*()[] "
_PAGE_WORD = re.compile(r"^(?:page|p\.?|pg\.?)\s*(\S+)$", re.I)


def _as_number(token: str) -> int | None:
    """'12' -> 12, and common OCR slips such as 'l2' or '1O' too."""
    token = token.strip(_DASHES)
    if not token or len(token) > 4 or not any(c.isdigit() for c in token):
        return None
    fixed = token.translate(_DIGITISH)
    return int(fixed) if fixed.isdigit() else None


def number_candidates(line: Line) -> list[tuple[int, bool]]:
    """Page numbers a header/footer line could carry, as (number, alone).

    `alone` is True when the line is nothing but the number ("12", "- 12 -",
    "Page 12"); otherwise the number starts or ends a running head such as
    "12   THE ROAD NORTH" or "CHAPTER TWO   37".
    """
    text = line.text.strip()
    m = _PAGE_WORD.match(text)
    if m:
        n = _as_number(m.group(1))
        return [(n, True)] if n is not None else []
    if text in ("I", "l", "|"):  # a lone "1" in a serif font
        return [(1, True)]
    n = _as_number(text.replace(" ", ""))
    if n is not None and len(text.strip(_DASHES).replace(" ", "")) <= 4:
        return [(n, True)]
    words = text.split()
    found = []
    if len(words) >= 2:
        for token in (words[0], words[-1]):
            n = _as_number(token)
            if n is not None and token.strip(_DASHES).isdigit():
                found.append((n, False))
    return found


def find_page_number(lines: list[Line], height: float, expected: int
                     ) -> tuple[int | None, int | None]:
    """The printed page number and the index of its line, or (None, None)."""
    zone = HEADER_FOOTER_ZONE * height
    options = []  # (number, alone, line index)
    for i, line in enumerate(lines):
        if line.cy <= zone or line.cy >= height - zone:
            for n, alone in number_candidates(line):
                options.append((n, alone, i))
    if not options:
        return None, None
    exact = [o for o in options if o[0] == expected]
    if exact:
        exact.sort(key=lambda o: not o[1])  # a bare number beats a running head
        return exact[0][0], exact[0][2]
    ahead = [o for o in options if expected < o[0] <= expected + MAX_SKIP and o[1]]
    if ahead:
        ahead.sort(key=lambda o: o[0])
        return ahead[0][0], ahead[0][2]
    return None, None


@dataclass
class Page:
    image: str                       # file name inside the book folder
    width: int = 0
    height: int = 0
    lines: list[Line] | None = None  # OCR result; None until recognised
    manual_number: int | None = None
    text_override: str | None = None  # text edited by hand
    # Filled in by Book.renumber():
    number: int = 0
    number_source: str = INFERRED
    number_line: int | None = None

    @property
    def recognised(self) -> bool:
        return self.lines is not None

    def body_lines(self) -> list[Line]:
        return [ln for i, ln in enumerate(self.lines or []) if i != self.number_line]

    def paragraphs(self) -> list[Paragraph]:
        if self.text_override is not None:
            return [Paragraph(p.strip()) for p in re.split(r"\n\s*\n", self.text_override)
                    if p.strip()]
        return build_paragraphs(self.body_lines(), self.width)

    def text(self) -> str:
        return "\n\n".join(p.text for p in self.paragraphs())

    def word_count(self) -> int:
        return len(self.text().split())

    def to_dict(self) -> dict:
        return {
            "image": self.image, "width": self.width, "height": self.height,
            "lines": None if self.lines is None else [ln.to_dict() for ln in self.lines],
            "manual_number": self.manual_number, "text_override": self.text_override,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Page":
        lines = d.get("lines")
        return cls(image=d["image"], width=d.get("width", 0), height=d.get("height", 0),
                   lines=None if lines is None else [Line.from_dict(x) for x in lines],
                   manual_number=d.get("manual_number"),
                   text_override=d.get("text_override"))


@dataclass
class Paragraph:
    text: str
    heading: bool = False


def _rows(lines: list[Line]) -> list[Line]:
    """Merge pieces that sit side by side on one text line into one Line."""
    rows: list[list[Line]] = []
    for ln in sorted(lines, key=lambda l: (l.cy, l.x)):
        if rows:
            last = rows[-1]
            ref = max(last, key=lambda l: l.h)
            if abs(ln.cy - ref.cy) < 0.5 * min(ln.h, ref.h):
                last.append(ln)
                continue
        rows.append([ln])
    merged = []
    for row in rows:
        row.sort(key=lambda l: l.x)
        x0 = min(l.x for l in row)
        y0 = min(l.y for l in row)
        x1 = max(l.right for l in row)
        y1 = max(l.bottom for l in row)
        merged.append(Line(" ".join(l.text for l in row), x0, y0, x1 - x0, y1 - y0,
                           min(l.conf for l in row)))
    return merged


def _join(a: str, b: str) -> str:
    if a.endswith("-") and len(a) > 1 and a[-2].isalpha() and b[:1].islower():
        return a[:-1] + b  # re-join a word hyphenated across lines
    return a + " " + b


def build_paragraphs(lines: list[Line], page_width: float = 0) -> list[Paragraph]:
    """Turn OCR lines into paragraphs.

    A new paragraph starts after a larger than usual gap, at an indented
    line, or after a line that stops well short of the right margin.
    Lines that are clearly taller than the body text become headings.
    """
    rows = _rows([ln for ln in lines if ln.text.strip()])
    if not rows:
        return []
    heights = [r.h for r in rows]
    body_h = statistics.median(heights)
    pitches = [b.y - a.y for a, b in zip(rows, rows[1:]) if b.y > a.y]
    pitch = statistics.median(pitches) if pitches else body_h * 1.4
    body = [r for r in rows if r.h <= body_h * 1.3] or rows
    left = min(r.x for r in body)
    right = max(r.right for r in body)
    width = max(right - left, 1.0)
    indent = max(body_h * 0.8, width * 0.025)

    paras: list[Paragraph] = []
    prev: Line | None = None
    for row in rows:
        heading = row.h > body_h * 1.35 and len(row.text) < 80
        start = (
            prev is None
            or heading
            or paras[-1].heading
            or row.y - prev.y > pitch * 1.6
            or row.x - left > indent
            or (prev.right < right - width * 0.15 and not prev.text.endswith("-"))
        )
        if start:
            paras.append(Paragraph(row.text, heading))
        else:
            paras[-1].text = _join(paras[-1].text, row.text)
        prev = row
    return paras


@dataclass
class Book:
    folder: str
    title: str = "Untitled book"
    first_page: int = 1
    pages: list[Page] = field(default_factory=list)

    PROJECT_FILE = "book.json"

    def renumber(self) -> None:
        """Work out every page's number, starting from `first_page`."""
        expected = self.first_page
        for page in self.pages:
            page.number_line = None
            if page.manual_number is not None:
                page.number, page.number_source = page.manual_number, MANUAL
                if page.lines:
                    _, page.number_line = find_page_number(
                        page.lines, page.height, page.manual_number)
            else:
                found, idx = (find_page_number(page.lines, page.height, expected)
                              if page.lines else (None, None))
                if found is not None:
                    page.number, page.number_source, page.number_line = found, PRINTED, idx
                else:
                    page.number, page.number_source = expected, INFERRED
            expected = page.number + 1

    def image_path(self, page: Page) -> str:
        return os.path.join(self.folder, page.image)

    def next_image_name(self) -> str:
        used = {p.image for p in self.pages}
        n = len(self.pages) + 1
        while True:
            name = f"page-{n:04d}.png"
            if name not in used and not os.path.exists(os.path.join(self.folder, name)):
                return name
            n += 1

    def save(self) -> None:
        os.makedirs(self.folder, exist_ok=True)
        data = {"title": self.title, "first_page": self.first_page,
                "pages": [p.to_dict() for p in self.pages]}
        path = os.path.join(self.folder, self.PROJECT_FILE)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, path)

    @classmethod
    def load(cls, folder: str) -> "Book":
        with open(os.path.join(folder, cls.PROJECT_FILE)) as f:
            data = json.load(f)
        book = cls(folder=folder, title=data.get("title", "Untitled book"),
                   first_page=int(data.get("first_page", 1)),
                   pages=[Page.from_dict(p) for p in data.get("pages", [])])
        book.renumber()
        return book
