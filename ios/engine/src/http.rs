//! Requests from the web view and the replies streamed back to it.

use percent_encoding::percent_decode_str;
use serde_json::{json, Value};

pub struct Request {
    pub method: String,
    /// Path and query, as the web view asked for it (`/api/decks?x=1`).
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn new(method: &str, target: &str, body: impl Into<Vec<u8>>) -> Request {
        Request { method: method.into(), target: target.into(), headers: Vec::new(), body: body.into() }
    }

    pub fn path(&self) -> &str {
        self.target.split(['?', '#']).next().unwrap_or_default()
    }

    /// A query parameter, decoded.
    pub fn query(&self, key: &str) -> Option<String> {
        let query = self.target.split_once('?')?.1.split('#').next().unwrap_or_default();
        query.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(name) == key).then(|| decode(value))
        })
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// The path's segments after `prefix`, decoded.
    pub fn segments(&self, prefix: &str) -> Option<Vec<String>> {
        let rest = self.path().strip_prefix(prefix)?;
        Some(rest.split('/').map(decode).collect())
    }
}

/// Decode a URL component (`+` is a space in a query).
pub fn decode(text: &str) -> String {
    percent_decode_str(&text.replace('+', " ")).decode_utf8_lossy().into_owned()
}

/// Where a reply goes: the web view on the phone, a socket in the emulator.
pub trait Sink {
    fn head(&mut self, status: u16, headers: &[(String, String)]);
    /// Returns false when nobody is listening any more.
    fn data(&mut self, bytes: &[u8]) -> bool;
}

/// A complete reply.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Reply {
        Reply { status, headers: vec![("Content-Type".into(), content_type.into())], body: body.into() }
    }

    pub fn json(status: u16, value: &Value) -> Reply {
        Reply::new(status, "application/json", serde_json::to_vec(value).unwrap())
    }

    pub fn ok(value: Value) -> Reply {
        Reply::json(200, &value)
    }

    pub fn error(status: u16, detail: impl Into<String>) -> Reply {
        Reply::json(status, &json!({"detail": detail.into()}))
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn content_type(&self) -> &str {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| v.as_str())
            .unwrap_or("application/octet-stream")
    }

    pub fn send(self, sink: &mut dyn Sink) {
        sink.head(self.status, &self.headers);
        if !self.body.is_empty() {
            sink.data(&self.body);
        }
    }

    /// The body as JSON, when it is JSON.
    pub fn value(&self) -> Option<Value> {
        self.content_type().starts_with("application/json").then(|| serde_json::from_slice(&self.body).ok())?
    }
}

/// Collects a reply in memory (tests, and merging the server's answer into the phone's).
#[derive(Default)]
pub struct Collect {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Sink for Collect {
    fn head(&mut self, status: u16, headers: &[(String, String)]) {
        self.status = status;
        self.headers = headers.to_vec();
    }

    fn data(&mut self, bytes: &[u8]) -> bool {
        self.body.extend_from_slice(bytes);
        true
    }
}

impl Collect {
    pub fn into_reply(self) -> Reply {
        Reply { status: self.status, headers: self.headers, body: self.body }
    }
}

pub fn mime_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "webm" => "audio/webm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}
