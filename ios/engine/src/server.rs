//! The AnkiBase server, for what only it can do (stories, AI, Quizlet, dictionary…), kept
//! usable offline:
//!
//! - the server's last answer to every GET is kept and served when there's no connection;
//! - study progress saved offline (sessions, Quizlet progress, favourites, edits) is queued,
//!   applied to those kept answers so the app shows it, and sent once the server is back.
//!
//! The server's login cookie is kept here too, so it's the same for every request.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::{Collect, Reply, Request, Sink};
use crate::sessions;

/// After a failed connection, how long to answer from what's kept without trying again.
const OFFLINE_GRACE: Duration = Duration::from_secs(10);
/// The largest server answer worth keeping for offline use.
const MAX_KEPT: usize = 4 * 1024 * 1024;
/// Request headers the server gets from the web view.
const PASSED_REQUEST_HEADERS: &[&str] = &["content-type", "accept", "last-event-id"];
/// Response headers the web view gets from the server.
const PASSED_RESPONSE_HEADERS: &[&str] = &["content-type", "cache-control", "content-disposition"];

#[derive(Default, Serialize, Deserialize)]
struct Cookie {
    value: String,
    /// Unix seconds; None lasts until the server says otherwise.
    expires: Option<u64>,
}

/// A change made offline, waiting for the server.
#[derive(Clone, Serialize, Deserialize)]
struct Queued {
    method: String,
    target: String,
    body: Vec<u8>,
}

pub struct Server {
    base: RwLock<Option<String>>,
    dir: PathBuf,
    rt: tokio::runtime::Runtime,
    client: reqwest::Client,
    cookies: Mutex<BTreeMap<String, Cookie>>,
    outbox: Mutex<Vec<Queued>>,
    /// Held while queued changes are sent, so they go out once and in order.
    flushing: Mutex<()>,
    offline_since: Arc<Mutex<Option<Instant>>>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: &PathBuf) -> T {
    fs::read(path).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or_default()
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) {
    let temporary = path.with_extension("tmp");
    if fs::write(&temporary, serde_json::to_vec(value).unwrap()).is_ok() {
        let _ = fs::rename(&temporary, path);
    }
}

impl Server {
    pub fn new(dir: PathBuf, base: Option<String>) -> Server {
        let _ = fs::create_dir_all(dir.join("responses"));
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("ankibase-server")
            .enable_all()
            .build()
            .expect("tokio runtime");
        // The client's timers belong to this runtime.
        let _context = rt.enter();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .user_agent(concat!("AnkiBase-iOS/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        drop(_context);
        Server {
            cookies: Mutex::new(read_json(&dir.join("cookies.json"))),
            outbox: Mutex::new(read_json(&dir.join("outbox.json"))),
            base: RwLock::new(base.map(|b| b.trim_end_matches('/').to_string())),
            dir,
            rt,
            client,
            flushing: Mutex::new(()),
            offline_since: Arc::new(Mutex::new(None)),
        }
    }

    pub fn base(&self) -> Option<String> {
        self.base.read().unwrap().clone()
    }

    /// Switch servers: the old one's login, kept answers and queued changes are dropped.
    pub fn set_base(&self, base: Option<String>) {
        let base = base.map(|b| b.trim_end_matches('/').to_string());
        if *self.base.read().unwrap() == base {
            return;
        }
        *self.base.write().unwrap() = base;
        self.forget();
        self.outbox.lock().unwrap().clear();
        write_json(&self.dir.join("outbox.json"), &Vec::<Queued>::new());
        *self.offline_since.lock().unwrap() = None;
    }

    /// Log out: no cookie, and nothing of the account's kept on the phone.
    pub fn forget(&self) {
        self.cookies.lock().unwrap().clear();
        write_json(&self.dir.join("cookies.json"), &BTreeMap::<String, Cookie>::new());
        let _ = fs::remove_dir_all(self.dir.join("responses"));
        let _ = fs::create_dir_all(self.dir.join("responses"));
    }

    pub fn pending(&self) -> usize {
        self.outbox.lock().unwrap().len()
    }

    pub fn has_login(&self) -> bool {
        let now = now_secs();
        self.cookies.lock().unwrap().values().any(|c| c.expires.is_none_or(|e| e > now))
    }

    /// Whether the last attempt to reach the server failed.
    pub fn offline(&self) -> bool {
        self.offline_since.lock().unwrap().is_some()
    }

    /// While offline, requests are answered from what's kept straight away; the server is
    /// tried again in the background now and then, and live requests resume once it answers.
    fn skip_network(&self) -> bool {
        let mut since = self.offline_since.lock().unwrap();
        let Some(at) = *since else { return false };
        if at.elapsed() >= OFFLINE_GRACE {
            // The next background try comes OFFLINE_GRACE after this one.
            *since = Some(Instant::now());
            if let Some(base) = self.base() {
                let (client, state) = (self.client.clone(), self.offline_since.clone());
                self.rt.spawn(async move {
                    let probe = client.get(format!("{base}/api/setup/status")).timeout(Duration::from_secs(8));
                    if probe.send().await.is_ok_and(|r| r.status().as_u16() < 500) {
                        *state.lock().unwrap() = None;
                    }
                });
            }
        }
        true
    }

    fn mark(&self, online: bool) {
        *self.offline_since.lock().unwrap() = if online { None } else { Some(Instant::now()) };
    }

    // Kept answers -----------------------------------------------------------------

    fn kept_path(&self, target: &str) -> PathBuf {
        let digest = Sha256::digest(target.as_bytes());
        let name: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        self.dir.join("responses").join(name)
    }

    fn keep(&self, target: &str, content_type: &str, body: &[u8]) {
        if body.len() > MAX_KEPT {
            return;
        }
        let mut record = content_type.as_bytes().to_vec();
        record.push(0);
        record.extend_from_slice(body);
        let path = self.kept_path(target);
        let temporary = path.with_extension("tmp");
        if fs::write(&temporary, record).is_ok() {
            let _ = fs::rename(temporary, path);
        }
    }

    fn kept(&self, target: &str) -> Option<(String, Vec<u8>)> {
        let record = fs::read(self.kept_path(target)).ok()?;
        let split = record.iter().position(|b| *b == 0)?;
        Some((String::from_utf8_lossy(&record[..split]).into_owned(), record[split + 1..].to_vec()))
    }

    fn kept_json(&self, target: &str) -> Option<Value> {
        let (kind, body) = self.kept(target)?;
        kind.starts_with("application/json").then(|| serde_json::from_slice(&body).ok())?
    }

    fn keep_json(&self, target: &str, value: &Value) {
        self.keep(target, "application/json", &serde_json::to_vec(value).unwrap());
    }

    // Cookies ----------------------------------------------------------------------

    fn cookie_header(&self) -> Option<String> {
        let now = now_secs();
        let cookies = self.cookies.lock().unwrap();
        let pairs: Vec<String> = cookies
            .iter()
            .filter(|(_, c)| c.expires.is_none_or(|e| e > now))
            .map(|(name, c)| format!("{name}={}", c.value))
            .collect();
        (!pairs.is_empty()).then(|| pairs.join("; "))
    }

    fn store_cookies(&self, headers: &reqwest::header::HeaderMap) {
        let mut changed = false;
        let mut cookies = self.cookies.lock().unwrap();
        for header in headers.get_all(reqwest::header::SET_COOKIE) {
            let Ok(text) = header.to_str() else { continue };
            let mut parts = text.split(';').map(str::trim);
            let Some((name, value)) = parts.next().and_then(|p| p.split_once('=')) else { continue };
            let mut expires = None;
            for attribute in parts {
                let (key, val) = attribute.split_once('=').unwrap_or((attribute, ""));
                match key.to_ascii_lowercase().as_str() {
                    "max-age" => {
                        if let Ok(age) = val.trim().parse::<i64>() {
                            expires = Some(if age <= 0 { 0 } else { now_secs() + age as u64 });
                        }
                    }
                    "expires" if expires.is_none() => {
                        if let Ok(at) = httpdate::parse_http_date(val.trim()) {
                            expires = Some(at.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
                        }
                    }
                    _ => {}
                }
            }
            let value = value.trim_matches('"').to_string();
            if value.is_empty() || expires.is_some_and(|e| e <= now_secs()) {
                changed |= cookies.remove(name).is_some();
            } else {
                cookies.insert(name.to_string(), Cookie { value, expires });
                changed = true;
            }
        }
        if changed {
            write_json(&self.dir.join("cookies.json"), &*cookies);
        }
    }

    // Requests ---------------------------------------------------------------------

    fn build(&self, base: &str, method: &str, target: &str, headers: &[(String, String)], body: Vec<u8>)
        -> Option<reqwest::RequestBuilder> {
        let url = format!("{base}{target}");
        let method = reqwest::Method::from_bytes(method.as_bytes()).ok()?;
        let mut request = self.client.request(method, url);
        for (name, value) in headers {
            if PASSED_REQUEST_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                request = request.header(name, value);
            }
        }
        if let Some(cookie) = self.cookie_header() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if !body.is_empty() {
            request = request.body(body);
        }
        Some(request)
    }

    /// Send `request` to the server and stream the answer to `sink`, or answer from what's
    /// kept when the server can't be reached.
    pub fn forward(&self, request: &Request, sink: &mut dyn Sink) {
        let Some(base) = self.base() else {
            return Reply::error(503, "No AnkiBase server is connected. Add one in Settings → Server.").send(sink);
        };
        let target = request.target.as_str();
        let is_get = request.method == "GET";
        if self.skip_network() {
            return self.fallback(request).send(sink);
        }
        if !is_get {
            self.flush();
        }
        let streaming = request.header("accept").is_some_and(|a| a.contains("text/event-stream"));
        let Some(mut outgoing) = self.build(&base, &request.method, target, &request.headers, request.body.clone())
        else {
            return Reply::error(400, "Bad request").send(sink);
        };
        if !streaming {
            // A bad connection shouldn't hold the app up when there's an answer to fall back
            // on; AI stories, though, can take minutes.
            let wait = if is_get && self.kept_path(target).exists() {
                5
            } else if is_get {
                30
            } else if queueable(&request.method, request.path()) {
                15
            } else {
                600
            };
            outgoing = outgoing.timeout(Duration::from_secs(wait));
        }
        let response = match self.rt.block_on(async { outgoing.send().await }) {
            Ok(response) => response,
            Err(_) => {
                self.mark(false);
                return self.fallback(request).send(sink);
            }
        };
        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter(|(name, _)| PASSED_RESPONSE_HEADERS.contains(&name.as_str()))
            .map(|(name, value)| (name.to_string(), value.to_str().unwrap_or_default().to_string()))
            .collect();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        self.store_cookies(response.headers());

        // A proxy in front of a stopped server: as good as offline.
        if matches!(status, 502..=504) && !content_type.starts_with("application/json") {
            self.mark(false);
            return self.fallback(request).send(sink);
        }
        self.mark(true);

        if content_type.starts_with("text/event-stream") {
            sink.head(status, &headers);
            let mut response = response;
            while let Ok(Some(chunk)) = self.rt.block_on(response.chunk()) {
                if !sink.data(&chunk) {
                    break;
                }
            }
            return;
        }
        let body = match self.rt.block_on(response.bytes()) {
            Ok(body) => body.to_vec(),
            Err(_) => {
                self.mark(false);
                return self.fallback(request).send(sink);
            }
        };
        if is_get && status == 200 && target.starts_with("/api/") && !target.starts_with("/api/update/") {
            self.keep(target, &content_type, &body);
        }
        if request.path() == "/api/auth/logout" {
            self.forget();
        }
        Reply { status, headers, body }.send(sink);
        if is_get && self.pending() > 0 {
            self.flush();
        }
    }

    /// The server's answer as JSON (or the kept one when offline), for answers the phone
    /// combines with its own.
    pub fn get_json(&self, target: &str) -> Option<Value> {
        self.base()?;
        let mut collect = Collect::default();
        self.forward(&Request::new("GET", target, Vec::new()), &mut collect);
        (collect.status == 200).then(|| collect.into_reply().value())?
    }

    /// Download a file from the server (no keeping, no queueing): its `X-Title` and contents.
    pub fn post_bytes(&self, target: &str, body: Vec<u8>) -> Result<(Option<String>, Vec<u8>), Reply> {
        let base = self.base().ok_or_else(|| Reply::error(503, "This needs your AnkiBase server."))?;
        let request = self
            .build(&base, "POST", target, &[("content-type".into(), "application/json".into())], body)
            .ok_or_else(|| Reply::error(400, "Bad request"))?
            .timeout(Duration::from_secs(900));
        let response = self.rt.block_on(async { request.send().await }).map_err(|_| {
            self.mark(false);
            Reply::error(503, "You're offline. Downloading a deck needs an internet connection.")
        })?;
        let status = response.status().as_u16();
        let title = response
            .headers()
            .get("x-title")
            .and_then(|v| v.to_str().ok())
            .map(|t| crate::http::decode(t));
        let body = self.rt.block_on(response.bytes()).map(|b| b.to_vec()).unwrap_or_default();
        if status != 200 {
            let detail = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|v| v["detail"].as_str().map(String::from))
                .unwrap_or_else(|| format!("The server answered {status}"));
            return Err(Reply::error(status, detail));
        }
        Ok((title, body))
    }

    /// JSON from anywhere on the web (the app's update feed).
    pub fn fetch_json(&self, url: &str) -> Option<Value> {
        let request = self.client.get(url).timeout(Duration::from_secs(15));
        let response = self.rt.block_on(async { request.send().await }).ok()?;
        let body = self.rt.block_on(response.bytes()).ok()?;
        serde_json::from_slice(&body).ok()
    }

    /// Try the server again (Settings' status and the offline banner use this).
    pub fn check(&self) -> bool {
        let Some(base) = self.base() else { return false };
        let request = self.client.get(format!("{base}/api/setup/status")).timeout(Duration::from_secs(8));
        let online = self.rt.block_on(async { request.send().await }).is_ok_and(|r| r.status().as_u16() < 500);
        self.mark(online);
        if online {
            self.flush();
        }
        online
    }

    // Offline ----------------------------------------------------------------------

    fn fallback(&self, request: &Request) -> Reply {
        let offline = || {
            Reply::error(503, "You're offline, and this needs your AnkiBase server. It works again once you're online.")
        };
        if request.method == "GET" {
            return match self.kept(&request.target) {
                Some((kind, body)) => Reply::new(200, &kind, body).with_header("X-AnkiBase-Offline", "1"),
                None => offline(),
            };
        }
        match self.queue(request) {
            Some(reply) => reply.with_header("X-AnkiBase-Offline", "1"),
            None => offline(),
        }
    }

    /// Queue a change made offline, if it's one that can wait (see `queueable`), and show it in the kept
    /// answers. Returns what the server would have answered.
    fn queue(&self, request: &Request) -> Option<Reply> {
        let segments = request.segments("/api/")?;
        let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let path = request.path();
        let reply = match (request.method.as_str(), segments.as_slice()) {
            ("PUT", ["sessions", kind, reference]) => {
                let one = path.to_string();
                let existing = self.kept_json(&one).and_then(|v| v.get("session").cloned()).filter(|s| !s.is_null());
                let record = sessions::upsert(existing, kind, reference, &body);
                self.keep_json(&one, &json!({"session": record}));
                if let Some(list) = self.kept_json("/api/sessions") {
                    self.keep_json("/api/sessions", &sessions::list_with(list, Some(&record), kind, reference));
                }
                json!({"success": true})
            }
            ("DELETE", ["sessions", kind, reference]) => {
                self.keep_json(path, &json!({"session": null}));
                if let Some(list) = self.kept_json("/api/sessions") {
                    self.keep_json("/api/sessions", &sessions::list_with(list, None, kind, reference));
                }
                json!({"success": true})
            }
            ("PUT", ["quizlet", "decks", _, "state", _]) => {
                self.keep_json(path, &json!({"state": body.get("state").cloned().unwrap_or(Value::Null)}));
                json!({"success": true})
            }
            ("DELETE", ["quizlet", "decks", _, "state", _]) => {
                self.keep_json(path, &json!({"state": null}));
                json!({"success": true})
            }
            ("POST", ["quizlet", "decks", _, "review"]) => json!({"success": true}),
            ("POST", ["quizlet", "decks", deck, "favorites", card]) => {
                let card: i64 = card.parse().ok()?;
                let target = format!("/api/quizlet/decks/{deck}/favorites");
                let mut ids: Vec<i64> = self
                    .kept_json(&target)
                    .and_then(|v| serde_json::from_value(v["card_ids"].clone()).ok())
                    .unwrap_or_default();
                let favorited = !ids.contains(&card);
                if favorited {
                    ids.push(card);
                } else {
                    ids.retain(|id| *id != card);
                }
                self.keep_json(&target, &json!({"card_ids": ids}));
                json!({"favorited": favorited})
            }
            ("PATCH", ["quizlet", "decks", deck, "cards", card]) => {
                let card: i64 = card.parse().ok()?;
                let target = format!("/api/quizlet/decks/{deck}");
                if let Some(mut set) = self.kept_json(&target) {
                    if let Some(cards) = set["cards"].as_array_mut() {
                        for entry in cards.iter_mut().filter(|c| c["id"] == json!(card)) {
                            for key in ["front", "back", "image"] {
                                if let Some(value) = body.get(key) {
                                    entry[key] = value.clone();
                                }
                            }
                        }
                    }
                    self.keep_json(&target, &set);
                }
                json!({"success": true})
            }
            _ => return None,
        };
        let mut outbox = self.outbox.lock().unwrap();
        outbox.push(Queued { method: request.method.clone(), target: request.target.clone(), body: request.body.clone() });
        write_json(&self.dir.join("outbox.json"), &*outbox);
        Some(Reply::ok(reply))
    }

    /// Send the changes made offline, oldest first. Stops at the first one that can't
    /// reach the server; one the server refuses is dropped (it would never succeed).
    pub fn flush(&self) {
        let Some(base) = self.base() else { return };
        let Ok(_guard) = self.flushing.try_lock() else {
            // Another request is sending them; wait for it so this one goes out after.
            let _wait = self.flushing.lock().unwrap();
            return;
        };
        loop {
            let Some(next) = self.outbox.lock().unwrap().first().cloned() else { break };
            let headers = [("content-type".to_string(), "application/json".to_string())];
            let Some(request) = self.build(&base, &next.method, &next.target, &headers, next.body.clone()) else {
                break;
            };
            match self.rt.block_on(async { request.timeout(Duration::from_secs(30)).send().await }) {
                Ok(response) => {
                    self.store_cookies(response.headers());
                    if response.status().as_u16() == 401 {
                        // Logged out meanwhile: keep the changes for after the next login.
                        break;
                    }
                    let mut outbox = self.outbox.lock().unwrap();
                    if !outbox.is_empty() {
                        outbox.remove(0);
                    }
                    write_json(&self.dir.join("outbox.json"), &*outbox);
                }
                Err(_) => {
                    self.mark(false);
                    break;
                }
            }
        }
    }
}

/// Changes that can wait for the server: saving study progress, Quizlet answers, favourites
/// and card edits (the ones `Server::queue` knows how to show while they wait).
fn queueable(method: &str, path: &str) -> bool {
    let segments: Vec<&str> = path.trim_start_matches("/api/").split('/').collect();
    matches!(
        (method, segments.as_slice()),
        ("PUT" | "DELETE", ["sessions", _, _])
            | ("PUT" | "DELETE", ["quizlet", "decks", _, "state", _])
            | ("POST", ["quizlet", "decks", _, "review"])
            | ("POST", ["quizlet", "decks", _, "favorites", _])
            | ("PATCH", ["quizlet", "decks", _, "cards", _])
    )
}
