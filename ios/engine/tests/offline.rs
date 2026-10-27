//! The AnkiBase server through the app: its login, its answers kept for offline use, and
//! changes made offline that wait for it. And the app without any server at all.

mod common;

use common::*;
use serde_json::{json, Value};

#[test]
fn server_features_keep_working_offline() {
    let tmp = temp_dir("offline");
    let server = FakeServer::start();
    let phone = app(&tmp, Some(&server.url));

    // The web UI itself is in the app.
    let index = send(&phone, "GET", "/decks", &[], Vec::new());
    assert_eq!((index.status, index.header("content-type")), (200, Some("text/html; charset=utf-8")));
    assert_eq!(send(&phone, "GET", "/assets/app.js", &[], Vec::new()).header("content-type"), Some("text/javascript"));

    // Log in: the app keeps the cookie and sends it from then on.
    assert_eq!(call(&phone, "GET", "/api/auth/check", Value::Null).0, 401);
    ok(&phone, "POST", "/api/auth/login", json!({"username": "dionis", "password": "pw"}));
    assert_eq!(ok(&phone, "GET", "/api/auth/check", Value::Null)["authenticated"], true);
    assert_eq!(server.seen().last().unwrap().cookie.as_deref(), Some("session_id=abc"));
    let status = ok(&phone, "GET", "/api/app", Value::Null);
    assert_eq!((status["online"].clone(), status["server_login"].clone()), (json!(true), json!(true)));

    ok(&phone, "GET", "/api/stories?limit=100&offset=0", Value::Null);
    ok(&phone, "GET", "/api/sessions", Value::Null);
    ok(&phone, "GET", "/api/sessions/anki/French", Value::Null);
    assert_eq!(ok(&phone, "GET", "/api/quizlet/decks/7/favorites", Value::Null)["card_ids"], json!([]));

    // Streams (the server update's progress) arrive as they're sent.
    let stream = send(&phone, "GET", "/api/update/apply", &[("accept", "text/event-stream")], Vec::new());
    assert_eq!(stream.header("content-type"), Some("text/event-stream"));
    assert_eq!(String::from_utf8_lossy(&stream.body), "data: step 1\n\ndata: step 2\n\ndata: step 3\n\n");

    // Offline: what the server said last, marked as such.
    server.set_down(true);
    let before = server.seen().len();
    let stories = send(&phone, "GET", "/api/stories?limit=100&offset=0", &[], Vec::new());
    assert_eq!(stories.status, 200);
    assert_eq!(stories.header("x-ankibase-offline"), Some("1"));
    assert_eq!(stories.json()["stories"][0]["name"], "Au marché");
    assert_eq!(ok(&phone, "GET", "/api/auth/check", Value::Null)["authenticated"], true);
    assert_eq!(ok(&phone, "GET", "/api/app", Value::Null)["online"], false);
    // Never seen: an honest "offline".
    let (status, error) = call(&phone, "GET", "/api/stories/99", Value::Null);
    assert_eq!(status, 503);
    assert!(error["detail"].as_str().unwrap().contains("offline"));
    // Work that needs the server can't be faked.
    assert_eq!(call(&phone, "POST", "/api/story/generate", json!({"words": ["chat"]})).0, 503);

    // Progress made offline is kept, shown, and queued.
    ok(&phone, "PUT", "/api/sessions/anki/French", json!({"title": "French", "progress_done": 3, "progress_total": 10, "state": {"seen": [1, 2, 3]}}));
    ok(&phone, "PUT", "/api/sessions/anki/French", json!({"title": "French", "progress_done": 4, "progress_total": 10}));
    let session = ok(&phone, "GET", "/api/sessions/anki/French", Value::Null)["session"].clone();
    assert_eq!(session["progress_done"], 4);
    assert_eq!(session["state"], json!({"seen": [1, 2, 3]}), "a save without state keeps the saved state");
    assert_eq!(ok(&phone, "GET", "/api/sessions", Value::Null)["sessions"][0]["title"], "French");
    assert_eq!(ok(&phone, "POST", "/api/quizlet/decks/7/favorites/42", Value::Null)["favorited"], true);
    assert_eq!(ok(&phone, "GET", "/api/quizlet/decks/7/favorites", Value::Null)["card_ids"], json!([42]));
    assert_eq!(ok(&phone, "GET", "/api/app", Value::Null)["pending"], 3);
    assert_eq!(server.seen().len(), before, "nothing reached the server while it was down");

    // Back online: the queue goes out in order, then live requests continue.
    server.set_down(false);
    let status = ok(&phone, "POST", "/api/app/check", Value::Null);
    assert_eq!((status["online"].clone(), status["pending"].clone()), (json!(true), json!(0)));
    let sent: Vec<(String, String)> = server.seen()[before..]
        .iter()
        .filter(|s| s.method != "GET")
        .map(|s| (s.method.clone(), s.target.clone()))
        .collect();
    assert_eq!(sent, vec![
        ("PUT".to_string(), "/api/sessions/anki/French".to_string()),
        ("PUT".to_string(), "/api/sessions/anki/French".to_string()),
        ("POST".to_string(), "/api/quizlet/decks/7/favorites/42".to_string()),
    ]);
    assert_eq!(ok(&phone, "GET", "/api/sessions/anki/French", Value::Null)["session"]["progress_done"], 4);
    assert_eq!(ok(&phone, "GET", "/api/quizlet/decks/7/favorites", Value::Null)["card_ids"], json!([42]));

    // Search and stats: the phone's Anki part, the server's Quizlet part.
    let found = ok(&phone, "GET", "/api/search/cards?q=chat", Value::Null);
    assert_eq!(found["quizlet"][0]["front"], "le chat");
    assert_eq!(found["anki"], json!([]), "Anki hits come from the phone, not the server");
    let stats = ok(&phone, "GET", "/api/stats/overview?deck=&anki=true&quizlet=all&period=1m&tz=UTC", Value::Null);
    assert_eq!(stats["quizlet"]["today"]["answers"], 3);
    assert_eq!(stats["anki"]["card_counts"]["total"], 0);
    let history = ok(&phone, "GET", "/api/stats/reviews?source=all", Value::Null);
    assert_eq!(history["daily_counts"]["2026-10-01"], 5);

    // A server that takes the connection but never answers: the kept answer, quickly.
    server.hang.store(true, std::sync::atomic::Ordering::SeqCst);
    let started = std::time::Instant::now();
    let stories = send(&phone, "GET", "/api/stories?limit=100&offset=0", &[], Vec::new());
    assert_eq!((stories.status, stories.header("x-ankibase-offline")), (200, Some("1")));
    assert!(started.elapsed() < std::time::Duration::from_secs(8), "took {:?}", started.elapsed());
    // …and from then on without waiting at all.
    let started = std::time::Instant::now();
    assert_eq!(call(&phone, "GET", "/api/auth/check", Value::Null).0, 200);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    server.hang.store(false, std::sync::atomic::Ordering::SeqCst);
    ok(&phone, "POST", "/api/app/check", Value::Null);

    // Logging out forgets the login and everything kept.
    ok(&phone, "POST", "/api/auth/logout", Value::Null);
    server.set_down(true);
    assert_eq!(call(&phone, "GET", "/api/stories?limit=100&offset=0", Value::Null).0, 503);
    assert_eq!(ok(&phone, "GET", "/api/app", Value::Null)["server_login"], false);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn the_phone_on_its_own() {
    let tmp = temp_dir("alone");
    let phone = app(&tmp, None);
    let status = ok(&phone, "GET", "/api/app", Value::Null);
    assert_eq!((status["server"].clone(), status["native"].clone()), (Value::Null, json!(true)));

    let check = ok(&phone, "GET", "/api/auth/check", Value::Null);
    assert_eq!(check["authenticated"], true);
    assert_eq!(check["user"]["is_admin"], false);
    assert_eq!(ok(&phone, "GET", "/api/setup/status", Value::Null)["needs_setup"], false);

    // The profile is kept on the phone.
    ok(&phone, "PATCH", "/api/auth/accent", json!({"accent": "#3b82f6", "hover": "#60a5fa"}));
    ok(&phone, "POST", "/api/auth/change-language", json!({"language": "de"}));
    ok(&phone, "PATCH", "/api/auth/base-colors", json!({"bg_primary": "#ffffff"}));
    drop(phone);
    let phone = ankibase_engine::App::start(ankibase_engine::Config {
        dir: tmp.clone(), web: None, pages: None, default_server: Some("https://anki.example.com".into()),
        version: "0".into(), build: "0".into(), update_feed: None,
    });
    let user = ok(&phone, "GET", "/api/auth/me", Value::Null);
    assert_eq!((user["accent_color"].clone(), user["language"].clone()), (json!("#3b82f6"), json!("de")));
    assert_eq!(user["base_colors"]["bg_primary"], "#ffffff");
    assert!(ok(&phone, "GET", "/api/app", Value::Null)["server"].is_null(), "choosing no server sticks");

    // Sessions are the phone's own.
    ok(&phone, "PUT", "/api/sessions/anki/Spanish", json!({"title": "Spanish", "progress_done": 1, "progress_total": 5, "state": {"x": 1}}));
    assert_eq!(ok(&phone, "GET", "/api/sessions", Value::Null)["sessions"][0]["ref_id"], "Spanish");
    assert_eq!(ok(&phone, "GET", "/api/sessions/anki/Spanish", Value::Null)["session"]["state"], json!({"x": 1}));
    ok(&phone, "PUT", "/api/sessions/anki/Spanish", json!({"title": "Spanish", "status": "completed"}));
    assert_eq!(ok(&phone, "GET", "/api/sessions", Value::Null)["sessions"], json!([]));
    ok(&phone, "DELETE", "/api/sessions/anki/Spanish", Value::Null);
    assert!(ok(&phone, "GET", "/api/sessions/anki/Spanish", Value::Null)["session"].is_null());

    // Server-only features: empty lists, and a clear message for the rest.
    assert_eq!(ok(&phone, "GET", "/api/quizlet/decks", Value::Null)["decks"], json!([]));
    let (status, error) = call(&phone, "POST", "/api/story/generate", json!({}));
    assert_eq!(status, 503);
    assert!(error["detail"].as_str().unwrap().contains("Settings"));
    assert_eq!(call(&phone, "POST", "/api/import/ankiweb-url", json!({"url": "https://ankiweb.net/shared/info/1"})).0, 503);

    // Connecting a server.
    let server = FakeServer::start();
    let (status, _) = call(&phone, "PUT", "/api/app/server", json!({"url": "not a url at all"}));
    assert_eq!(status, 400);
    let status = ok(&phone, "PUT", "/api/app/server", json!({"url": format!("{}/", server.url)}));
    assert_eq!((status["server"].clone(), status["online"].clone()), (json!(server.url), json!(true)));
    assert_eq!(call(&phone, "GET", "/api/auth/check", Value::Null).0, 401);
    let _ = std::fs::remove_dir_all(&tmp);
}
