//! The phone app on a computer, for developing and testing the web UI: the same core
//! (app.rs) over the same HTTP transport the Android app uses (httpd.rs).
//!
//!   cargo run --example emulate -- --web ../../frontend/dist --dir /tmp/phone \
//!       [--server http://127.0.0.1:8000] [--pages ../.build/anki-pages] [--port 8800] \
//!       [--sync-server /tmp/syncsrv]
//!
//! With --sync-server, Anki's own sync server runs locally (user `user@example.com`,
//! password `secret`) holding a few small decks; log in to it in Settings → Sync → Own sync
//! server with the address it prints.

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use anki::sync::http_server::{SimpleServer, SyncServerConfig};
use ankibase_engine::{App, Collect, Config, Request};
use serde_json::{json, Value};

fn main() {
    let mut args: HashMap<String, String> = HashMap::new();
    let raw: Vec<String> = std::env::args().skip(1).collect();
    for pair in raw.chunks(2) {
        args.insert(pair[0].trim_start_matches("--").to_string(), pair.get(1).cloned().unwrap_or_default());
    }
    let need = |key: &str| args.get(key).cloned().unwrap_or_else(|| panic!("--{key} is required"));
    if let Some(base) = args.get("sync-server") {
        start_sync_server(Path::new(base));
    }
    let port: u16 = args.get("port").map(|p| p.parse().unwrap()).unwrap_or(8800);

    let app = Arc::new(App::start(Config {
        dir: need("dir").into(),
        web: Some(need("web").into()),
        pages: args.get("pages").map(Into::into),
        default_server: args.get("server").cloned(),
        version: "dev".into(),
        build: "0".into(),
        update_feed: None, bundle_id: None, media_token: None,
    }));
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    // --token: like the Android app, only a browser that opened /__start?token=… gets in.
    let token = args.get("token").cloned();
    match &token {
        Some(token) => println!("The app: http://127.0.0.1:{port}/__start?token={token}"),
        None => println!("The app: http://127.0.0.1:{port}/"),
    }
    ankibase_engine::httpd::serve(app, listener, token);
}

fn start_sync_server(base: &Path) -> String {
    std::env::set_var("SYNC_USER1", "user@example.com:secret");
    let config: SyncServerConfig =
        serde_json::from_value(json!({"host": "127.0.0.1", "port": 0, "base": base})).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (addr, server) = SimpleServer::make_server(config).await.unwrap();
            tx.send(addr).unwrap();
            server.await.unwrap();
        });
    });
    let endpoint = format!("http://{}/", rx.recv().unwrap());
    if !base.join("user@example.com").join("collection.anki2").exists() {
        seed(base, &endpoint);
    }
    println!("Sync server: {endpoint} (user@example.com / secret)");
    endpoint
}

/// A "desktop" collection with a few cards, uploaded so the phone has something to sync.
fn seed(base: &Path, endpoint: &str) {
    let desktop = App::start(Config {
        dir: base.join("desktop"),
        web: None,
        pages: None,
        default_server: None,
        version: "dev".into(),
        build: "0".into(),
        update_feed: None, bundle_id: None, media_token: None,
    });
    let call = |method: &str, target: &str, body: Value| {
        let mut collect = Collect::default();
        desktop.handle(&Request::new(method, target, serde_json::to_vec(&body).unwrap()), &mut collect);
        assert_eq!(collect.status, 200, "{}", String::from_utf8_lossy(&collect.body));
    };
    call("POST", "/api/ankiweb/login", json!({"email": "user@example.com", "password": "secret", "endpoint": endpoint}));
    desktop
        .with_engine(|engine| {
            let col = engine.col().unwrap();
            let basic = col.get_notetype_by_name("Basic").unwrap().unwrap();
            for (deck, words) in [("French::Verbs", &[("être", "to be"), ("avoir", "to have"), ("aller", "to go"), ("faire", "to do")][..]),
                                  ("French::Nouns", &[("la maison", "the house"), ("le chat", "the cat")][..]),
                                  ("Spanish", &[("hola", "hello"), ("gracias", "thank you"), ("adiós", "goodbye")][..])] {
                let did = col.get_or_create_normal_deck(deck).unwrap().id;
                for (front, back) in words {
                    let mut note = basic.new_note();
                    note.set_field(0, *front).unwrap();
                    note.set_field(1, *back).unwrap();
                    col.add_note(&mut note, did).unwrap();
                }
            }
        })
        .unwrap_or_else(|_| panic!("no engine"));
    call("POST", "/api/sync", Value::Null);
}
