"""Tests for bgremove. The model test is skipped unless rembg is installed."""

import os
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bgremove  # noqa: E402


def sample() -> Image.Image:
    img = Image.new("RGB", (320, 240), (70, 140, 220))
    ImageDraw.Draw(img).ellipse((100, 50, 220, 190), fill=(230, 60, 40))
    return img


class Helpers(unittest.TestCase):
    def test_default_output_path(self):
        src = os.path.join(os.path.abspath(os.sep), "a", "b", "cat.jpg")
        self.assertEqual(bgremove.default_output_path(src),
                         os.path.join(os.path.dirname(src), "cat_nobg.png"))
        out = os.path.join(os.path.abspath(os.sep), "out")
        self.assertEqual(bgremove.default_output_path("cat.jpg", out),
                         os.path.join(out, "cat_nobg.png"))

    def test_crop_to_subject(self):
        img = Image.new("RGBA", (100, 80), (0, 0, 0, 0))
        img.paste((255, 0, 0, 255), (20, 10, 50, 40))
        self.assertEqual(bgremove.crop_to_subject(img).size, (30, 30))
        self.assertEqual(bgremove.crop_to_subject(img, margin=5).size, (40, 40))
        empty = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
        self.assertEqual(bgremove.crop_to_subject(empty).size, (10, 10))

    def test_save_png_adds_extension(self):
        with tempfile.TemporaryDirectory() as d:
            path = bgremove.save_png(Image.new("RGBA", (4, 4)), os.path.join(d, "out"))
            self.assertTrue(path.endswith(".png"))
            with Image.open(path) as saved:  # closed, so Windows can delete the folder
                self.assertEqual(saved.mode, "RGBA")

    def test_load_image_converts_palette(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.gif")
            sample().convert("P").save(p)
            self.assertIn(bgremove.load_image(p).mode, ("RGB", "RGBA"))


@unittest.skipUnless(__import__("importlib").util.find_spec("rembg"), "rembg not installed")
class Removal(unittest.TestCase):
    def test_background_becomes_transparent(self):
        out = bgremove.remove_background(sample())
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.size, (320, 240))
        self.assertLess(out.getpixel((5, 5))[3], 20)        # background corner
        self.assertGreater(out.getpixel((160, 120))[3], 235)  # subject centre

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.jpg")
            sample().save(src)
            self.assertEqual(bgremove.main([src, "--crop"]), 0)
            with Image.open(os.path.join(d, "in_nobg.png")) as out:
                self.assertEqual(out.mode, "RGBA")
                self.assertLess(out.width, 320)


if __name__ == "__main__":
    unittest.main()
