"""The README's video poster: a still of the demo with a play button (an animated preview
compresses badly on GitHub).   python3 poster.py . 9.5 media/demo-poster.webp"""
import sys
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
V, T, OUT = sys.argv[1], float(sys.argv[2]), sys.argv[3]
with sync_playwright() as p:
    br = p.chromium.launch(); page = br.new_page(viewport={"width": 1920, "height": 1080})
    page.goto(f"file://{V}/composition.html"); page.evaluate("() => document.fonts.ready")
    page.wait_for_function("() => [...document.images].every(i => i.complete)")
    page.evaluate(f"render({T})"); page.screenshot(path="/tmp/poster.png"); br.close()
im = Image.open("/tmp/poster.png").convert("RGBA")
over = Image.new("RGBA", im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(over)
cx, cy, r = im.width // 2, im.height // 2, 78
d.ellipse((cx - r - 10, cy - r - 10, cx + r + 10, cy + r + 10), fill=(0, 0, 0, 70))
d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(233, 69, 96, 235))
d.polygon([(cx - 24, cy - 36), (cx - 24, cy + 36), (cx + 40, cy)], fill=(255, 255, 255, 255))
Image.alpha_composite(im, over).convert("RGB").save(OUT, "WEBP", quality=90, method=6)
print(OUT, im.size)
