#!/usr/bin/env bash
# Build AnkiBase.ipa on Linux: Anki's engine (Rust) for iPhone, the web UI, then the app
# with xtool and the iOS SDK (`xtool sdk status`). The .ipa lands in dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
# This build's own settings: bundle id, default server, update feed (see local.env.example).
if [ -f local.env ]; then set -a; . ./local.env; set +a; fi
export PATH="$HOME/.local/bin:$HOME/.local/share/swiftly/bin:$HOME/.cargo/bin:$PATH"
command -v xtool >/dev/null && command -v cargo >/dev/null && command -v npm >/dev/null && command -v rsvg-convert >/dev/null
mkdir -p .build

bundle="$HOME/.swiftpm/swift-sdks/darwin.artifactbundle"
sdk=$(ls -d "$bundle"/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS[0-9]*.sdk | tail -1)
toolchain=$(dirname "$(command -v clang)")

# protoc for Anki's protobuf definitions: the release Anki pins, checksum verified.
if [ -z "${PROTOC:-}" ]; then
  export PROTOC="$PWD/.build/protoc/bin/protoc"
  if [ ! -x "$PROTOC" ]; then
    mkdir -p .build/protoc
    curl -sSLo .build/protoc.zip https://github.com/protocolbuffers/protobuf/releases/download/v31.1/protoc-31.1-linux-x86_64.zip
    echo "96553041f1a91ea0efee963cb16f462f5985b4d65365f3907414c360044d8065  .build/protoc.zip" | sha256sum -c --quiet
    python3 -c "import zipfile; zipfile.ZipFile('.build/protoc.zip').extractall('.build/protoc')"
    chmod +x "$PROTOC"
  fi
fi

echo "== Anki engine for iPhone"
export SDKROOT="$sdk" IPHONEOS_DEPLOYMENT_TARGET=17.0
export CC_aarch64_apple_ios="$toolchain/clang" AR_aarch64_apple_ios="$toolchain/llvm-ar"
export CFLAGS_aarch64_apple_ios="--target=arm64-apple-ios17.0 -isysroot $sdk"
(cd engine && cargo rustc --release --target aarch64-apple-ios --lib --crate-type staticlib)

echo "== App icons (the logo on each theme's colours)"
python3 scripts/icons.py svg .build/icons
for svg in .build/icons/*.svg; do
  name="${svg%.svg}"
  rsvg-convert -w 1024 -h 1024 "$svg" -o "$name.png"
  rsvg-convert -w 120 -h 120 "$svg" -o "$name@2x.png"
  rsvg-convert -w 180 -h 180 "$svg" -o "$name@3x.png"
done
cp .build/icons/AnkiBase.png Sources/AnkiBase/Resources/AppIcon.png

echo "== Anki's own pages (Statistics, Deck Options…)"
[ -f .build/anki-pages/index.html ] || python3 scripts/anki-pages.py .build/anki-pages
rm -rf Sources/AnkiBase/Resources/pages
cp -R .build/anki-pages Sources/AnkiBase/Resources/pages

echo "== Web UI"
(cd ../frontend && npm run build)
rm -rf Sources/AnkiBase/Resources/web
cp -R ../frontend/dist Sources/AnkiBase/Resources/web

echo "== App"
xtool dev build --configuration release --ipa
version=$(plutil -extract CFBundleShortVersionString raw Info.plist 2>/dev/null || sed -n 's:.*<key>CFBundleShortVersionString</key><string>\(.*\)</string>.*:\1:p' Info.plist)
build=$(sed -n 's:.*<key>CFBundleVersion</key><string>\(.*\)</string>.*:\1:p' Info.plist)
mkdir -p dist
cp xtool/AnkiBase.ipa "dist/AnkiBase-$version-$build.ipa"
# The same app without this build's own settings, for GitHub releases: anyone's Apple ID
# can sign it, it starts without a server and checks GitHub for updates.
mkdir -p dist/release
cp xtool/AnkiBase.ipa "dist/release/AnkiBase-v$version.ipa"
env -u ANKIBASE_BUNDLE_ID -u ANKIBASE_SERVER \
  ANKIBASE_UPDATE_FEED=https://api.github.com/repos/Macro002/AnkiBase/releases/latest \
  python3 scripts/icons.py ipa "dist/release/AnkiBase-v$version.ipa" .build/icons
python3 scripts/icons.py ipa "dist/AnkiBase-$version-$build.ipa" .build/icons
ls -la "dist/AnkiBase-$version-$build.ipa" "dist/release/AnkiBase-v$version.ipa"
