"""Images for the fictional demo community used in tests and README screenshots.

Usage: python scripts/demo-images.py <community folder>   (writes into <folder>/media)
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1]) / "media"
OUT.mkdir(parents=True, exist_ok=True)
FONTS = Path("C:/Windows/Fonts")


def font(size, bold=False):
    for name in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(str(FONTS / name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def cover(name, title, label, bg, fg=(255, 255, 255), size=(1280, 720)):
    w, h = size
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    # a quiet frame-line motif: film framing marks in the corners
    m, L = 56, 70
    for x, y, dx, dy in [(m, m, 1, 1), (w - m, m, -1, 1), (m, h - m, 1, -1), (w - m, h - m, -1, -1)]:
        d.line([(x, y), (x + dx * L, y)], fill=fg, width=5)
        d.line([(x, y), (x, y + dy * L)], fill=fg, width=5)
    d.text((w / 2, h / 2 - 20), title, font=font(92, True), fill=fg, anchor="mm")
    d.text((w / 2, h / 2 + 70), label, font=font(38), fill=fg, anchor="mm")
    im.save(OUT / name, quality=90)


def avatar(name, initials, bg):
    s = 192
    im = Image.new("RGB", (s, s), bg)
    d = ImageDraw.Draw(im)
    d.text((s / 2, s / 2), initials, font=font(80, True), fill=(255, 255, 255), anchor="mm")
    im.save(OUT / name, quality=92)


def scene(name, sky, ground, sun, size=(1600, 900)):
    """A simple landscape-like still: two bands and a disc."""
    w, h = size
    im = Image.new("RGB", size, sky)
    d = ImageDraw.Draw(im)
    d.rectangle([0, int(h * 0.62), w, h], fill=ground)
    r = int(h * 0.13)
    cx, cy = int(w * 0.68), int(h * 0.42)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=sun)
    d.polygon([(0, int(h * 0.62)), (int(w * 0.3), int(h * 0.38)), (int(w * 0.55), int(h * 0.62))], fill=ground)
    im.save(OUT / name, quality=90)


cover("cover-start.jpg", "Getting Started", "Course 1", (47, 72, 88))
cover("cover-light.jpg", "Lighting on a Budget", "Course 2", (156, 74, 59))
cover("cover-edit.jpg", "Editing Fundamentals", "Course 3", (94, 125, 90))
cover("cover-color.jpg", "Color Grading", "Course 4", (91, 75, 110))
cover("group.jpg", "Frame & Light", "A community for small-crew filmmakers", (38, 50, 62), size=(1280, 640))
cover("frame-welcome.png", "Welcome to Frame & Light", "Lesson 1", (47, 72, 88), size=(1920, 1080))

logo = Image.new("RGB", (256, 256), (38, 50, 62))
d = ImageDraw.Draw(logo)
d.rectangle([64, 84, 192, 172], outline=(247, 248, 249), width=12)
d.ellipse([108, 108, 148, 148], outline=(247, 248, 249), width=10)
logo.save(OUT / "logo.png")

for i, (ini, col) in enumerate(
    [("MO", (47, 107, 128)), ("TK", (156, 74, 59)), ("PR", (94, 125, 90)), ("SA", (91, 75, 110)), ("JL", (120, 98, 66)), ("NB", (60, 90, 140))]
):
    avatar(f"av{i}.jpg", ini, col)

scene("still-dusk.jpg", (58, 76, 110), (34, 40, 52), (232, 150, 96))
scene("still-noon.jpg", (150, 190, 214), (86, 120, 84), (250, 246, 230))
scene("still-night.jpg", (24, 30, 46), (14, 18, 26), (210, 214, 230))
print("demo images written to", OUT)
