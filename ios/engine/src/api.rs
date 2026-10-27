//! AnkiBase's HTTP API, for the requests the phone answers itself.

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::engine::{Engine, Failure, Outcome};

pub struct Reply {
    /// 0 means "not answered here": the request goes to the AnkiBase server.
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Reply {
    fn json(status: u16, value: Value) -> Reply {
        Reply { status, content_type: "application/json".into(), body: serde_json::to_vec(&value).unwrap() }
    }

    fn not_here() -> Reply {
        Reply { status: 0, content_type: String::new(), body: Vec::new() }
    }
}

#[derive(Deserialize)]
struct ReviewRequest {
    deck: String,
    card_id: Option<i64>,
    ease: Option<u8>,
}

#[derive(Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
    /// A self-hosted sync server instead of AnkiWeb.
    endpoint: Option<String>,
}

fn body<'a, T: Deserialize<'a>>(data: &'a [u8]) -> Outcome<T> {
    serde_json::from_slice(data).map_err(|e| Failure::new(422, e.to_string()))
}

/// Answer `method path` (path may carry a query) if it's one of the Anki requests.
pub fn handle(engine: &mut Engine, method: &str, path: &str, data: &[u8]) -> Reply {
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let Some(route) = path.strip_prefix("/api/") else {
        return Reply::not_here();
    };
    let segments: Vec<String> =
        route.split('/').map(|s| percent_decode_str(s).decode_utf8_lossy().into_owned()).collect();
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();

    let result: Outcome<Value> = match (method, segments.as_slice()) {
        ("GET", ["decks"]) => engine.decks(),
        ("GET", ["decks", "names"]) => engine.deck_names().map(|names| json!({"decks": names})),
        ("POST", ["review", "current"]) => body::<ReviewRequest>(data).and_then(|r| engine.current(&r.deck)),
        ("POST", ["review", "answer"]) => body::<ReviewRequest>(data).and_then(|r| match (r.card_id, r.ease) {
            (Some(card_id), Some(ease)) => engine.answer(&r.deck, card_id, ease),
            _ => Err(Failure::new(400, "card_id and ease (1-4) required")),
        }),
        ("POST", ["review", "undo"]) => body::<ReviewRequest>(data).and_then(|r| engine.undo(&r.deck)),
        ("GET", ["media-file", name]) => {
            return match engine.media_file(name) {
                Ok(bytes) => Reply { status: 200, content_type: mime_type(name).into(), body: bytes },
                Err(failure) => error(failure),
            };
        }
        ("POST", ["sync"]) => engine
            .sync()
            .map(|outcome| json!({"success": true, "message": "Sync completed", "outcome": outcome})),
        ("POST", ["sync", "full-download"]) => engine.full_sync(false).map(|_| {
            json!({"success": true, "message": "Full download completed - local data overwritten with AnkiWeb"})
        }),
        ("POST", ["sync", "full-upload"]) => engine.full_sync(true).map(|_| {
            json!({"success": true, "message": "Full upload completed - AnkiWeb overwritten with local data"})
        }),
        ("GET", ["sync", "media"]) => Ok(engine.media_status()),
        ("POST", ["ankiweb", "login"]) => body::<LoginRequest>(data)
            .and_then(|r| engine.login(r.email.trim(), &r.password, r.endpoint.filter(|e| !e.trim().is_empty())))
            .map(|_| json!({"success": true, "message": "Logged in to AnkiWeb"})),
        ("GET", ["ankiweb", "status"]) => Ok(engine.status()),
        ("DELETE", ["ankiweb", "credentials"]) => engine.logout().map(|_| json!({"success": true})),
        _ => return Reply::not_here(),
    };
    match result {
        Ok(value) => Reply::json(200, value),
        Err(failure) => error(failure),
    }
}

fn error(failure: Failure) -> Reply {
    Reply::json(failure.status, json!({"detail": failure.detail}))
}

fn mime_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "webm" => "audio/webm",
        "css" => "text/css",
        "js" => "text/javascript",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}
