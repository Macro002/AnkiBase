import sys
from playwright.sync_api import sync_playwright
V = sys.argv[1]; times = [float(x) for x in sys.argv[2].split(",")]; out = sys.argv[3]
with sync_playwright() as p:
    br = p.chromium.launch(); page = br.new_page(viewport={"width": 1920, "height": 1080})
    errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(f"file://{V}/composition.html"); page.evaluate("() => document.fonts.ready"); page.wait_for_function("() => [...document.images].every(i => i.complete)")
    for t in times:
        page.evaluate(f"render({t})"); page.screenshot(path=f"{out}/f_{t:05.1f}.jpg", quality=85)
    print("errors", errs)
