//! The app: everything the web view asks for at `ankibase://app/` is answered here.
//!
//! - the web UI and Anki's pages, from files bundled with the app;
//! - Anki (decks, studying, search, stats, sync…), from the collection on the phone;
//! - the rest from the AnkiBase server, when one is connected (see server.rs), merged with
//!   the phone's own answers where both have a part (search, stats);
//! - without a server, the phone keeps the profile (language, colours) and sessions itself.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::api;
use crate::engine::{Engine, Failure};
use crate::http::{mime_type, Reply, Request, Sink};
use crate::server::Server;
use crate::sessions::LocalSessions;

#[derive(Deserialize)]
pub struct Config {
    /// Where the collection and the app's own files live.
    pub dir: PathBuf,
    /// The built web UI.
    pub web: Option<PathBuf>,
    /// Anki's pages (scripts/anki-pages.py).
    pub pages: Option<PathBuf>,
    /// The server new installs use (Info.plist's AnkiBaseServer).
    pub default_server: Option<String>,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub build: String,
    /// The SideStore source new builds are published to.
    #[serde(default)]
    pub update_feed: Option<String>,
    /// This build's bundle identifier (to find it in the update feed).
    #[serde(default)]
    pub bundle_id: Option<String>,
    /// The Android app's access token (httpd.rs), which card media URLs carry.
    #[serde(default)]
    pub media_token: Option<String>,
}

/// The phone's own profile, used when no server is connected.
#[derive(Default, Serialize, Deserialize)]
struct Profile {
    language: Option<String>,
    accent: Option<String>,
    hover: Option<String>,
    base_colors: Option<Map<String, Value>>,
}

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    /// None: the default server; Some(""): no server; Some(url): that server.
    server: Option<String>,
    #[serde(default)]
    profile: Profile,
}

const DEFAULT_ACCENT: (&str, &str) = ("#e94560", "#ff6b6b");

pub struct App {
    config: Config,
    engine: Mutex<Option<Engine>>,
    engine_error: Option<String>,
    settings: Mutex<Settings>,
    pub server: Server,
    sessions: LocalSessions,
}

impl App {
    pub fn start(config: Config) -> App {
        let collection = config.dir.join("Collection");
        let (engine, engine_error) = match Engine::open(&collection) {
            Ok(mut engine) => {
                if let Some(token) = &config.media_token {
                    engine.media_token = token.clone();
                }
                (Some(engine), None)
            }
            Err(failure) => (None, Some(failure.detail)),
        };
        let settings: Settings = std::fs::read(config.dir.join("settings.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let server_url = server_url(&settings, &config);
        App {
            server: Server::new(config.dir.join("Server"), server_url),
            sessions: LocalSessions::new(config.dir.join("sessions.json")),
            engine: Mutex::new(engine),
            engine_error,
            settings: Mutex::new(settings),
            config,
        }
    }

    fn save_settings(&self, settings: &Settings) {
        let _ = std::fs::write(self.config.dir.join("settings.json"), serde_json::to_vec_pretty(settings).unwrap());
    }

    fn engine(&self) -> Result<MutexGuard<'_, Option<Engine>>, Reply> {
        let guard = self.engine.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let detail = self.engine_error.clone().unwrap_or_default();
            return Err(Reply::error(500, format!("Couldn't open the collection: {detail}")));
        }
        Ok(guard)
    }

    /// Run `f` with the engine; a panic in Anki answers 500 instead of taking the app down.
    pub fn with_engine<T>(&self, f: impl FnOnce(&mut Engine) -> T) -> Result<T, Reply> {
        let mut guard = self.engine()?;
        let engine = guard.as_mut().unwrap();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(engine)))
            .map_err(|_| Reply::error(500, "The Anki engine crashed on this request"))
    }

    /// Answer one request from the web view.
    pub fn handle(&self, request: &Request, sink: &mut dyn Sink) {
        let path = request.path();
        if path.starts_with("/api/") {
            self.api(request, sink);
        } else if let Some(rest) = path.strip_prefix("/anki-pages/") {
            self.anki_page(request, rest).send(sink);
        } else {
            self.web_file(path).send(sink);
        }
    }

    // Files ------------------------------------------------------------------------

    fn web_file(&self, path: &str) -> Reply {
        let Some(root) = &self.config.web else { return Reply::error(404, "No web UI") };
        let relative = crate::http::decode(path.trim_start_matches('/'));
        match read_inside(root, &relative) {
            Some(bytes) => {
                let mut reply = Reply::new(200, mime_type(&relative), bytes);
                if relative.starts_with("assets/") {
                    reply = reply.with_header("Cache-Control", "max-age=31536000, immutable");
                }
                reply
            }
            // A route of the single-page app.
            None => match std::fs::read(root.join("index.html")) {
                Ok(bytes) => Reply::new(200, "text/html; charset=utf-8", bytes).with_header("Cache-Control", "no-cache"),
                Err(_) => Reply::error(404, "Not found"),
            },
        }
    }

    fn anki_page(&self, request: &Request, rest: &str) -> Reply {
        if let Some(method) = rest.strip_prefix("_anki/") {
            if request.method != "POST" {
                return Reply::error(405, "POST only");
            }
            return match self.with_engine(|engine| engine.page_call(method, &request.body)) {
                Ok(Ok(output)) if output.is_empty() => Reply::new(204, "application/binary", Vec::new()),
                Ok(Ok(output)) => Reply::new(200, "application/binary", output),
                Ok(Err(failure)) => Reply::new(failure.status, "text/plain", failure.detail),
                Err(reply) => reply,
            };
        }
        let Some(root) = &self.config.pages else { return Reply::error(404, "Anki's pages aren't in this build") };
        let route = rest.split('/').next().unwrap_or_default();
        if ["graphs", "deck-options", "card-info", "congrats"].contains(&route) {
            if route == "graphs" {
                if let Some(deck) = request.query("deck").and_then(|d| d.parse::<i64>().ok()) {
                    match self.with_engine(|engine| engine.select_deck(deck)) {
                        Ok(Ok(())) => {}
                        Ok(Err(failure)) => return Reply::new(failure.status, "text/plain", failure.detail),
                        Err(reply) => return reply,
                    }
                }
            }
            return match std::fs::read(root.join("index.html")) {
                Ok(bytes) => Reply::new(200, "text/html; charset=utf-8", bytes),
                Err(_) => Reply::error(404, "Not found"),
            };
        }
        match read_inside(root, rest) {
            Some(bytes) => Reply::new(200, mime_type(rest), bytes),
            None => Reply::error(404, "Not found"),
        }
    }

    // The API ----------------------------------------------------------------------

    fn api(&self, request: &Request, sink: &mut dyn Sink) {
        let path = request.path();
        if let Some(reply) = self.app_route(request) {
            return reply.send(sink);
        }
        match path {
            "/api/search/cards" => return self.search_cards(request).send(sink),
            "/api/stats/overview" => return self.stats_overview(request).send(sink),
            "/api/stats/reviews" => return self.review_history(request).send(sink),
            "/api/import/ankiweb-url" => return self.import_shared_deck(request).send(sink),
            _ => {}
        }
        match self.with_engine(|engine| api::handle(engine, request)) {
            Ok(Some(reply)) => return reply.send(sink),
            Ok(None) => {}
            // Anki's routes need the collection; the server's don't.
            Err(reply) if is_anki_route(path) => return reply.send(sink),
            Err(_) => {}
        }
        if self.server.base().is_none() {
            return self.local_profile(request).send(sink);
        }
        self.server.forward(request, sink);
    }

    /// `/api/app…`: the app itself (Settings → Server, the offline banner).
    fn app_route(&self, request: &Request) -> Option<Reply> {
        let path = request.path();
        if !(path == "/api/app" || path.starts_with("/api/app/")) {
            return None;
        }
        Some(match (request.method.as_str(), path) {
            ("GET", "/api/app") => Reply::ok(self.status()),
            ("GET", "/api/app/update") => Reply::ok(self.app_update()),
            ("POST", "/api/app/check") => {
                self.server.check();
                Reply::ok(self.status())
            }
            ("PUT", "/api/app/server") => {
                let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
                let url = match body["url"].as_str().map(str::trim).filter(|u| !u.is_empty()) {
                    None => None,
                    Some(url) => match normalize_server(url) {
                        Some(url) => Some(url),
                        None => return Some(Reply::error(400, format!("{url} isn't a web address"))),
                    },
                };
                let mut settings = self.settings.lock().unwrap();
                settings.server = Some(url.clone().unwrap_or_default());
                self.save_settings(&settings);
                drop(settings);
                self.server.set_base(url);
                if self.server.base().is_some() {
                    self.server.check();
                }
                Reply::ok(self.status())
            }
            _ => Reply::error(404, "Not found"),
        })
    }

    /// The newest version: from a SideStore/AltStore source, or GitHub's latest release
    /// with this platform's file (.apk on Android, .ipa on iPhone, the installer on computers).
    fn app_update(&self) -> Value {
        let current = json!({"version": self.config.version, "build": self.config.build});
        let Some(feed) = self.config.update_feed.as_deref().filter(|f| !f.is_empty()) else {
            return json!({"current": current, "latest": null, "has_update": false});
        };
        let Some(source) = self.server.fetch_json(feed) else {
            return json!({"current": current, "latest": null, "has_update": false, "error": "Couldn't check for updates"});
        };
        if source.get("tag_name").is_some() {
            // GitHub: {"tag_name": "v1.2.0", "body": …, "assets": [{"name", "browser_download_url"}]}
            let version = source["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_string();
            let suffix = if cfg!(target_os = "android") {
                ".apk"
            } else if cfg!(target_os = "windows") {
                "-setup.exe"
            } else if cfg!(target_os = "macos") {
                ".dmg"
            } else if cfg!(target_os = "linux") {
                ".AppImage"
            } else {
                ".ipa"
            };
            let file = source["assets"].as_array().and_then(|assets| {
                assets.iter().find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(suffix)))
            });
            let latest = json!({
                "version": version, "build": null, "notes": source["body"], "date": source["published_at"],
                "url": file.map(|a| a["browser_download_url"].clone()).unwrap_or(source["html_url"].clone()),
            });
            let has_update = file.is_some() && newer(&version, &self.config.version);
            return json!({"current": current, "latest": latest, "has_update": has_update, "source": feed});
        }
        let id = self.config.bundle_id.as_deref().unwrap_or("io.github.ankibase");
        let Some(app) = source["apps"].as_array().and_then(|apps| apps.iter().find(|a| a["bundleIdentifier"] == id).cloned())
        else {
            return json!({"current": current, "latest": null, "has_update": false, "error": "This app isn't in the update source"});
        };
        let release = app["versions"].get(0).cloned().unwrap_or(Value::Null);
        let latest = json!({
            "version": release["version"].as_str().or(app["version"].as_str()),
            "build": release["buildVersion"].as_str(),
            "notes": release["localizedDescription"].as_str().or(app["versionDescription"].as_str()),
            "date": release["date"].as_str(),
        });
        let number = |v: &Value| v.as_str().and_then(|b| b.parse::<u64>().ok()).unwrap_or(0);
        let has_update = number(&latest["build"]) > number(&current["build"]);
        json!({"current": current, "latest": latest, "has_update": has_update, "source": feed})
    }

    fn status(&self) -> Value {
        let server = self.server.base();
        json!({
            "native": true,
            "version": self.config.version,
            "build": self.config.build,
            "server": server,
            "default_server": self.config.default_server,
            "server_login": server.is_some() && self.server.has_login(),
            "online": server.is_some() && !self.server.offline(),
            "pending": self.server.pending(),
            "collection_error": self.engine_error,
        })
    }

    // Answers with a part from the phone and a part from the server -----------------

    fn search_cards(&self, request: &Request) -> Reply {
        let q: String = request.query("q").unwrap_or_default().trim().chars().take(200).collect();
        let limit = request.query("limit").and_then(|l| l.parse().ok()).unwrap_or(40usize);
        if q.is_empty() {
            return Reply::ok(json!({"anki": [], "quizlet": [], "anki_total": 0, "anki_error": null}));
        }
        let mut result = match self.with_engine(|engine| engine.search_cards(&q, limit)) {
            Ok(Ok(value)) => value,
            Ok(Err(failure)) => json!({"anki": [], "anki_total": 0, "anki_error": failure.detail}),
            Err(reply) => json!({"anki": [], "anki_total": 0, "anki_error": reply.value().map(|v| v["detail"].clone())}),
        };
        result["quizlet"] = self
            .server
            .get_json(&request.target)
            .and_then(|v| v.get("quizlet").cloned())
            .unwrap_or_else(|| json!([]));
        Reply::ok(result)
    }

    fn stats_overview(&self, request: &Request) -> Reply {
        let deck = request.query("deck").unwrap_or_default();
        let period = request.query("period").unwrap_or_else(|| "1m".into());
        let quizlet = request.query("quizlet").unwrap_or_else(|| "all".into());
        let quizlet_set = quizlet.parse::<i64>().is_ok();
        let use_anki = request.query("anki").as_deref() != Some("false") && !quizlet_set;
        let use_quizlet = quizlet != "none" && deck.is_empty();
        if crate::stats::period_days(&period).is_none() {
            return Reply::error(400, "Invalid period");
        }
        let mut result = json!({"period": period, "anki": null, "anki_error": null, "quizlet": null});
        if use_anki {
            match self.with_engine(|engine| engine.stats(&deck, &period)) {
                Ok(Ok((today, rollover, stats))) => {
                    result["today"] = json!(today);
                    result["rollover_hours"] = json!(rollover);
                    result["anki"] = stats;
                }
                Ok(Err(failure)) => result["anki_error"] = json!(failure.detail),
                Err(reply) => result["anki_error"] = reply.value().map(|v| v["detail"].clone()).unwrap_or_default(),
            }
        }
        if use_quizlet && self.server.base().is_some() {
            let target = request.target.replacen("anki=true", "anki=false", 1);
            if let Some(server) = self.server.get_json(&target) {
                result["quizlet"] = server["quizlet"].clone();
                if result["today"].is_null() {
                    result["today"] = server["today"].clone();
                    result["rollover_hours"] = server["rollover_hours"].clone();
                }
            }
        }
        if result["today"].is_null() {
            let today = (chrono::Local::now() - chrono::Duration::hours(4)).format("%Y-%m-%d").to_string();
            result["today"] = json!(today);
            result["rollover_hours"] = json!(4);
        }
        Reply::ok(result)
    }

    fn review_history(&self, request: &Request) -> Reply {
        let source = request.query("source").unwrap_or_else(|| "all".into());
        let deck = request.query("deck").unwrap_or_default();
        let deck = if deck == "All Decks" { String::new() } else { deck };
        let mut result = if source == "quizlet" {
            json!({"daily_counts": {}, "daily_time": {}, "hourly_counts": {}, "button_counts": {},
                   "interval_ranges": {}, "today": 0, "today_time_seconds": 0})
        } else {
            match self.with_engine(|engine| engine.review_history(&deck)) {
                Ok(Ok(value)) => value,
                Ok(Err(failure)) => return api::failure(failure),
                Err(reply) => return reply,
            }
        };
        if source != "anki" && self.server.base().is_some() {
            if let Some(server) = self.server.get_json("/api/stats/reviews?source=quizlet") {
                let today = result["today"].as_i64().unwrap_or(0);
                let mut extra_today = server["today"].as_i64().unwrap_or(0);
                if let (Some(counts), Some(theirs)) = (result["daily_counts"].as_object_mut(), server["daily_counts"].as_object()) {
                    for (day, n) in theirs {
                        let mine = counts.get(day).and_then(Value::as_i64).unwrap_or(0);
                        counts.insert(day.clone(), json!(mine + n.as_i64().unwrap_or(0)));
                    }
                } else {
                    extra_today = 0;
                }
                result["today"] = json!(today + extra_today);
            }
        }
        Reply::ok(result)
    }

    /// A shared deck from AnkiWeb: the server fetches the .apkg (AnkiWeb needs a browser
    /// for that), the phone imports it.
    fn import_shared_deck(&self, request: &Request) -> Reply {
        if self.server.base().is_none() {
            return Reply::error(503, "Importing from an AnkiWeb link needs an AnkiBase server. Download the .apkg and import the file instead.");
        }
        let (title, package) = match self.server.post_bytes("/api/import/ankiweb-url/package", request.body.clone()) {
            Ok(download) => download,
            Err(reply) => return reply,
        };
        let title = title.unwrap_or_else(|| "AnkiWeb deck".into());
        match self.with_engine(|engine| engine.import_package("shared.apkg", &package)) {
            Ok(Ok(_)) => Reply::ok(json!({"success": true, "message": format!("Successfully imported \"{title}\""),
                                          "deck_title": title})),
            Ok(Err(failure)) => api::failure(failure),
            Err(reply) => reply,
        }
    }

    // Without a server -------------------------------------------------------------

    fn user(&self) -> Value {
        let settings = self.settings.lock().unwrap();
        let profile = &settings.profile;
        json!({
            "username": "This phone",
            "is_admin": false,
            "can_add_containers": false,
            "can_edit_server_accent": false,
            "language": profile.language.clone().unwrap_or_else(|| "en".into()),
            "accent_color": profile.accent.clone().unwrap_or_else(|| DEFAULT_ACCENT.0.into()),
            "accent_hover": profile.hover.clone().unwrap_or_else(|| DEFAULT_ACCENT.1.into()),
            "has_personal_accent": profile.accent.is_some(),
            "base_colors": profile.base_colors,
            "has_personal_base_colors": profile.base_colors.is_some(),
        })
    }

    fn update_profile(&self, change: impl FnOnce(&mut Profile)) {
        let mut settings = self.settings.lock().unwrap();
        change(&mut settings.profile);
        self.save_settings(&settings);
    }

    fn local_profile(&self, request: &Request) -> Reply {
        if let Some(reply) = self.sessions.handle(request) {
            return reply;
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let text = |key: &str| body[key].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        match (request.method.as_str(), request.path()) {
            ("GET", "/api/setup/status") => Reply::ok(json!({"needs_setup": false, "has_admin": true, "has_container": true})),
            ("GET", "/api/auth/check") => Reply::ok(json!({"authenticated": true, "user": self.user()})),
            ("GET", "/api/auth/me") => Reply::ok(self.user()),
            ("POST", "/api/auth/logout") => Reply::ok(json!({"success": true})),
            ("POST", "/api/auth/change-language") => {
                let language = text("language").unwrap_or_else(|| "en".into());
                self.update_profile(|p| p.language = Some(language.clone()));
                Reply::ok(json!({"success": true, "message": "Language changed", "language": language}))
            }
            ("PATCH", "/api/auth/accent") => {
                let (accent, hover) = (text("accent"), text("hover"));
                self.update_profile(|p| {
                    p.hover = hover.or(accent.clone());
                    p.accent = accent;
                });
                Reply::ok(json!({"success": true}))
            }
            ("DELETE", "/api/auth/accent") => {
                self.update_profile(|p| {
                    p.accent = None;
                    p.hover = None;
                });
                Reply::ok(json!({"success": true, "accent": DEFAULT_ACCENT.0, "hover": DEFAULT_ACCENT.1}))
            }
            ("PATCH", "/api/auth/base-colors") => {
                let colors = body.as_object().cloned();
                self.update_profile(|p| p.base_colors = colors);
                Reply::ok(json!({"success": true}))
            }
            ("DELETE", "/api/auth/base-colors") => {
                self.update_profile(|p| p.base_colors = None);
                Reply::ok(default_base_colors())
            }
            ("GET", "/api/theme") => Reply::ok(json!({"accent": DEFAULT_ACCENT.0, "hover": DEFAULT_ACCENT.1})),
            ("GET", "/api/theme/base") => Reply::ok(default_base_colors()),
            ("GET", "/api/update/check") => {
                Reply::ok(json!({"current": self.config.version, "latest": self.config.version, "has_update": false}))
            }
            // Lists of things only a server has: empty.
            ("GET", "/api/quizlet/decks") => Reply::ok(json!({"decks": []})),
            ("GET", "/api/stories") => Reply::ok(json!({"stories": []})),
            ("GET", "/api/accounts") => Reply::ok(json!({"accounts": [], "active_account_id": null})),
            ("GET", "/api/settings/providers") => Reply::ok(json!({"providers": {}})),
            ("GET", "/api/settings/api-keys") => Reply::ok(json!({"keys": {}, "admin_keys": {}, "configured": {},
                                                                 "has_admin_key": {}, "is_env_key": {}})),
            _ => Reply::error(503, "This needs an AnkiBase server. Connect one in Settings → Server."),
        }
    }
}

fn default_base_colors() -> Value {
    json!({"bg_primary": "#1a1a2e", "bg_secondary": "#16213e", "bg_tertiary": "#0f3460",
           "text_primary": "#eeeeee", "text_secondary": "#aaaaaa"})
}

fn server_url(settings: &Settings, config: &Config) -> Option<String> {
    match &settings.server {
        None => config.default_server.clone().filter(|s| !s.is_empty()),
        Some(url) if url.is_empty() => None,
        Some(url) => Some(url.clone()),
    }
}

/// `anki.example.com` → `https://anki.example.com`; None if it isn't a web address.
fn normalize_server(url: &str) -> Option<String> {
    let url = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    let parsed = reqwest::Url::parse(&url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(url.trim_end_matches('/').to_string())
}

/// Routes the collection answers (so a closed collection is an error, not the server's).
fn is_anki_route(path: &str) -> bool {
    ["/api/decks", "/api/review/", "/api/media", "/api/notes/", "/api/import", "/api/sync", "/api/ankiweb/", "/api/cards/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// A file below `root`, never outside it.
fn read_inside(root: &Path, relative: &str) -> Option<Vec<u8>> {
    if relative.is_empty() || relative.split('/').any(|part| part == ".." || part.starts_with('.')) {
        return None;
    }
    let path = root.join(relative);
    path.is_file().then(|| std::fs::read(path).ok())?
}

impl From<Failure> for Reply {
    fn from(failure: Failure) -> Reply {
        api::failure(failure)
    }
}

/// Whether version `a` (1.2.3) is newer than `b`.
fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| v.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}
