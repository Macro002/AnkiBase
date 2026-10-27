//! The iPhone app on a computer, for developing and testing the web UI: serves the built
//! frontend, answers Anki's API with the engine (as AppSchemeHandler does on the phone)
//! and proxies everything else to an AnkiBase server.
//!
//!   cargo run --example emulate -- --web ../../frontend/dist --upstream http://127.0.0.1:8000 \
//!       --dir /tmp/phone [--port 8800] [--sync-server /tmp/syncsrv]
//!
//! With --sync-server, Anki's own sync server runs locally (user `user@example.com`,
//! password `secret`) holding a small French deck, and AnkiWeb logins go to it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anki::sync::http_server::{SimpleServer, SyncServerConfig};
use ankibase_engine::{handle, Engine};
use serde_json::{json, Value};

struct Options {
    web: PathBuf,
    upstream: String,
    dir: PathBuf,
    port: u16,
    sync_endpoint: Option<String>,
}

fn main() {
    let mut args: HashMap<String, String> = HashMap::new();
    let raw: Vec<String> = std::env::args().skip(1).collect();
    for pair in raw.chunks(2) {
        args.insert(pair[0].trim_start_matches("--").to_string(), pair.get(1).cloned().unwrap_or_default());
    }
    let need = |key: &str| args.get(key).cloned().unwrap_or_else(|| panic!("--{key} is required"));
    let mut options = Options {
        web: need("web").into(),
        upstream: need("upstream").trim_end_matches('/').to_string(),
        dir: need("dir").into(),
        port: args.get("port").map(|p| p.parse().unwrap()).unwrap_or(8800),
        sync_endpoint: None,
    };
    if let Some(base) = args.get("sync-server") {
        options.sync_endpoint = Some(start_sync_server(Path::new(base)));
    }

    let engine = Arc::new(Mutex::new(Engine::open(&options.dir).expect("open collection")));
    let options = Arc::new(options);
    let listener = TcpListener::bind(("127.0.0.1", options.port)).unwrap();
    println!("The app: http://127.0.0.1:{}/", options.port);
    for stream in listener.incoming().flatten() {
        let (engine, options) = (engine.clone(), options.clone());
        std::thread::spawn(move || {
            let _ = serve(stream, &engine, &options);
        });
    }
}

fn serve(stream: TcpStream, engine: &Mutex<Engine>, options: &Options) -> std::io::Result<()> {
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
    let path = target.split('?').next().unwrap_or("/").to_string();

    let (status, extra, data) = if path.starts_with("/api/") {
        if let (Some(endpoint), "/api/ankiweb/login") = (&options.sync_endpoint, path.as_str()) {
            let mut login: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
            login["endpoint"] = json!(endpoint);
            body = serde_json::to_vec(&login).unwrap();
        }
        let reply = handle(&mut engine.lock().unwrap(), &method, &target, &body);
        if reply.status != 0 {
            (reply.status, vec![("Content-Type".to_string(), reply.content_type)], reply.body)
        } else {
            forward(options, &method, &target, &headers, body)
        }
    } else if path.starts_with("/anki-pages/") {
        forward(options, &method, &target, &headers, body)
    } else {
        let mut file = options.web.join(path.trim_start_matches('/'));
        if path.contains("..") || !file.is_file() {
            file = options.web.join("index.html");
        }
        let kind = match file.extension().and_then(|e| e.to_str()) {
            Some("html") => "text/html",
            Some("js") => "text/javascript",
            Some("css") => "text/css",
            Some("svg") => "image/svg+xml",
            _ => "application/octet-stream",
        };
        (200, vec![("Content-Type".into(), kind.into())], std::fs::read(file)?)
    };

    let mut out = stream;
    write!(out, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", data.len())?;
    for (name, value) in extra {
        write!(out, "{name}: {value}\r\n")?;
    }
    out.write_all(b"\r\n")?;
    out.write_all(&data)
}

/// Like URLSession on the phone: the server's cookies go with the request, the server's
/// Set-Cookie back to the browser.
fn forward(
    options: &Options,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: Vec<u8>,
) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let mut request = client.request(method.parse().unwrap(), format!("{}{target}", options.upstream));
        for (name, value) in headers {
            if !["host", "origin", "referer", "content-length", "connection"].contains(&name.to_lowercase().as_str()) {
                request = request.header(name, value);
            }
        }
        match request.body(body).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let passed = response
                    .headers()
                    .iter()
                    .filter(|(n, _)| ["content-type", "set-cookie", "cache-control", "location"].contains(&n.as_str()))
                    .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or_default().replace("; Secure", "")))
                    .collect();
                (status, passed, response.bytes().await.unwrap_or_default().to_vec())
            }
            Err(err) => (503, vec![("Content-Type".into(), "application/json".into())],
                         serde_json::to_vec(&json!({"detail": format!("offline: {err}")})).unwrap()),
        }
    })
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
    let mut desktop = Engine::open(base.join("desktop")).unwrap();
    let login = json!({"email": "user@example.com", "password": "secret", "endpoint": endpoint});
    handle(&mut desktop, "POST", "/api/ankiweb/login", &serde_json::to_vec(&login).unwrap());
    let col = desktop.col().unwrap();
    let basic = col.get_notetype_by_name("Basic").unwrap().unwrap();
    for (deck, words) in [("French::Verbs", &["être", "avoir", "aller", "faire"][..]),
                          ("French::Nouns", &["la maison", "le chat"][..]),
                          ("Spanish", &["hola", "gracias", "adiós"][..])] {
        let did = col.get_or_create_normal_deck(deck).unwrap().id;
        for word in words {
            let mut note = basic.new_note();
            note.set_field(0, *word).unwrap();
            note.set_field(1, format!("<b>{word}</b> means something")).unwrap();
            col.add_note(&mut note, did).unwrap();
        }
    }
    let reply = handle(&mut desktop, "POST", "/api/sync", &[]);
    assert_eq!(reply.status, 200, "{}", String::from_utf8_lossy(&reply.body));
}
