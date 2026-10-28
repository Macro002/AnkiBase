# AnkiBase for Android

The same app as [the iPhone one](../ios/): Anki's own engine on the phone, so decks,
studying, search, editing, stats and Anki's Deck Options all work offline, and it syncs with
AnkiWeb or your own sync server. Stories, AI and Quizlet come from your AnkiBase server, which
the app can also do without.

## Install

Download the `.apk` from the [latest release](https://github.com/Macro002/AnkiBase/releases/latest)
and open it on your phone (allow installs from your browser when Android asks). Later
releases install over it. Settings → Server → App tells you when there's a new one.

Android 8 or newer, 64-bit (arm64).

## How it fits together

The app's core is the Rust library in `../ios/engine` (shared with the iPhone app), built as
`libankibase_engine.so`. Android's WebView can't hand request bodies to the app, so the core
serves the web UI on `127.0.0.1` inside the app instead (`../ios/engine/src/httpd.rs`): a
random token per launch, exchanged for an HttpOnly cookie on the first load, keeps other apps
on the phone out. `src/io/github/ankibase/MainActivity.java` is the whole shell: an edge-to-edge
WebView that passes the system bars' sizes to the page, follows the theme's colours, picks
files for imports and opens links in the browser.

## Build

Needs the Android SDK (platform 35, build-tools 35, the NDK) in `ANDROID_HOME`, a JDK 17+,
Rust (rustup), Node, python3 and rsvg-convert. No Gradle:

```sh
scripts/build.sh   # → dist/AnkiBase-<version>-<code>.apk
```

Signing: put `ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` in
`local.env` (ignored by git). Without them the build makes a local debug key; Android only
installs an update signed with the same key as the installed app.

Releases come from `scripts/release.sh vX.Y.Z` (it tags, waits for `.github/workflows/release.yml`
to build this app into a draft, adds the iPhone app and publishes); give the workflow
the key as the repository secrets `ANDROID_KEYSTORE_BASE64` (`base64 -w0 release.keystore`),
`ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`.

## Develop without a phone

`../ios/engine/examples/emulate.rs` serves the same core over the same transport on a
computer (`--token` to require the token like the app does). The web UI acts as the Android
app when `window.AnkiBaseAndroid` exists.

## License

The core links Anki's Rust library (AGPL-3.0-or-later), so the app as a whole is distributed
under the AGPL; this repository is its source.
