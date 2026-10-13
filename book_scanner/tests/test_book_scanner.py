import os
import sys
import tempfile
import textwrap
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import capture  # noqa: E402
import export_docx  # noqa: E402
import ocr  # noqa: E402
from book import (INFERRED, MANUAL, PRINTED, Book, Page, build_paragraphs,  # noqa: E402
                  find_page_number, number_candidates)
from ocr import Line  # noqa: E402

H = 2000  # page height used for synthetic OCR results


def body(lines_text, top=300, left=150, pitch=60, h=40, indent=()):
    out = []
    for i, t in enumerate(lines_text):
        x = left + (60 if i in indent else 0)
        out.append(Line(t, x, top + i * pitch, 1100 - (x - left), h))
    return out


class PageNumberTests(unittest.TestCase):
    def test_candidates(self):
        self.assertEqual(number_candidates(Line("12", 0, 0, 1, 1)), [(12, True)])
        self.assertEqual(number_candidates(Line("- 7 -", 0, 0, 1, 1)), [(7, True)])
        self.assertEqual(number_candidates(Line("Page 33", 0, 0, 1, 1)), [(33, True)])
        self.assertEqual(number_candidates(Line("l2", 0, 0, 1, 1)), [(12, True)])
        self.assertEqual(number_candidates(Line("14 THE ROAD NORTH", 0, 0, 1, 1)),
                         [(14, False)])
        self.assertEqual(number_candidates(Line("CHAPTER TWO 37", 0, 0, 1, 1)),
                         [(37, False)])
        self.assertEqual(number_candidates(Line("It was 1923 and cold", 0, 0, 1, 1)), [])
        self.assertEqual(number_candidates(Line("I", 0, 0, 1, 1)), [])

    def test_footer_number(self):
        lines = body(["Some text here"]) + [Line("5", 600, 1900, 30, 40)]
        self.assertEqual(find_page_number(lines, H, 5), (5, 1))

    def test_number_in_body_is_ignored(self):
        lines = [Line("Some text", 150, 300, 900, 40), Line("5", 600, 1000, 30, 40)]
        self.assertEqual(find_page_number(lines, H, 5), (None, None))

    def test_running_head_needs_exact_match(self):
        head = Line("14 THE ROAD NORTH", 150, 60, 900, 40)
        self.assertEqual(find_page_number([head], H, 14), (14, 0))
        self.assertEqual(find_page_number([head], H, 12), (None, None))

    def test_skipped_pages_accepted(self):
        lines = [Line("9", 600, 1900, 30, 40)]
        self.assertEqual(find_page_number(lines, H, 6), (9, 0))
        self.assertEqual(find_page_number(lines, H, 20), (None, None))  # going back
        far = [Line("90", 600, 1900, 30, 40)]
        self.assertEqual(find_page_number(far, H, 6), (None, None))

    def test_book_numbering(self):
        def page(*lines):
            return Page(image="x.png", width=1400, height=H, lines=list(lines))
        book = Book(folder="/nonexistent", pages=[
            page(Line("TITLE", 300, 800, 800, 90)),             # no number -> 1
            page(Line("text", 150, 300, 900, 40), Line("2", 600, 1900, 30, 40)),
            page(Line("text", 150, 300, 900, 40)),               # unnumbered -> 3
            page(Line("text", 150, 300, 900, 40), Line("6", 600, 1900, 30, 40)),  # skip
            page(Line("text", 150, 300, 900, 40), Line("1", 600, 1900, 30, 40)),
        ])
        book.renumber()
        self.assertEqual([p.number for p in book.pages], [1, 2, 3, 6, 7])
        self.assertEqual([p.number_source for p in book.pages],
                         [INFERRED, PRINTED, INFERRED, PRINTED, INFERRED])
        # The number line is left out of the text.
        self.assertEqual(book.pages[1].text(), "text")
        # A number set by hand wins and the next pages follow on.
        book.pages[2].manual_number = 40
        book.renumber()
        self.assertEqual([p.number for p in book.pages], [1, 2, 40, 41, 42])
        self.assertEqual(book.pages[2].number_source, MANUAL)
        book.first_page = 5
        book.renumber()
        self.assertEqual(book.pages[0].number, 5)


class ParagraphTests(unittest.TestCase):
    def test_paragraphs_and_hyphenation(self):
        lines = body([
            "It was the best of times, it was the worst of",
            "times, it was the age of wisdom, it was the age of foolish-",
            "ness, it was the epoch of belief.",
            "There were a king with a large jaw and a queen",
            "with a plain face, on the throne of England.",
        ], indent=(3,))
        lines[2].w = 600  # short last line of the first paragraph
        paras = build_paragraphs(lines)
        self.assertEqual(len(paras), 2)
        self.assertIn("age of foolishness, it was", paras[0].text)
        self.assertTrue(paras[1].text.startswith("There were"))

    def test_heading_and_side_by_side_pieces(self):
        lines = [Line("Chapter One", 400, 200, 500, 80)] + body(
            ["The first line of the chapter", "goes on here."])
        lines.append(Line("and more", 1260, 300, 200, 40))  # same row as line 1
        paras = build_paragraphs(lines)
        self.assertTrue(paras[0].heading)
        self.assertEqual(paras[0].text, "Chapter One")
        self.assertEqual(paras[1].text,
                         "The first line of the chapter and more goes on here.")

    def test_text_override(self):
        page = Page(image="x.png", lines=[], text_override="One.\n\nTwo.")
        self.assertEqual([p.text for p in page.paragraphs()], ["One.", "Two."])


class SaveLoadTests(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Book(folder=tmp, title="My Book", first_page=3, pages=[
                Page(image="page-0001.png", width=10, height=20,
                     lines=[Line("hi", 1, 2, 3, 4, 0.5)], manual_number=None),
                Page(image="page-0002.png", lines=None, manual_number=9,
                     text_override="edited"),
            ])
            book.save()
            loaded = Book.load(tmp)
            self.assertEqual(loaded.title, "My Book")
            self.assertEqual(loaded.first_page, 3)
            self.assertEqual(loaded.pages[0].lines[0], Line("hi", 1, 2, 3, 4, 0.5))
            self.assertIsNone(loaded.pages[1].lines)
            self.assertEqual([p.number for p in loaded.pages], [3, 9])
            self.assertEqual(loaded.next_image_name(), "page-0003.png")


class ExportTests(unittest.TestCase):
    def test_docx_sections_restart_at_book_numbers(self):
        book = Book(folder="/nonexistent", title="Exported", pages=[
            Page(image="a.png", width=1400, height=H, lines=body(["First page text."])),
            Page(image="b.png", width=1400, height=H, lines=[]),  # blank page
            Page(image="c.png", width=1400, height=H, lines=[
                Line("Chapter Two", 400, 200, 500, 80), *body(["Third page."]),
                Line("7", 600, 1900, 30, 40)]),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.docx")
            self.assertEqual(export_docx.export(book, path, "Book (6 × 9 in)"), 3)
            with zipfile.ZipFile(path) as z:
                xml = z.read("word/document.xml").decode()
                footers = [n for n in z.namelist() if n.startswith("word/footer")]
                footer_xml = "".join(z.read(n).decode() for n in footers)
        starts = [s for s in xml.split('w:pgNumType w:start="')[1:]]
        self.assertEqual([s.split('"')[0] for s in starts], ["1", "2", "7"])
        self.assertIn("PAGE", footer_xml)
        self.assertIn("Third page.", xml)
        self.assertIn("Chapter Two", xml)
        self.assertNotIn(">7<", xml)  # the printed number is not in the body text
        # pgNumType must come before w:cols in every section (schema order).
        for sect in xml.split("<w:sectPr")[1:]:
            self.assertLess(sect.index("pgNumType"), sect.index("<w:cols"))


class CaptureTests(unittest.TestCase):
    def test_find_and_flatten_page(self):
        frame = np.full((900, 1200, 3), 40, np.uint8)
        pts = np.array([[300, 120], [880, 160], [860, 800], [280, 760]], np.int32)
        import cv2
        cv2.fillConvexPoly(frame, pts, (235, 235, 235))
        corners = capture.find_page(frame)
        self.assertIsNotNone(corners)
        self.assertLess(np.abs(corners - pts).max(), 15)
        flat = capture.flatten(frame, corners)
        self.assertGreater(flat.mean(), 200)

    def test_split_spread_at_shadow(self):
        img = Image.new("L", (1000, 600), 230)
        ImageDraw.Draw(img).rectangle([540, 0, 560, 600], fill=90)
        left, right = capture.split_spread(img)
        self.assertTrue(530 <= left.width <= 570)
        self.assertEqual(left.width + right.width, 1000)
        even = Image.new("L", (1000, 600), 230)
        self.assertEqual(capture.split_spread(even)[0].width, 500)

    def test_page_watcher(self):
        w = capture.PageWatcher(still_seconds=1.0)
        a = np.zeros((120, 160, 3), np.uint8)
        b = np.full((120, 160, 3), 200, np.uint8)
        self.assertFalse(w.update(a, 0.0))
        self.assertFalse(w.update(a, 0.1))   # still, but nothing has moved yet
        self.assertFalse(w.update(b, 0.2))   # page turned
        self.assertFalse(w.update(b, 0.3))
        self.assertTrue(w.update(b, 1.4))    # held still for a second
        self.assertFalse(w.update(b, 3.0))   # only once per page turn


def _font(size):
    for path in ("/System/Library/Fonts/Supplemental/Times New Roman.ttf",
                 "/Library/Fonts/Arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def render_page(paragraphs, number, size=(1275, 1650)):
    img = Image.new("L", size, 255)
    draw = ImageDraw.Draw(img)
    font = _font(30)
    y = 160
    for para in paragraphs:
        for i, line in enumerate(textwrap.wrap(para, 62)):
            draw.text((150 + (45 if i == 0 else 0), y), line, font=font, fill=0)
            y += 44
    if number is not None:
        draw.text((size[0] // 2 - 10, size[1] - 110), str(number), font=font, fill=0)
    return img


@unittest.skipUnless(ocr.engines(), "no OCR engine installed")
class EndToEndTests(unittest.TestCase):
    PAGES = [
        (["The quick brown fox jumps over the lazy dog near the quiet river bank "
          "while the farmer watches from the hill."], 1),
        (["Morning came slowly over the valley and the mist lifted from the fields "
          "one by one as the sun climbed higher.",
          "Nobody in the village had seen anything like it before."], 2),
        (["This page has no printed number at the bottom."], None),
        (["Evening fell and the lamps were lit along the old harbour road."], 4),
    ]

    def test_scan_to_docx(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Book(folder=tmp, title="Test Book")
            for i, (paras, number) in enumerate(self.PAGES):
                img = render_page(paras, number)
                name = f"page-{i + 1:04d}.png"
                img.save(os.path.join(tmp, name))
                book.pages.append(Page(image=name, width=img.width, height=img.height,
                                       lines=ocr.recognize(img)))
            book.renumber()
            self.assertEqual([p.number for p in book.pages], [1, 2, 3, 4])
            self.assertEqual([p.number_source for p in book.pages],
                             [PRINTED, PRINTED, INFERRED, PRINTED])
            self.assertIn("quick brown fox", book.pages[0].text())
            self.assertEqual(len(book.pages[1].paragraphs()), 2)
            out = os.path.join(tmp, "book.docx")
            export_docx.export(book, out)
            with zipfile.ZipFile(out) as z:
                xml = z.read("word/document.xml").decode()
            self.assertIn("harbour road", xml)


if __name__ == "__main__":
    unittest.main()
