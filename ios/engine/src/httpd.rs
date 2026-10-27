//! The app's core over plain HTTP on 127.0.0.1: how the Android app's WebView reaches it
//! (Android's WebView can't hand request bodies to the app the way iOS's can), and how the
//! emulator serves it on a computer.
//!
//! With a `token`, only the app's own WebView gets in: it opens `/__start?token=…` first,
//! which sets an HttpOnly cookie; every other request needs that cookie, or (for card media
//! in Anki's sandboxed card frame, which sends no cookies) `t=<token>` in the query.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use crate::app::App;
use crate::http::{Reply, Request, Sink};

const COOKIE: &str = "ankibase_app";
/// Bigger requests (a huge .apkg) are refused rather than read into memory.
const MAX_BODY: usize = 1024 * 1024 * 1024;

struct Socket(TcpStream);

impl Sink for Socket {
    fn head(&mut self, status: u16, headers: &[(String, String)]) {
        let mut head = format!("HTTP/1.1 {status} {}\r\nConnection: close\r\n", reason(status));
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

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

/// Serve `app` on `listener` until the process ends (one thread per connection).
pub fn serve(app: Arc<App>, listener: TcpListener, token: Option<String>) {
    let token = token.map(Arc::new);
    for stream in listener.incoming().flatten() {
        let (app, token) = (app.clone(), token.clone());
        std::thread::spawn(move || {
            let _ = handle(stream, &app, token.as_deref().map(String::as_str));
        });
    }
}

fn handle(stream: TcpStream, app: &App, token: Option<&str>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("GET").to_string(), parts.next().unwrap_or("/").to_string());
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let length: usize = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut sink = Socket(stream);
    if length > MAX_BODY {
        Reply::error(413, "That's too big").send(&mut sink);
        return Ok(());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let request = Request { method, target, headers, body };

    if let Some(token) = token {
        if request.path() == "/__start" {
            if request.query("token").as_deref() != Some(token) {
                Reply::error(403, "Forbidden").send(&mut sink);
                return Ok(());
            }
            let to = request.query("to").filter(|t| t.starts_with('/') && !t.starts_with("//")).unwrap_or("/".into());
            let mut reply = Reply::new(302, "text/plain", Vec::new());
            reply.headers.push(("Location".into(), to));
            reply.headers.push(("Set-Cookie".into(), format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax")));
            reply.headers.push(("Cache-Control".into(), "no-store".into()));
            reply.send(&mut sink);
            return Ok(());
        }
        if !allowed(&request, token) {
            Reply::error(401, "Not this app").send(&mut sink);
            return Ok(());
        }
    }
    app.handle(&request, &mut sink);
    Ok(())
}

fn allowed(request: &Request, token: &str) -> bool {
    let cookie = request.header("cookie").unwrap_or_default().split(';').any(|c| {
        c.trim().split_once('=').is_some_and(|(name, value)| name == COOKIE && constant_eq(value, token))
    });
    cookie
        || (request.path().starts_with("/api/media-file/")
            && request.query("t").is_some_and(|t| constant_eq(&t, token)))
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
