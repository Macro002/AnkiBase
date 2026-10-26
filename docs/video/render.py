import sys, subprocess, time
from playwright.sync_api import sync_playwright
V = sys.argv[1]; FPS = int(sys.argv[2]); OUT = sys.argv[3]
with sync_playwright() as p:
    br = p.chromium.launch(); page = br.new_page(viewport={"width": 1920, "height": 1080})
    page.goto(f"file://{V}/composition.html"); page.evaluate("() => document.fonts.ready"); page.wait_for_function("() => [...document.images].every(i => i.complete)")
    total = page.evaluate("TOTAL"); n = int(total * FPS)
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                           "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT], stdin=subprocess.PIPE)
    t0 = time.time()
    for i in range(n):
        page.evaluate(f"render({i / FPS})")
        ff.stdin.write(page.screenshot(type="jpeg", quality=95))
        if i % 300 == 0: print(f"{i}/{n} {time.time() - t0:.0f}s", flush=True)
    ff.stdin.close(); ff.wait(); br.close()
print("done", n, "frames")
