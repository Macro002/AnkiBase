#!/usr/bin/env python3
"""Anki's own pages (Statistics, Deck Options, Card Info, Congrats) for the app.

Anki Desktop builds them as one SvelteKit app, shipped in the `aqt` wheel. This takes the
wheel matching the engine's Anki from PyPI (checksum verified), keeps the web files and
prepares them to be served at /anki-pages/ by the app's core, as anki-cli does on a server:
asset paths and backend calls under the prefix, the desktop window's hooks (bridge.js), and
a content security policy that allows exactly the page's own scripts.

    scripts/anki-pages.py OUT_DIR [--wheel aqt-….whl]
"""
import base64
import hashlib
import io
import json
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ANKI_VERSION = "26.9.3"  # engine/Cargo.toml's anki tag, as PyPI spells it
PREFIX = "/anki-pages"
WHEEL_PREFIX = "_aqt/data/web/sveltekit/"
INITIAL_SEARCH = b'initialSearch:"deck:current"'
SEARCH_FROM_URL = b'initialSearch:(new URLSearchParams(location.search).get("search")??"deck:current")'

# What Anki Desktop injects into its web views, and messages to the app's page around them
# (the same bridge as anki-cli's pages.py).
BRIDGE_JS = """\
(() => {
  const post = (event, detail) => {
    if (window.parent !== window) window.parent.postMessage({ source: "anki-cli", event, detail }, "*");
  };
  window.bridgeCommand = window.pycmd = (command, callback) => {
    post("bridgeCommand", command);
    if (callback) callback(null);
  };
  const theme = new URLSearchParams(location.search).get("theme");
  const night = theme ? theme === "dark"
    : location.hash === "#night" || matchMedia("(prefers-color-scheme: dark)").matches;
  if (night) document.documentElement.classList.add("night-mode");
  document.documentElement.dataset.bsTheme = night ? "dark" : "light";
  const style = document.createElement("style");
  style.textContent = `
    html { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
           -webkit-text-size-adjust: 100%; }
    html, body { background-color: var(--canvas); overscroll-behavior: none; }
    body { padding-bottom: env(safe-area-inset-bottom, 0px); }
    button { font-family: inherit; }
    :root { --canvas: #f5f5f5; }
    :root[class*=night-mode] { --canvas: #2c2c2c; }
    textarea:focus, input:focus, input[type]:focus { outline: 0 none; border-color: #3b82f6; }`;
  document.head.appendChild(style);
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add(/Mac|iPhone|iPad/.test(navigator.platform) ? "isMac" : "isLin", "fancy");
    if (night) document.body.classList.add("nightMode", "night_mode");
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = typeof input === "string" ? input : input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    if (response.ok && method === "updateDeckConfigs") post("deckOptionsSaved");
    if (method === "deckOptionsRequireClose") post("deckOptionsClose");
    if (method === "deckOptionsReady") post("deckOptionsReady");
    return response;
  };
})();
"""


def wheel_bytes() -> bytes:
    with urllib.request.urlopen(f"https://pypi.org/pypi/aqt/{ANKI_VERSION}/json", timeout=60) as response:
        release = json.load(response)
    wheel = next(f for f in release["urls"] if f["packagetype"] == "bdist_wheel")
    with urllib.request.urlopen(wheel["url"], timeout=300) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != wheel["digests"]["sha256"]:
        sys.exit("The aqt wheel doesn't match PyPI's checksum")
    return data


def main():
    out = Path(sys.argv[1])
    wheel = Path(sys.argv[sys.argv.index("--wheel") + 1]).read_bytes() if "--wheel" in sys.argv else wheel_bytes()
    archive = zipfile.ZipFile(io.BytesIO(wheel))
    staging = out.with_name(out.name + ".tmp")
    shutil.rmtree(staging, ignore_errors=True)
    for name in archive.namelist():
        if not name.startswith(WHEEL_PREFIX) or name.endswith("/"):
            continue
        relative = name[len(WHEEL_PREFIX):]
        if relative.startswith("/") or ".." in Path(relative).parts:
            continue
        body = archive.read(name)
        if relative.endswith(".mjs") and (b"`/_anki/" in body or INITIAL_SEARCH in body):
            body = body.replace(b"`/_anki/", f"`{PREFIX}/_anki/".encode()).replace(INITIAL_SEARCH, SEARCH_FROM_URL)
        path = staging / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    index = staging / "index.html"
    if not index.is_file():
        sys.exit("The wheel has no Anki pages")
    html = index.read_bytes()
    html = html.replace(b'"/_app/', f'"{PREFIX}/_app/'.encode())
    html = html.replace(b'href="/favicon.ico"', b'href="data:,"')
    html = html.replace(b'base: ""', b"base: " + json.dumps(PREFIX).encode())
    match = re.search(rb"<script>(.*?)</script>", html, re.S)
    script_hash = ""
    if match:
        script_hash = " 'sha256-" + base64.b64encode(hashlib.sha256(match.group(1)).digest()).decode() + "'"
    html = re.sub(rb'<meta http-equiv="content-security-policy" content="[^"]*">', b"", html)
    head = (f'<meta http-equiv="content-security-policy" content="script-src \'self\'{script_hash}">\n\t\t'
            f'<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">\n\t\t'
            f'<script src="{PREFIX}/_ankicli/bridge.js"></script>').encode()
    html = html.replace(b"<head>", b"<head>\n\t\t" + head, 1)
    index.write_bytes(html)
    (staging / "_ankicli").mkdir(exist_ok=True)
    (staging / "_ankicli" / "bridge.js").write_text(BRIDGE_JS)

    shutil.rmtree(out, ignore_errors=True)
    staging.rename(out)
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"Anki's pages ({ANKI_VERSION}): {out} ({size // 1024} KB)")


if __name__ == "__main__":
    main()
