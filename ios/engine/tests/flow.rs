//! Two devices sharing one collection through Anki's own sync server, entirely through
//! the API the app's web view uses.

use std::path::Path;

use ankibase_engine::{handle, Engine};
use anki::sync::http_server::{SimpleServer, SyncServerConfig};
use serde_json::{json, Value};

fn call(engine: &mut Engine, method: &str, path: &str, body: Value) -> (u16, Value) {
    let data = if body.is_null() { Vec::new() } else { serde_json::to_vec(&body).unwrap() };
    let reply = handle(engine, method, path, &data);
    let value = if reply.status == 0 || reply.content_type != "application/json" {
        Value::Null
    } else {
        serde_json::from_slice(&reply.body).unwrap()
    };
    (reply.status, value)
}

fn ok(engine: &mut Engine, method: &str, path: &str, body: Value) -> Value {
    let (status, value) = call(engine, method, path, body);
    assert_eq!(status, 200, "{method} {path}: {value}");
    value
}

fn start_sync_server(base: &Path) -> String {
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

fn add_cards(engine: &mut Engine, deck: &str, fronts: &[&str]) {
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
}

fn wait_for_media(engine: &mut Engine) {
    for _ in 0..200 {
        let status = ok(engine, "GET", "/api/sync/media", Value::Null);
        if status["active"] == false {
            assert!(status["error"].is_null(), "media sync failed: {status}");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("media sync didn't finish");
}

#[test]
fn two_devices_share_a_collection() {
    let tmp = std::env::temp_dir().join(format!("ankibase-engine-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let endpoint = start_sync_server(&tmp.join("server"));
    let login = json!({"email": " user@example.com ", "password": "secret", "endpoint": endpoint});

    // Desktop: a collection with cards and media, uploaded first.
    let mut desktop = Engine::open(tmp.join("desktop")).unwrap();
    assert_eq!(ok(&mut desktop, "GET", "/api/ankiweb/status", Value::Null)["configured"], false);
    let (status, _) = call(&mut desktop, "POST", "/api/sync", Value::Null);
    assert_eq!(status, 503);
    let (status, _) = call(&mut desktop, "POST", "/api/ankiweb/login",
                           json!({"email": "user@example.com", "password": "wrong", "endpoint": endpoint}));
    assert_eq!(status, 401);
    ok(&mut desktop, "POST", "/api/ankiweb/login", login.clone());
    let status = ok(&mut desktop, "GET", "/api/ankiweb/status", Value::Null);
    assert_eq!(status["email"], "user@example.com");
    add_cards(&mut desktop, "French::Verbs", &["être", "avoir", "aller"]);
    // The server is empty, so the first sync uploads without asking.
    assert_eq!(ok(&mut desktop, "POST", "/api/sync", Value::Null)["outcome"], "fullUpload");
    wait_for_media(&mut desktop);

    // Phone: empty, so its first sync downloads everything.
    let mut phone = Engine::open(tmp.join("phone")).unwrap();
    ok(&mut phone, "POST", "/api/ankiweb/login", login.clone());
    assert_eq!(ok(&mut phone, "POST", "/api/sync", Value::Null)["outcome"], "fullDownload");
    wait_for_media(&mut phone);

    let decks = ok(&mut phone, "GET", "/api/decks", Value::Null);
    let verbs = decks["decks"]["French::Verbs"].as_i64().expect("deck synced");
    assert_eq!(decks["stats"][verbs.to_string()]["new_count"], 3);
    assert!(ok(&mut phone, "GET", "/api/decks/names", Value::Null)["decks"]["French"].is_i64());

    // Study the parent deck: Anki's queue, rendering and button labels.
    let review = ok(&mut phone, "POST", "/api/review/current", json!({"deck": "French"}));
    assert_eq!(review["counts"], json!({"new": 3, "learn": 0, "review": 0}));
    let card = &review["card"];
    assert_eq!(card["question"], "être");
    assert!(card["answer"].as_str().unwrap().contains("back of être"));
    assert_eq!(card["deck"], "French::Verbs");
    assert_eq!(card["fields"][0], json!({"name": "Front", "value": "être"}));
    assert_eq!(card["next_reviews"].as_array().unwrap().len(), 4);
    assert!(!card["next_reviews"][0].as_str().unwrap().contains('\u{2068}'));
    let first = card["card_id"].as_i64().unwrap();

    // A stale answer (wrong card) changes nothing.
    let same = ok(&mut phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": 1, "ease": 3}));
    assert_eq!(same["card"]["card_id"], first);
    let (status, _) = call(&mut phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 9}));
    assert_eq!(status, 400);

    let next = ok(&mut phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 3}));
    assert_eq!(next["card"]["question"], "avoir");
    assert_eq!(next["counts"]["new"], 2);
    let undone = ok(&mut phone, "POST", "/api/review/undo", json!({"deck": "French"}));
    assert_eq!(undone["card"]["card_id"], first);
    let mut current = ok(&mut phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 4}));
    while let Some(id) = current["card"]["card_id"].as_i64() {
        current = ok(&mut phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": id, "ease": 4}));
    }
    assert_eq!(current["counts"], json!({"new": 0, "learn": 0, "review": 0}));

    // Media is served from the phone.
    let reply = handle(&mut phone, "GET", "/api/media-file/pic.png?t=local", &[]);
    assert_eq!((reply.status, reply.content_type.as_str(), reply.body.as_slice()),
               (200, "image/png", &b"not really a png"[..]));
    assert_eq!(handle(&mut phone, "GET", "/api/media-file/..%2Fcollection.anki2", &[]).status, 400);
    assert_eq!(handle(&mut phone, "GET", "/api/media-file/missing.png", &[]).status, 404);

    // The reviews go up with a normal sync and reach the desktop.
    assert_eq!(ok(&mut phone, "POST", "/api/sync", Value::Null)["outcome"], "ok");
    assert_eq!(ok(&mut desktop, "POST", "/api/sync", Value::Null)["outcome"], "ok");
    let decks = ok(&mut desktop, "GET", "/api/decks", Value::Null);
    assert_eq!(decks["stats"][verbs.to_string()]["new_count"], 0);

    // Requests that aren't Anki's go to the server.
    assert_eq!(handle(&mut phone, "GET", "/api/stories?limit=5", &[]).status, 0);
    assert_eq!(handle(&mut phone, "GET", "/index.html", &[]).status, 0);

    ok(&mut phone, "DELETE", "/api/ankiweb/credentials", Value::Null);
    assert_eq!(ok(&mut phone, "GET", "/api/ankiweb/status", Value::Null)["configured"], false);
    let _ = std::fs::remove_dir_all(&tmp);
}
