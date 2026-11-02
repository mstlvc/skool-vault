"""Draws the app icon (archive box on an ink tile) -> build/icon.png + build/icon.ico.

Same geometry as the in-app VaultMark SVG (20x20 grid). Run: python scripts/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

INK = (30, 42, 56, 255)  # #1e2a38
PAPER = (247, 248, 249, 255)  # #f7f8f9
OUT = Path(__file__).resolve().parent.parent / "build"

SIZE = 1024
SS = 4  # supersample for smooth edges
W = SIZE * SS
S = 560 / 15 * SS  # 15 grid units (box width) -> 560 px
CX, CY = 10, 9.75  # box centre in grid units
STROKE = 1.7 * S


def p(x, y):
    return (W / 2 + (x - CX) * S, W / 2 + (y - CY) * S)


def box(x0, y0, x1, y1):
    a, b = p(x0, y0), p(x1, y1)
    return [a[0], a[1], b[0], b[1]]


img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=W * 0.22, fill=INK)  # tile

w = round(STROKE)
# body (its top edge hides under the lid)
d.rounded_rectangle(box(3.75, 6, 16.25, 16.5), radius=1 * S, outline=PAPER, width=w)
# lid, filled with ink so it covers the body's top edge
d.rounded_rectangle(box(2.5, 3, 17.5, 7), radius=0.75 * S, fill=INK, outline=PAPER, width=w)
# label slot with round caps
(x0, y), (x1, _) = p(8, 10.25), p(12, 10.25)
d.line([x0, y, x1, y], fill=PAPER, width=w)
r = w / 2
for x in (x0, x1):
    d.ellipse([x - r, y - r, x + r, y + r], fill=PAPER)

icon = img.resize((SIZE, SIZE), Image.LANCZOS)
OUT.mkdir(exist_ok=True)
icon.save(OUT / "icon.png")
icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", OUT / "icon.png", "and", OUT / "icon.ico")
