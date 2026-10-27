//! The iPhone app on a computer, for developing and testing the web UI: the same core
//! (app.rs) answers everything, exactly as on the phone; only the transport differs.
//!
//!   cargo run --example emulate -- --web ../../frontend/dist --dir /tmp/phone \
//!       [--server http://127.0.0.1:8000] [--pages ../.build/anki-pages] [--port 8800] \
//!       [--sync-server /tmp/syncsrv]
//!
//! With --sync-server, Anki's own sync server runs locally (user `user@example.com`,
//! password `secret`) holding a few small decks, and AnkiWeb logins that don't name a
//! server go to it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;

use anki::sync::http_server::{SimpleServer, SyncServerConfig};
use ankibase_engine::{App, Collect, Config, Request, Sink};
use serde_json::{json, Value};

struct Socket(TcpStream);

impl Sink for Socket {
    fn head(&mut self, status: u16, headers: &[(String, String)]) {
        let mut head = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let _ = self.0.write_all(head.as_bytes());
    }

    fn data(&mut self, bytes: &[u8]) -> bool {
        self.0.write_all(bytes).and_then(|_| self.0.flush()).is_ok()
    }
}

fn main() {
    let mut args: HashMap<String, String> = HashMap::new();
    let raw: Vec<String> = std::env::args().skip(1).collect();
    for pair in raw.chunks(2) {
        args.insert(pair[0].trim_start_matches("--").to_string(), pair.get(1).cloned().unwrap_or_default());
    }
    let need = |key: &str| args.get(key).cloned().unwrap_or_else(|| panic!("--{key} is required"));
    let sync_endpoint = args.get("sync-server").map(|base| start_sync_server(Path::new(base)));
    let port: u16 = args.get("port").map(|p| p.parse().unwrap()).unwrap_or(8800);

    let app = Arc::new(App::start(Config {
        dir: need("dir").into(),
        web: Some(need("web").into()),
        pages: args.get("pages").map(Into::into),
        default_server: args.get("server").cloned(),
        version: "dev".into(),
        build: "0".into(),
        update_feed: None, bundle_id: None,
    }));
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    println!("The app: http://127.0.0.1:{port}/");
    for stream in listener.incoming().flatten() {
        let (app, endpoint) = (app.clone(), sync_endpoint.clone());
        std::thread::spawn(move || {
            let _ = serve(stream, &app, endpoint.as_deref());
        });
    }
}

fn serve(stream: TcpStream, app: &App, sync_endpoint: Option<&str>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("GET").to_string(), parts.next().unwrap_or("/").to_string());
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    if let (Some(endpoint), "/api/ankiweb/login") = (sync_endpoint, target.as_str()) {
        let mut login: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
        if login["endpoint"].as_str().unwrap_or_default().is_empty() {
            login["endpoint"] = json!(endpoint);
            body = serde_json::to_vec(&login).unwrap();
        }
    }
    let request = Request { method, target, headers, body };
    app.handle(&request, &mut Socket(stream));
    Ok(())
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
        update_feed: None, bundle_id: None,
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
