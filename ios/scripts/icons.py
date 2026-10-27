#!/usr/bin/env python3
"""The app's icons: AnkiBase's logo on each built-in theme's colours (the first is the
default icon; the others are the alternate icons the app switches to with the theme).

    scripts/icons.py svg OUT_DIR       writes <Name>.svg for every theme
    scripts/icons.py ipa IPA ICON_DIR  adds the PNGs (from rsvg-convert) to the .ipa's app
                                       and lists them in its Info.plist, with this build's
                                       settings from the environment (local.env):
                                       ANKIBASE_BUNDLE_ID, ANKIBASE_SERVER, ANKIBASE_UPDATE_FEED
"""
import os
import plistlib
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# name: (accent, header colour) — frontend/src/pages/Settings.tsx BUILTIN_THEMES, and
# native.ts ICONS, which picks the icon for the colours in use.
THEMES = {
    "AnkiBase": ("#e94560", "#16213e"),
    "Midnight": ("#a855f7", "#141414"),
    "Chalk": ("#06b6d4", "#ffffff"),
    "Nord": ("#88c0d0", "#3b4252"),
    "Starlake": ("#cba6f7", "#181825"),
    "Sakura": ("#f4a7c3", "#f8eef2"),
    "Ocean": ("#0ea5e9", "#051828"),
    "Claude": ("#c4704f", "#292524"),
    "Phantom": ("#10b981", "#0f0f22"),
}
SIZES = {"": 1024, "@2x": 120, "@3x": 180}


def svgs(out: Path):
    logo = (ROOT.parent / "frontend/public/logo.svg").read_text()
    paths = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", logo.strip())
    out.mkdir(parents=True, exist_ok=True)
    for name, (accent, background) in THEMES.items():
        (out / f"{name}.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<rect width="1024" height="1024" fill="{background}"/>'
            f'<g transform="translate(192 192) scale({640 / 24})" fill="{accent}">{paths}</g></svg>')


def ipa(path: Path, icons: Path):
    with zipfile.ZipFile(path) as archive:
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]
    plist_name = next(i.filename for i, _ in entries if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", i.filename))
    app = plist_name.removesuffix("Info.plist")
    added = {}
    alternates = {}
    for name in THEMES:
        if name == "AnkiBase":
            continue
        for suffix in SIZES:
            added[f"{app}Icon-{name}{suffix}.png"] = (icons / f"{name}{suffix}.png").read_bytes()
        alternates[name] = {"CFBundleIconFiles": [f"Icon-{name}"], "UIPrerenderedIcon": False}
    info = plistlib.loads(next(data for i, data in entries if i.filename == plist_name))
    # This build's own settings (scripts/build.sh reads them from local.env).
    for env, key in (("ANKIBASE_BUNDLE_ID", "CFBundleIdentifier"), ("ANKIBASE_SERVER", "AnkiBaseServer"),
                     ("ANKIBASE_UPDATE_FEED", "AnkiBaseUpdateFeed")):
        if os.environ.get(env):
            info[key] = os.environ[env]
    info["CFBundleIcons"] = {
        "CFBundlePrimaryIcon": {"CFBundleIconFiles": [info.get("CFBundleIconFile", "AppIcon")], "UIPrerenderedIcon": False},
        "CFBundleAlternateIcons": alternates,
    }
    temporary = path.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for entry, data in entries:
            if entry.filename in added:
                continue
            archive.writestr(entry, plistlib.dumps(info) if entry.filename == plist_name else data)
        for name, data in added.items():
            archive.writestr(name, data)
    temporary.replace(path)
    print(f"{len(alternates)} alternate icons added to {path.name} ({info['CFBundleIdentifier']})")


if __name__ == "__main__":
    if sys.argv[1] == "svg":
        svgs(Path(sys.argv[2]))
    else:
        ipa(Path(sys.argv[2]), Path(sys.argv[3]))
