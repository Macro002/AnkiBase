//! AnkiBase's HTTP API for Anki, answered from the collection on the phone.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::engine::{Engine, Failure, Outcome};
use crate::http::{mime_type, Reply, Request};

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

#[derive(Deserialize)]
struct DeckName {
    deck_name: String,
}

#[derive(Deserialize)]
struct Rename {
    old_name: String,
    new_name: String,
}

#[derive(Deserialize)]
struct Fields {
    fields: Map<String, Value>,
}

#[derive(Deserialize)]
struct FrontBack {
    front: String,
    back: String,
}

fn body<'a, T: Deserialize<'a>>(data: &'a [u8]) -> Outcome<T> {
    serde_json::from_slice(data).map_err(|e| Failure::new(422, e.to_string()))
}

pub fn failure(failure: Failure) -> Reply {
    Reply::error(failure.status, failure.detail)
}

/// Answer `request` if it's one of Anki's; None sends it on (to the AnkiBase server).
pub fn handle(engine: &mut Engine, request: &Request) -> Option<Reply> {
    let segments = request.segments("/api/")?;
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
    let data = request.body.as_slice();
    let query = |key: &str| request.query(key).unwrap_or_default();

    let result: Outcome<Value> = match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["decks"]) => engine.decks(),
        ("GET", ["decks", "names"]) => engine.deck_names().map(|names| json!({"decks": names})),
        ("GET", ["decks", deck, "words"]) => {
            let limit = query("limit").parse().unwrap_or(500).min(5000);
            engine.deck_words(deck, limit, &query("field"))
        }
        ("POST", ["decks", "delete"]) => body::<DeckName>(data).and_then(|r| engine.delete_deck(&r.deck_name)),
        ("POST", ["decks", "rename"]) => body::<Rename>(data).and_then(|r| engine.rename_deck(&r.old_name, &r.new_name)),
        ("POST", ["review", "current"]) => body::<ReviewRequest>(data).and_then(|r| engine.current(&r.deck)),
        ("POST", ["review", "answer"]) => body::<ReviewRequest>(data).and_then(|r| match (r.card_id, r.ease) {
            (Some(card_id), Some(ease)) => engine.answer(&r.deck, card_id, ease),
            _ => Err(Failure::new(400, "card_id and ease (1-4) required")),
        }),
        ("POST", ["review", "undo"]) => body::<ReviewRequest>(data).and_then(|r| engine.undo(&r.deck)),
        ("GET", ["media-file", name]) => {
            return Some(match engine.media_file(name) {
                Ok(bytes) => Reply::new(200, mime_type(name), bytes)
                    .with_header("Cache-Control", "max-age=3600")
                    // Card media is from anywhere: a file opened on its own can't run scripts.
                    .with_header("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"),
                Err(err) => failure(err),
            });
        }
        ("GET", ["media", name]) => engine.media_base64(name),
        ("GET", ["cards", id]) if id.parse::<i64>().is_ok() => engine.card_info(id.parse().unwrap()),
        ("PUT", ["notes", id, "fields"]) => match id.parse::<i64>() {
            Ok(id) => body::<Fields>(data).and_then(|r| engine.update_note_fields(id, &r.fields)),
            Err(_) => Err(Failure::new(400, "Invalid note id")),
        },
        ("POST", ["notes", "basic"]) => {
            body::<FrontBack>(data).and_then(|r| engine.add_basic_note(&query("deck"), &r.front, &r.back))
        }
        ("POST", ["import"]) => match multipart_file(request) {
            Some((name, bytes)) => engine.import_package(&name, &bytes),
            None => Err(Failure::new(400, "Send the .apkg file as multipart form data (field \"file\")")),
        },
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
            .map(|_| json!({"success": true, "message": "Logged in"})),
        ("GET", ["ankiweb", "status"]) => Ok(engine.status()),
        ("DELETE", ["ankiweb", "credentials"]) => engine.logout().map(|_| json!({"success": true})),
        _ => return None,
    };
    Some(match result {
        Ok(value) => Reply::ok(value),
        Err(err) => failure(err),
    })
}

/// The `file` field of a multipart/form-data body: (file name, contents).
fn multipart_file(request: &Request) -> Option<(String, Vec<u8>)> {
    let content_type = request.header("content-type")?;
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("boundary="))?
        .trim_matches('"');
    let delimiter = format!("--{boundary}").into_bytes();
    let body = &request.body;
    let mut start = find(body, &delimiter, 0)? + delimiter.len();
    loop {
        let end = find(body, &delimiter, start)?;
        // Each part: CRLF, headers, CRLF CRLF, contents, CRLF.
        let part = &body[start..end];
        let part = part.strip_prefix(b"\r\n").unwrap_or(part);
        if let Some(split) = find(part, b"\r\n\r\n", 0) {
            let headers = String::from_utf8_lossy(&part[..split]);
            let contents = &part[split + 4..];
            let contents = contents.strip_suffix(b"\r\n").unwrap_or(contents);
            let disposition = headers
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("content-disposition"))
                .unwrap_or_default();
            let param = |key: &str| {
                disposition.split(';').map(str::trim).find_map(|p| {
                    p.strip_prefix(&format!("{key}=")).map(|v| v.trim_matches('"').to_string())
                })
            };
            if param("name").as_deref() == Some("file") {
                return Some((param("filename").unwrap_or_else(|| "deck.apkg".into()), contents.to_vec()));
            }
        }
        start = end + delimiter.len();
        if body[start..].starts_with(b"--") {
            return None;
        }
    }
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}
