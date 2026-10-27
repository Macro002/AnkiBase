#!/usr/bin/env bash
# Build AnkiBase.apk: the app's core (../ios/engine, Rust) for Android, the web UI, Anki's
# own pages, then a small Java shell packaged and signed with the Android SDK's tools (no
# Gradle). The .apk lands in dist/.
#
# Needs: the Android SDK with build-tools 35, platform 35 and the NDK (ANDROID_HOME), a JDK
# 17+, Rust (rustup), Node, python3 and rsvg-convert.
# Signing: ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS (local.env or
# the environment); without them a local debug key is made in .build/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
if [ -f local.env ]; then set -a; . ./local.env; set +a; fi
export PATH="$HOME/.cargo/bin:$PATH"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}
BUILD_TOOLS=$(ls -d "$SDK"/build-tools/35* | sort -V | tail -1)
PLATFORM="$SDK/platforms/android-35/android.jar"
NDK=${ANDROID_NDK_HOME:-$(ls -d "$SDK"/ndk/* | sort -V | tail -1)}
[ -f "$PLATFORM" ] && [ -d "$BUILD_TOOLS" ] && [ -d "$NDK" ] || { echo "Android SDK pieces missing in $SDK"; exit 1; }
. ./version.properties
OUT=.build/apk
rm -rf "$OUT" && mkdir -p "$OUT"/{res,assets,lib/arm64-v8a,classes,compiled} dist

echo "== The core (Rust) for Android"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android26-clang"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/aarch64-linux-android26-clang"
if [ -z "${PROTOC:-}" ]; then
  export PROTOC="$ROOT/../ios/.build/protoc/bin/protoc"
  if [ ! -x "$PROTOC" ]; then
    mkdir -p ../ios/.build/protoc
    curl -sSLo ../ios/.build/protoc.zip https://github.com/protocolbuffers/protobuf/releases/download/v31.1/protoc-31.1-linux-x86_64.zip
    echo "96553041f1a91ea0efee963cb16f462f5985b4d65365f3907414c360044d8065  ../ios/.build/protoc.zip" | sha256sum -c --quiet
    python3 -c "import zipfile; zipfile.ZipFile('../ios/.build/protoc.zip').extractall('../ios/.build/protoc')"
    chmod +x "$PROTOC"
  fi
fi
(cd ../ios/engine && cargo rustc --release --target aarch64-linux-android --lib --crate-type cdylib)
"$TOOLCHAIN/llvm-strip" -o "$OUT/lib/arm64-v8a/libankibase_engine.so" ../ios/engine/target/aarch64-linux-android/release/libankibase_engine.so

echo "== Web UI and Anki's pages"
(cd ../frontend && npm run build)
cp -R ../frontend/dist "$OUT/assets/web"
[ -f ../ios/.build/anki-pages/index.html ] || python3 ../ios/scripts/anki-pages.py ../ios/.build/anki-pages
cp -R ../ios/.build/anki-pages "$OUT/assets/pages"

echo "== Resources and icon"
cp -R res/. "$OUT/res/"
python3 ../ios/scripts/icons.py svg .build/icons
for size in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  mkdir -p "$OUT/res/mipmap-${size%%:*}"
  rsvg-convert -w "${size##*:}" -h "${size##*:}" .build/icons/AnkiBase.svg -o "$OUT/res/mipmap-${size%%:*}/ic_launcher.png"
done
xml() { python3 -c 'import sys,html; print(html.escape(sys.argv[1]))' "$1"; }
cat > "$OUT/res/values/config.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="default_server" translatable="false">$(xml "${ANKIBASE_SERVER:-}")</string>
    <string name="update_feed" translatable="false">$(xml "${ANDROID_UPDATE_FEED:-https://api.github.com/repos/Macro002/AnkiBase/releases/latest}")</string>
</resources>
XML

echo "== Java"
"$BUILD_TOOLS/aapt2" compile --dir "$OUT/res" -o "$OUT/compiled/res.zip"
"$BUILD_TOOLS/aapt2" link -o "$OUT/unsigned.apk" -I "$PLATFORM" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 35 --version-code "$versionCode" --version-name "$versionName" \
  --java "$OUT/gen" -A "$OUT/assets" "$OUT/compiled/res.zip"
javac --release 11 -nowarn -d "$OUT/classes" -classpath "$PLATFORM" \
  $(find src "$OUT/gen" -name '*.java')
"$BUILD_TOOLS/d8" --release --min-api 26 --lib "$PLATFORM" --output "$OUT" $(find "$OUT/classes" -name '*.class')
(cd "$OUT" && zip -q -u unsigned.apk classes.dex lib/arm64-v8a/libankibase_engine.so)
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== Signing"
if [ -z "${ANDROID_KEYSTORE:-}" ]; then
  ANDROID_KEYSTORE=.build/debug.keystore ANDROID_KEYSTORE_PASSWORD=android ANDROID_KEY_ALIAS=ankibase
  [ -f "$ANDROID_KEYSTORE" ] || keytool -genkeypair -keystore "$ANDROID_KEYSTORE" -storepass android -keypass android \
    -alias ankibase -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=AnkiBase debug" >/dev/null 2>&1
  echo "(debug key: set ANDROID_KEYSTORE in local.env for releases; installs from different keys can't update each other)"
fi
APK="dist/AnkiBase-$versionName-$versionCode.apk"
"$BUILD_TOOLS/apksigner" sign --ks "$ANDROID_KEYSTORE" --ks-pass "pass:$ANDROID_KEYSTORE_PASSWORD" \
  --ks-key-alias "${ANDROID_KEY_ALIAS:-ankibase}" --out "$APK" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify "$APK"
ls -la "$APK"
