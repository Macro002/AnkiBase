import sys
from PIL import Image
from playwright.sync_api import sync_playwright
V = sys.argv[1]; O = f"{V}/media"
FRAMED = [("study", "/anki/Français::Vocabulaire"), ("decks", ""), ("quizlet-learn", "/quizlet/Au café"), ("quizlet-match", "/quizlet/Expressions"),
          ("story", "/story"), ("reading", "/reading/Un dimanche au marché"), ("search", "/search"), ("stats", "/stats"), ("settings", "/settings"), ("study-hub", "/study")]
jobs = [("hero", "b=hero", False), ("themes", "b=themes", False), ("phones", "b=phones", False), ("architecture", "b=arch", False)]
jobs += [(f"shot-{n}", f"b=framed&img={n}&url={u}", True) for n, u in FRAMED]
with sync_playwright() as p:
    br = p.chromium.launch(); page = br.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=2)
    for name, qs, transparent in jobs:
        page.goto(f"file://{V}/media.html?{qs}"); page.evaluate("() => document.fonts.ready")
        page.wait_for_function("() => [...document.images].every(i => i.complete)"); page.wait_for_timeout(150)
        el = page.locator(".board:visible").first
        png = f"{O}/{name}.png"; el.screenshot(path=png, omit_background=transparent)
        im = Image.open(png)
        if name == "shot-stats":  # very tall: keep the top part
            im = im.crop((0, 0, im.width, int(im.width * 1.05)))
        # Full 2x: GitHub shows README images ~900 px wide, so 2x stays sharp on any screen.
        im.save(f"{O}/{name}.webp", "WEBP", quality=92, method=6)
        if name == "hero": im.convert("RGB").save(f"{O}/social-preview.png", optimize=True)
        print(name, im.size)
    br.close()
