#!/usr/bin/env bash
# Put together what the desktop apps bundle: the web UI and Anki's pages (resources/), and
# the app icons (icons/). Then `npx @tauri-apps/cli@2.12.3 build` in desktop/ builds the
# installer for the computer it runs on (the release workflow does this on each OS).
#
# Needs: Node, python3 and rsvg-convert.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf resources icons .build/icons && mkdir -p resources .build

echo "== Web UI and Anki's pages"
(cd ../frontend && npm run build)
cp -R ../frontend/dist resources/web
[ -f ../ios/.build/anki-pages/index.html ] || python3 ../ios/scripts/anki-pages.py ../ios/.build/anki-pages
cp -R ../ios/.build/anki-pages resources/pages

echo "== Icons"
python3 ../ios/scripts/icons.py svg .build/icons
rsvg-convert -w 1024 -h 1024 .build/icons/AnkiBase.svg -o .build/icon.png
npx --yes @tauri-apps/cli@2.12.3 icon .build/icon.png -o icons
