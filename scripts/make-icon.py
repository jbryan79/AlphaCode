"""Render public/icon.ico from the same ">_" mark as public/icon.svg.

Run after changing the mark:  python scripts/make-icon.py
Requires Pillow (pip install pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 4  # supersample factor, drawn at 1024 then downscaled
BG, BORDER, INK = "#1b1f24", "#4b5968", "#c0d1e2"


def px(v):
    return v * S


img = Image.new("RGBA", (px(256), px(256)), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([px(8), px(8), px(248), px(248)], radius=px(48), fill=BG, outline=BORDER, width=px(8))


def stroke(points, width=px(24)):
    d.line(points, fill=INK, width=width, joint="curve")
    r = width // 2
    for x, y in (points[0], points[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=INK)


stroke([(px(64), px(80)), (px(120), px(128)), (px(64), px(176))])
stroke([(px(136), px(176)), (px(200), px(176))])

base = img.resize((256, 256), Image.LANCZOS)
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
out = ROOT / "public" / "icon.ico"
base.save(out, format="ICO", sizes=sizes)
print("wrote", out, out.stat().st_size, "bytes")
