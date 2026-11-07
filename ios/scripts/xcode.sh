#!/usr/bin/env bash
# AnkiBase.xcodeproj on a Mac, to build and debug the app on your iPhone from Xcode (not the
# Simulator: the engine is built for iPhones only). Needs Xcode, XcodeGen, Rust (rustup),
# Node, protoc and rsvg-convert (brew install xcodegen protobuf librsvg).
#
#   scripts/xcode.sh           prepare everything, generate the project and open it
#   scripts/xcode.sh prepare   what Xcode runs before every build (the scheme's pre-action):
#                              the engine, the web UI, Anki's pages, the icons and
#                              local.env's bundle id and team
#
# The project comes from project.yml and isn't kept in git: run this again after changing it.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v npm >/dev/null && [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u; . "$HOME/.nvm/nvm.sh"; set -u
fi
if [ -f local.env ]; then set -a; . ./local.env; set +a; fi
out=.build/xcode
mkdir -p "$out"

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null || { echo "error: $tool not found (see scripts/xcode.sh)" >&2; exit 1; }
  done
}

# Copy a directory's contents, leaving unchanged files alone so Xcode copies only what changed.
sync() { mkdir -p "$2" && rsync -a --delete --checksum "$1/" "$2/"; }

prepare() {
  need cargo npm protoc rsvg-convert python3 rsync
  export PROTOC="${PROTOC:-$(command -v protoc)}"

  echo "== Anki engine for iPhone"
  # Only when engine/ changed: cargo alone would rebuild Anki every time (anki_proto's build
  # script marks the files it writes as its inputs), adding a minute to every build.
  lib=engine/target/aarch64-apple-ios/release/libankibase_engine.a
  if [ -f "$lib" ] && [ -z "$(find engine/src engine/Cargo.toml engine/Cargo.lock engine/rust-toolchain.toml -newer "$lib" | head -1)" ]; then
    echo "up to date"
  else
    # Xcode's own settings would point C builds for this Mac at the iPhone SDK.
    (cd engine && env -u SDKROOT IPHONEOS_DEPLOYMENT_TARGET=17.0 \
      cargo rustc --release --target aarch64-apple-ios --lib --crate-type staticlib)
  fi

  echo "== App icons (the logo on each theme's colours)"
  python3 scripts/icons.py svg .build/icons
  for svg in .build/icons/*.svg; do
    png="${svg%.svg}.png"
    [ "$png" -nt "$svg" ] || rsvg-convert -w 1024 -h 1024 "$svg" -o "$png"
  done
  python3 scripts/icons.py xcassets "$out/Assets.xcassets" .build/icons
  mkdir -p Sources/AnkiBase/Resources
  cmp -s .build/icons/AnkiBase.png Sources/AnkiBase/Resources/AppIcon.png ||
    cp .build/icons/AnkiBase.png Sources/AnkiBase/Resources/AppIcon.png

  echo "== Anki's own pages (Statistics, Deck Options…)"
  [ -f .build/anki-pages/index.html ] || python3 scripts/anki-pages.py .build/anki-pages
  sync .build/anki-pages Sources/AnkiBase/Resources/pages

  echo "== Web UI"
  [ -d ../frontend/node_modules ] || (cd ../frontend && npm ci)
  (cd ../frontend && npm run build)
  sync ../frontend/dist Sources/AnkiBase/Resources/web

  echo "== This build's settings (local.env)"
  {
    echo "// Made by scripts/xcode.sh from local.env."
    echo "PRODUCT_BUNDLE_IDENTIFIER = ${ANKIBASE_BUNDLE_ID:-io.github.ankibase}"
    [ -z "${ANKIBASE_TEAM_ID:-}" ] || echo "DEVELOPMENT_TEAM = $ANKIBASE_TEAM_ID"
  } > "$out/Local.xcconfig.new"
  if cmp -s "$out/Local.xcconfig.new" "$out/Local.xcconfig"; then
    rm "$out/Local.xcconfig.new"
  else
    mv "$out/Local.xcconfig.new" "$out/Local.xcconfig"
  fi
  cat "$out/Local.xcconfig"
}

case "${1:-}" in
  prepare)
    prepare
    ;;
  "")
    need xcodegen
    prepare
    echo "== Xcode project"
    xcodegen generate --spec project.yml
    open AnkiBase.xcodeproj
    ;;
  *)
    sed -n '2,12s/^# \{0,1\}//p' "$0" >&2
    exit 2
    ;;
esac
