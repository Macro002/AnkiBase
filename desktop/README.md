# AnkiBase for Windows, macOS and Linux

The same app as on the phones: the app's core ([`../ios/engine`](../ios/engine), with Anki's own
engine) serves the web UI on `127.0.0.1` behind a random token, like the Android app, and
[Tauri](https://tauri.app) shows it in a native window (WebView2 on Windows, WebKit on macOS
and Linux). Decks, studying, search, editing, imports and stats work offline; a server adds
stories, AI and Quizlet.

The release workflow builds the installers on each OS: a Windows setup `.exe`, a universal
macOS `.dmg` and a Linux `.AppImage`. They aren't code-signed (that needs paid certificates),
so the first launch needs one extra click.

## Building yourself

You need Rust, Node, python3, `rsvg-convert` and `protoc` (plus WebKitGTK on Linux, see
[Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/)). On the computer you
build for:

```bash
scripts/prepare.sh                          # web UI, Anki's pages, icons
npx @tauri-apps/cli@2.12.3 build            # the installer, in target/release/bundle/
```

Updates: the app checks GitHub's latest release and offers its installer in Settings → Server.
