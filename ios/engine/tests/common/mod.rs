//! Helpers: the app as the web view sees it, Anki's sync server, and a stand-in AnkiBase server.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anki::sync::http_server::{SimpleServer, SyncServerConfig};
use ankibase_engine::{App, Collect, Config, Request};
use serde_json::{json, Value};

pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ankibase-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn app(dir: &Path, server: Option<&str>) -> App {
    app_with(dir, server, None)
}

/// The app with the focus lock's folder (as on an iPhone).
pub fn app_with(dir: &Path, server: Option<&str>, focus_dir: Option<PathBuf>) -> App {
    let web = dir.join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>AnkiBase</title>").unwrap();
    std::fs::write(web.join("assets/app.js"), "console.log(1)").unwrap();
    let mut settings = json!({});
    if server.is_none() {
        settings["server"] = json!("");
    }
    std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
    App::start(Config {
        dir: dir.to_path_buf(),
        web: Some(web),
        pages: None,
        default_server: server.map(String::from),
        version: "0.2.0".into(),
        build: "2".into(),
        update_feed: None, bundle_id: None, media_token: None, focus_dir,
    })
}

pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub fn send(app: &App, method: &str, target: &str, headers: &[(&str, &str)], body: Vec<u8>) -> Answer {
    let mut request = Request::new(method, target, body);
    request.headers = headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect();
    let mut collect = Collect::default();
    app.handle(&request, &mut collect);
    Answer { status: collect.status, headers: collect.headers, body: collect.body }
}

pub fn call(app: &App, method: &str, target: &str, body: Value) -> (u16, Value) {
    let data = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let answer = send(app, method, target, &[("content-type", "application/json")], data);
    (answer.status, answer.json())
}

pub fn ok(app: &App, method: &str, target: &str, body: Value) -> Value {
    let (status, value) = call(app, method, target, body);
    assert_eq!(status, 200, "{method} {target}: {value}");
    value
}

/// Anki's own sync server with one user, `user@example.com` / `secret`.
pub fn start_sync_server(base: &Path) -> String {
    std::env::set_var("SYNC_USER1", "user@example.com:secret");
    let config: SyncServerConfig =
        serde_json::from_value(json!({"host": "127.0.0.1", "port": 0, "base": base})).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (addr, server) = SimpleServer::make_server(config).await.unwrap();
            tx.send(addr).unwrap();
            server.await.unwrap();
        });
    });
    format!("http://{}/", rx.recv().unwrap())
}

pub fn add_cards(app: &App, deck: &str, fronts: &[&str]) {
    app.with_engine(|engine| {
        let col = engine.col().unwrap();
        let did = col.get_or_create_normal_deck(deck).unwrap().id;
        let basic = col.get_notetype_by_name("Basic").unwrap().unwrap();
        for front in fronts {
            let mut note = basic.new_note();
            note.set_field(0, *front).unwrap();
            note.set_field(1, format!("back of {front} <img src=\"pic.png\">")).unwrap();
            col.add_note(&mut note, did).unwrap();
        }
        col.media().unwrap().add_file("pic.png", b"not really a png").unwrap();
    })
    .unwrap_or_else(|_| panic!("no engine"));
}

/// A request the stand-in server received.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub cookie: Option<String>,
    pub body: Value,
}

/// A stand-in AnkiBase server: logins, sessions, Quizlet favourites, an event stream.
/// While `down` is set it hangs up on every connection, like an unreachable server.
pub struct FakeServer {
    pub url: String,
    pub down: Arc<AtomicBool>,
    /// Accepts connections and never answers, like a server behind a bad connection.
    pub hang: Arc<AtomicBool>,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeServer {
    pub fn start() -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let down = Arc::new(AtomicBool::new(false));
        let hang = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let state = Arc::new(Mutex::new(HashMap::<String, Value>::new()));
        let (d, h, s) = (down.clone(), hang.clone(), seen.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if d.load(Ordering::SeqCst) {
                    drop(stream);
                    continue;
                }
                if h.load(Ordering::SeqCst) {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                        drop(stream);
                    });
                    continue;
                }
                let (s, state) = (s.clone(), state.clone());
                std::thread::spawn(move || {
                    let _ = serve(stream, &s, &state);
                });
            }
        });
        FakeServer { url, down, hang, seen }
    }

    pub fn set_down(&self, down: bool) {
        self.down.store(down, Ordering::SeqCst);
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn serve(stream: TcpStream, seen: &Mutex<Vec<Seen>>, state: &Mutex<HashMap<String, Value>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let mut length = 0;
    let mut cookie = None;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap_or((header, ""));
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().unwrap_or(0),
            "cookie" => cookie = Some(value.trim().to_string()),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    seen.lock().unwrap().push(Seen { method: method.clone(), target: target.clone(), cookie: cookie.clone(), body: body.clone() });
    let logged_in = cookie.as_deref() == Some("session_id=abc");
    let path = target.split('?').next().unwrap_or_default().to_string();

    let mut out = stream;
    let reply = |out: &mut TcpStream, status: u16, extra: &str, value: Value| -> std::io::Result<()> {
        let body = value.to_string();
        write!(out, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}", body.len())
    };
    if path == "/api/update/apply" {
        write!(out, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")?;
        for step in 1..=3 {
            write!(out, "data: step {step}\n\n")?;
            out.flush()?;
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        return Ok(());
    }
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/setup/status") => reply(&mut out, 200, "", json!({"needs_setup": false, "has_admin": true, "has_container": true})),
        ("POST", "/api/auth/login") => reply(&mut out, 200, "Set-Cookie: session_id=abc; HttpOnly; Max-Age=604800; Path=/; SameSite=lax\r\n",
                                             json!({"success": true, "user": {"username": "alex"}})),
        ("POST", "/api/auth/logout") => reply(&mut out, 200, "Set-Cookie: session_id=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/\r\n",
                                              json!({"success": true})),
        _ if !logged_in => reply(&mut out, 401, "", json!({"detail": "Not authenticated"})),
        ("GET", "/api/auth/check") => reply(&mut out, 200, "", json!({"authenticated": true, "user": {"username": "alex"}})),
        ("GET", "/api/stories") => reply(&mut out, 200, "", json!({"stories": [{"id": 1, "name": "Au marché"}]})),
        ("GET", "/api/sessions") => {
            let sessions: Vec<Value> = state.lock().unwrap().iter()
                .filter(|(k, _)| k.starts_with("session:")).map(|(_, v)| v.clone()).collect();
            reply(&mut out, 200, "", json!({"sessions": sessions}))
        }
        (_, p) if p.starts_with("/api/sessions/") => {
            let key = format!("session:{p}");
            match method.as_str() {
                "GET" => reply(&mut out, 200, "", json!({"session": state.lock().unwrap().get(&key).cloned()})),
                "PUT" => {
                    let parts: Vec<&str> = p.split('/').collect();
                    let mut record = body.clone();
                    record["kind"] = json!(parts[3]);
                    record["ref_id"] = json!(parts[4]);
                    record["updated_at"] = json!("2026-10-27 10:00:00");
                    state.lock().unwrap().insert(key, record);
                    reply(&mut out, 200, "", json!({"success": true}))
                }
                _ => {
                    state.lock().unwrap().remove(&key);
                    reply(&mut out, 200, "", json!({"success": true}))
                }
            }
        }
        ("GET", "/api/quizlet/decks/7/favorites") => {
            let ids = state.lock().unwrap().get("favorites").cloned().unwrap_or(json!([]));
            reply(&mut out, 200, "", json!({"card_ids": ids}))
        }
        ("POST", "/api/quizlet/decks/7/favorites/42") => {
            let mut state = state.lock().unwrap();
            let mut ids: Vec<i64> = serde_json::from_value(state.get("favorites").cloned().unwrap_or(json!([]))).unwrap();
            let favorited = !ids.contains(&42);
            if favorited { ids.push(42) } else { ids.retain(|i| *i != 42) }
            state.insert("favorites".into(), json!(ids));
            reply(&mut out, 200, "", json!({"favorited": favorited}))
        }
        ("POST", "/api/story/generate") => reply(&mut out, 200, "", json!({"story": "Il était une fois", "story_id": 2})),
        ("GET", "/api/search/cards") => reply(&mut out, 200, "", json!({"anki": [{"note_id": 999}], "quizlet": [{"id": 5, "front": "le chat"}],
                                                                        "anki_total": 1, "anki_error": null})),
        ("GET", "/api/stats/overview") => {
            assert!(target.contains("anki=false"), "the phone computes Anki's stats itself: {target}");
            reply(&mut out, 200, "", json!({"today": "2026-10-27", "rollover_hours": 4, "anki": null,
                                            "quizlet": {"today": {"answers": 3, "correct": 2}}}))
        }
        ("GET", "/api/stats/reviews") => reply(&mut out, 200, "", json!({"daily_counts": {"2026-10-01": 5}, "today": 2})),
        _ => reply(&mut out, 404, "", json!({"detail": "Not found"})),
    }
}
