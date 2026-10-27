# AnkiBase for iPhone

AnkiBase as an iPhone app with **Anki's own engine on the phone**: your collection lives on
the device and everything Anki works offline. Internet is only needed to sync — with
AnkiWeb or your own sync server — and for what only an AnkiBase server can do.

| Part | Where it runs |
| --- | --- |
| Decks, studying (Anki's scheduler), undo, media, search, editing and adding notes, `.apkg` import, deck rename/delete, stats, Anki's Statistics / Deck Options / Card Info pages | On the phone |
| Sync, including media | Phone ↔ AnkiWeb, or your own sync server (Settings → Sync) |
| The web UI and Anki's pages | Bundled in the app, served at `ankibase://app/` |
| Stories, AI, Quizlet sets, dictionary, shared-deck links | Your AnkiBase server (optional; Settings → Server) |

Without a server the app works on its own ("Use on this iPhone only"): the profile and
study sessions are kept on the phone. With one, the server's answers are kept for offline
use, and study progress saved offline (sessions, Quizlet answers and favourites, card edits)
is queued and sent once the server is reachable again. The header shows *Offline* and how
many changes are waiting.

## How it fits together

- `engine/` (Rust) is the app's core. `app.rs` answers every request from the web view:
  the bundled UI and Anki's pages, Anki's API from the collection (`engine.rs`, `notes.rs`,
  `stats.rs`, `pages.rs` on Anki 26.09.3's `rslib`), merged answers where the phone and the
  server each have a part (search, stats), and the rest through `server.rs`, which keeps the
  server's login cookie and answers, and the queue of offline changes. Without a server it
  answers the profile and sessions itself (`sessions.rs`).
- `Sources/AnkiBase/` (Swift) is a thin shell: a full-screen `WKWebView` whose
  `AppSchemeHandler` hands each request to the core (C interface:
  `Sources/AnkiEngine/include/ankibase_engine.h`) and streams the reply back. It turns off
  zooming and rubber-banding, and follows the web UI's theme (`native.ts`): status bar,
  background and the home screen icon (one per built-in theme).

## Build

Builds on Linux with [xtool](https://github.com/xtool-org/xtool) and an iOS SDK
(`xtool sdk status`), Rust (rustup; `engine/rust-toolchain.toml` pins the version and
iPhone target), Node and rsvg-convert (for the app icon):

```sh
scripts/build.sh    # → dist/AnkiBase-<version>-<build>.ipa (unsigned; SideStore signs it)
```

The script cross-compiles the engine for `aarch64-apple-ios` with the SDK's headers,
builds `../frontend`, takes Anki's pages from the matching `aqt` wheel
(`scripts/anki-pages.py`), draws the theme icons (`scripts/icons.py`) and packages it all. Bump `CFBundleVersion` in
`Info.plist` for every build you hand out.

## Your build's settings

Copy `local.env.example` to `local.env` (ignored by git) to give your build its own bundle
identifier, the AnkiBase server new installs connect to, and a SideStore/AltStore source to
check for updates. Without it the app starts on its own and you connect a server in
Settings → Server.

## Publish

```sh
scripts/publish.py "What changed"   # after build.sh; bump CFBundleVersion first
```

Uploads the .ipa over SSH to `PUBLISH_SSH_HOST:PUBLISH_DIR` (from `local.env`) and lists it
in the SideStore/AltStore sources there: `ankibase-source.json` (AnkiBase only), and merged
into `source.json` if you share one with other apps.

## Develop without a phone

`engine/examples/emulate.rs` is the app on a computer: the same core, over HTTP. With
`--sync-server`, Anki's own sync server stands in for AnkiWeb:

```sh
scripts/anki-pages.py .build/anki-pages
cd engine
cargo run --example emulate -- --web ../../frontend/dist --pages ../.build/anki-pages \
    --dir /tmp/phone --sync-server /tmp/syncsrv [--server http://127.0.0.1:8000]
# open http://127.0.0.1:8800/ at phone size; sync login: user@example.com / secret
```

The web UI acts as the app when `window.ankibaseNative` is set (inject it in the browser).

`cargo test` covers two devices syncing through login, upload, download, studying, undo,
media and stats; search, note edits, deck rename/delete and `.apkg` import; Anki's pages;
and a stand-in AnkiBase server going offline, hanging and coming back (kept answers, the
offline queue, logins), plus the app without any server.

## License

`engine/` links Anki's Rust library, which is AGPL-3.0-or-later, so the app as a whole
is distributed under the AGPL (this repository is its source).
