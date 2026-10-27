//! The core over HTTP with an access token, as the Android app runs it: only a client that
//! opened /__start with the token (and so has its cookie) gets in.

mod common;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use common::*;

fn get(port: u16, target: &str, cookie: Option<&str>) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let cookie = cookie.map(|c| format!("Cookie: {c}\r\n")).unwrap_or_default();
    write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n{cookie}\r\n").unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let status = answer.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, answer)
}

#[test]
fn only_the_app_gets_in() {
    let tmp = temp_dir("httpd");
    let app = Arc::new(app(&tmp, None));
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = "a".repeat(64);
    let serve_token = token.clone();
    std::thread::spawn(move || ankibase_engine::httpd::serve(app, listener, Some(serve_token)));

    // Strangers (another app on the phone) get nothing.
    assert_eq!(get(port, "/", None).0, 401);
    assert_eq!(get(port, "/api/decks", None).0, 401);
    assert_eq!(get(port, "/api/decks", Some("ankibase_app=wrong")).0, 401);
    assert_eq!(get(port, "/__start?token=wrong", None).0, 403);

    // The app's WebView: /__start sets the cookie and sends it on.
    let (status, answer) = get(port, &format!("/__start?token={token}&to=/settings"), None);
    assert_eq!(status, 302);
    assert!(answer.contains("Location: /settings"), "{answer}");
    assert!(answer.contains(&format!("Set-Cookie: ankibase_app={token}; Path=/; HttpOnly")), "{answer}");
    // Never redirected off the app.
    assert!(get(port, &format!("/__start?token={token}&to=//evil.example"), None).1.contains("Location: /\r\n"));

    let cookie = format!("ankibase_app={token}");
    let (status, page) = get(port, "/", Some(&cookie));
    assert_eq!(status, 200);
    assert!(page.contains("<title>AnkiBase</title>"));
    assert_eq!(get(port, "/api/decks", Some(&cookie)).0, 200);

    // Card media from Anki's sandboxed frame carries the token instead of the cookie.
    assert_eq!(get(port, "/api/media-file/missing.png", None).0, 401);
    assert_eq!(get(port, &format!("/api/media-file/missing.png?t={token}"), None).0, 404);
    assert_eq!(get(port, &format!("/api/decks?t={token}"), None).0, 401, "the token only opens media");
    let _ = std::fs::remove_dir_all(&tmp);
}
