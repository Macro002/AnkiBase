#!/usr/bin/env bash
# Build AnkiBase.ipa on Linux: Anki's engine (Rust) for iPhone, the web UI, then the app
# with xtool and the iOS SDK (`xtool sdk status`). The .ipa lands in dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
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
(cd engine && cargo build --release --target aarch64-apple-ios)

echo "== App icon (the logo on AnkiBase's navy)"
python3 - <<'PY' > .build/icon.svg
import re
logo = open("../frontend/public/logo.svg").read()
paths = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", logo.strip())
print('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
      '<rect width="1024" height="1024" fill="#16213e"/>'
      f'<g transform="translate(192 192) scale({640 / 24})" fill="#e94560">{paths}</g></svg>')
PY
rsvg-convert -w 1024 -h 1024 .build/icon.svg -o Sources/AnkiBase/Resources/AppIcon.png

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
ls -la "dist/AnkiBase-$version-$build.ipa"
