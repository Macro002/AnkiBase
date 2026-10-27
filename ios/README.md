# AnkiBase for iPhone

AnkiBase's web UI as an iPhone app, with **Anki's own engine running on the phone**: your
collection lives on the device, studying works offline, and it syncs straight with AnkiWeb.

| Part | Where it runs |
| --- | --- |
| Decks, studying (Anki's scheduler), undo, card media | On the phone (`engine/`, Anki's Rust library) |
| AnkiWeb login and sync, including media | Phone ↔ AnkiWeb directly |
| The web UI | Bundled in the app (`../frontend`, served at `ankibase://app/`) |
| Everything else: stories, AI, Quizlet, dictionary, statistics, deck options | Your AnkiBase server (`AnkiBaseServer` in Info.plist) |

When the phone is offline, requests for the server get the server's last answer if there
is one (so you stay logged in), otherwise an "offline" error.

## How it fits together

- `engine/` (Rust) wraps Anki 26.09.3's `rslib` and answers AnkiBase's API on the phone:
  `GET /api/decks`, `/api/decks/names`, `POST /api/review/{current,answer,undo}`,
  `GET /api/media-file/<name>`, `POST /api/sync`, `/api/sync/full-{download,upload}`,
  `GET /api/sync/media`, `POST /api/ankiweb/login` (an optional `endpoint` selects a
  self-hosted sync server), `GET /api/ankiweb/status`, `DELETE /api/ankiweb/credentials`.
  Anything else returns "not mine" and goes to the server. The C interface is
  `Sources/AnkiEngine/include/ankibase_engine.h`.
- `Sources/AnkiBase/` (Swift) is the app: a full-screen `WKWebView` and
  `AppSchemeHandler`, which serves the bundled UI, asks the engine first for `/api/…`, and
  forwards the rest (and `/anki-pages/`) to the server with `URLSession`, whose cookies
  keep the server login.

## Build

Builds on Linux with [xtool](https://github.com/xtool-org/xtool) and an iOS SDK
(`xtool sdk status`), Rust (rustup; `engine/rust-toolchain.toml` pins the version and
iPhone target), Node and rsvg-convert (for the app icon):

```sh
scripts/build.sh    # → dist/AnkiBase-<version>-<build>.ipa (unsigned; SideStore signs it)
```

The script cross-compiles the engine for `aarch64-apple-ios` with the SDK's headers,
builds `../frontend`, copies it into the app and packages it. Bump `CFBundleVersion` in
`Info.plist` for every build you hand out.

## Develop without a phone

`engine/examples/emulate.rs` is the app on a computer, routing exactly like the phone,
with Anki's own sync server standing in for AnkiWeb:

```sh
cd engine
cargo run --example emulate -- --web ../../frontend/dist --upstream http://127.0.0.1:8000 \
    --dir /tmp/phone --sync-server /tmp/syncsrv
# open http://127.0.0.1:8800/ at phone size; AnkiWeb login: user@example.com / secret
```

`cargo test` runs two devices through login, a first upload, a full download, studying,
undo, media and a normal sync against that sync server.

## License

`engine/` links Anki's Rust library, which is AGPL-3.0-or-later, so the app as a whole
is distributed under the AGPL (this repository is its source).
