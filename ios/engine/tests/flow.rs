//! Two devices sharing one collection through Anki's own sync server, and everything the
//! app does with the collection, entirely through the API the app's web view uses.

mod common;

use common::*;
use serde_json::{json, Value};

fn wait_for_media(app: &ankibase_engine::App) {
    for _ in 0..200 {
        let status = ok(app, "GET", "/api/sync/media", Value::Null);
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
    let tmp = temp_dir("flow");
    let endpoint = start_sync_server(&tmp.join("server"));
    let login = json!({"email": " user@example.com ", "password": "secret", "endpoint": endpoint.trim_end_matches('/')});

    // Desktop: a collection with cards and media, uploaded first.
    let desktop = app(&tmp.join("desktop"), None);
    assert_eq!(ok(&desktop, "GET", "/api/ankiweb/status", Value::Null)["configured"], false);
    let (status, _) = call(&desktop, "POST", "/api/sync", Value::Null);
    assert_eq!(status, 503);
    let (status, _) = call(&desktop, "POST", "/api/ankiweb/login",
                           json!({"email": "user@example.com", "password": "wrong", "endpoint": endpoint}));
    assert_eq!(status, 401);
    let (status, _) = call(&desktop, "POST", "/api/ankiweb/login",
                           json!({"email": "user@example.com", "password": "secret", "endpoint": "ftp://nope"}));
    assert_eq!(status, 400);
    ok(&desktop, "POST", "/api/ankiweb/login", login.clone());
    let status = ok(&desktop, "GET", "/api/ankiweb/status", Value::Null);
    assert_eq!(status["email"], "user@example.com");
    // A self-hosted server is remembered (with Anki's trailing slash).
    assert_eq!(status["endpoint"], endpoint);
    add_cards(&desktop, "French::Verbs", &["être", "avoir", "aller"]);
    // The server is empty, so the first sync uploads without asking.
    assert_eq!(ok(&desktop, "POST", "/api/sync", Value::Null)["outcome"], "fullUpload");
    wait_for_media(&desktop);

    // Phone: empty, so its first sync downloads everything.
    let phone = app(&tmp.join("phone"), None);
    ok(&phone, "POST", "/api/ankiweb/login", login.clone());
    assert_eq!(ok(&phone, "POST", "/api/sync", Value::Null)["outcome"], "fullDownload");
    wait_for_media(&phone);

    let decks = ok(&phone, "GET", "/api/decks", Value::Null);
    let verbs = decks["decks"]["French::Verbs"].as_i64().expect("deck synced");
    assert_eq!(decks["stats"][verbs.to_string()]["new_count"], 3);
    assert!(ok(&phone, "GET", "/api/decks/names", Value::Null)["decks"]["French"].is_i64());

    // Study the parent deck: Anki's queue, rendering and button labels.
    let review = ok(&phone, "POST", "/api/review/current", json!({"deck": "French"}));
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
    let same = ok(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": 1, "ease": 3}));
    assert_eq!(same["card"]["card_id"], first);
    let (status, _) = call(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 9}));
    assert_eq!(status, 400);

    let next = ok(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 3}));
    assert_eq!(next["card"]["question"], "avoir");
    assert_eq!(next["counts"]["new"], 2);
    let undone = ok(&phone, "POST", "/api/review/undo", json!({"deck": "French"}));
    assert_eq!(undone["card"]["card_id"], first);
    let mut current = ok(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 4}));
    while let Some(id) = current["card"]["card_id"].as_i64() {
        current = ok(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": id, "ease": 4}));
    }
    assert_eq!(current["counts"], json!({"new": 0, "learn": 0, "review": 0}));

    // Media is served from the phone.
    let media = send(&phone, "GET", "/api/media-file/pic.png?t=local", &[], Vec::new());
    assert_eq!((media.status, media.header("content-type"), media.body.as_slice()),
               (200, Some("image/png"), &b"not really a png"[..]));
    assert_eq!(send(&phone, "GET", "/api/media-file/..%2Fcollection.anki2", &[], Vec::new()).status, 400);
    assert_eq!(send(&phone, "GET", "/api/media-file/missing.png", &[], Vec::new()).status, 404);
    assert_eq!(ok(&phone, "GET", "/api/media/pic.png", Value::Null)["data"], "bm90IHJlYWxseSBhIHBuZw==");

    // The reviews go up with a normal sync and reach the desktop.
    assert_eq!(ok(&phone, "POST", "/api/sync", Value::Null)["outcome"], "ok");
    assert_eq!(ok(&desktop, "POST", "/api/sync", Value::Null)["outcome"], "ok");
    let decks = ok(&desktop, "GET", "/api/decks", Value::Null);
    assert_eq!(decks["stats"][verbs.to_string()]["new_count"], 0);

    // The phone's stats know about the reviews, offline.
    let stats = ok(&phone, "GET", "/api/stats/overview?deck=&anki=true&quizlet=all&period=1m&tz=UTC", Value::Null);
    // Three answers: the undone one doesn't count.
    assert_eq!(stats["anki"]["today"]["reviews"], 3);
    assert_eq!(stats["anki"]["card_counts"]["total"], 3);
    assert_eq!(stats["anki"]["calendar"][stats["today"].as_str().unwrap()], 3);
    assert!(stats["quizlet"].is_null(), "no server, no Quizlet");
    let history = ok(&phone, "GET", "/api/stats/reviews?source=all", Value::Null);
    assert_eq!(history["today"], 3);

    ok(&phone, "DELETE", "/api/ankiweb/credentials", Value::Null);
    assert_eq!(ok(&phone, "GET", "/api/ankiweb/status", Value::Null)["configured"], false);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn notes_decks_search_and_import() {
    let tmp = temp_dir("notes");
    let phone = app(&tmp.join("phone"), None);
    add_cards(&phone, "Français::Vocabulaire", &["la <b>maison</b>", "être", "le chat"]);

    // Words for a story, from the deck's word field.
    let words = ok(&phone, "GET", "/api/decks/Fran%C3%A7ais%3A%3AVocabulaire/words?limit=10", Value::Null);
    assert_eq!(words["field_used"], "Front");
    assert_eq!(words["words"], json!(["la maison", "être", "le chat"]));
    assert_eq!(words["category_counts"]["new"], 3);
    assert_eq!(words["word_data"]["être"]["category"], "new");
    assert_eq!(words["available_fields"], json!(["Front", "Back"]));

    // Search ignores accents and puts the best match first.
    let found = ok(&phone, "GET", "/api/search/cards?q=etre", Value::Null);
    assert_eq!(found["anki_total"], 1);
    let hit = &found["anki"][0];
    assert_eq!(hit["fields"][0]["value"], "être");
    assert_eq!(hit["deck"], "Français::Vocabulaire");
    assert_eq!(hit["state"], "new");
    assert_eq!(found["quizlet"], json!([]));

    // Edit a note, add one.
    let nid = hit["note_id"].as_i64().unwrap();
    ok(&phone, "PUT", &format!("/api/notes/{nid}/fields"), json!({"fields": {"Back": "to be"}}));
    let (status, _) = call(&phone, "PUT", &format!("/api/notes/{nid}/fields"), json!({"fields": {"Nope": "x"}}));
    assert_eq!(status, 400);
    let added = ok(&phone, "POST", "/api/notes/basic?deck=Fran%C3%A7ais%3A%3AVocabulaire", json!({"front": "avoir", "back": "to have"}));
    assert!(added["note_id"].as_i64().unwrap() > 0);
    let found = ok(&phone, "GET", "/api/search/cards?q=to%20be", Value::Null);
    assert_eq!(found["anki"][0]["fields"][1]["value"], "to be");

    // Rename, export an .apkg, delete, and import it back.
    ok(&phone, "POST", "/api/decks/rename", json!({"old_name": "Français::Vocabulaire", "new_name": "Français::Mots"}));
    let names = ok(&phone, "GET", "/api/decks/names", Value::Null);
    assert!(names["decks"]["Français::Mots"].is_i64());
    let package = tmp.join("mots.apkg");
    phone
        .with_engine(|engine| {
            let options = anki_proto::import_export::ExportAnkiPackageOptions {
                with_scheduling: true, with_deck_configs: true, with_media: true, legacy: false,
            };
            engine.col().unwrap().export_apkg(&package, options, "deck:Français", None).unwrap();
        })
        .unwrap_or_else(|_| panic!("no engine"));
    ok(&phone, "POST", "/api/decks/delete", json!({"deck_name": "Français"}));
    assert!(ok(&phone, "GET", "/api/decks/names", Value::Null)["decks"]["Français::Mots"].is_null());

    let boundary = "----AnkiBaseTest";
    let mut form = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"mots.apkg\"\r\n\
                            Content-Type: application/octet-stream\r\n\r\n").into_bytes();
    form.extend(std::fs::read(&package).unwrap());
    form.extend(format!("\r\n--{boundary}--\r\n").into_bytes());
    let content_type = format!("multipart/form-data; boundary={boundary}");
    let answer = send(&phone, "POST", "/api/import", &[("content-type", &content_type)], form);
    assert_eq!(answer.status, 200, "{}", String::from_utf8_lossy(&answer.body));
    assert!(answer.json()["message"].as_str().unwrap().contains("4 new notes"));
    let decks = ok(&phone, "GET", "/api/decks", Value::Null);
    let mots = decks["decks"]["Français::Mots"].as_i64().expect("imported");
    assert_eq!(decks["stats"][mots.to_string()]["new_count"], 4);
    let answer = send(&phone, "POST", "/api/import", &[("content-type", &content_type)], b"junk".to_vec());
    assert_eq!(answer.status, 400);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn anki_pages_talk_to_the_collection() {
    use prost::Message;
    let tmp = temp_dir("pages");
    let pages = tmp.join("pages");
    std::fs::create_dir_all(pages.join("_app/immutable")).unwrap();
    std::fs::write(pages.join("index.html"), "<html>anki</html>").unwrap();
    std::fs::write(pages.join("_app/immutable/start.mjs"), "export {}").unwrap();
    let phone = ankibase_engine::App::start(ankibase_engine::Config {
        dir: tmp.clone(), web: None, pages: Some(pages), default_server: None, version: "0".into(), build: "0".into(), update_feed: None, bundle_id: None, media_token: None, focus_dir: None,
    });
    add_cards(&phone, "Spanish", &["hola"]);
    let deck = ok(&phone, "GET", "/api/decks/names", Value::Null)["decks"]["Spanish"].as_i64().unwrap();

    let page = send(&phone, "GET", &format!("/anki-pages/graphs?deck={deck}&theme=dark"), &[], Vec::new());
    assert_eq!((page.status, page.body.as_slice()), (200, &b"<html>anki</html>"[..]));
    assert_eq!(send(&phone, "GET", "/anki-pages/graphs?deck=12345", &[], Vec::new()).status, 404);
    assert_eq!(send(&phone, "GET", &format!("/anki-pages/deck-options/{deck}"), &[], Vec::new()).status, 200);
    let script = send(&phone, "GET", "/anki-pages/_app/immutable/start.mjs", &[], Vec::new());
    assert_eq!((script.status, script.header("content-type")), (200, Some("text/javascript")));
    assert_eq!(send(&phone, "GET", "/anki-pages/../settings.json", &[], Vec::new()).status, 404);

    // The Statistics page's own call, answered by Anki.
    let request = anki_proto::stats::GraphsRequest { search: "deck:current".into(), days: 365 };
    let answer = send(&phone, "POST", "/anki-pages/_anki/graphs", &[("content-type", "application/binary")], request.encode_to_vec());
    assert_eq!(answer.status, 200);
    let graphs = anki_proto::stats::GraphsResponse::decode(answer.body.as_slice()).unwrap();
    assert_eq!(graphs.card_counts.unwrap().excluding_inactive.unwrap().new_cards, 1);

    // Deck Options loads the deck's settings.
    let answer = send(&phone, "POST", "/anki-pages/_anki/getDeckConfigsForUpdate", &[],
                      anki_proto::decks::DeckId { did: deck }.encode_to_vec());
    assert_eq!(answer.status, 200);
    let configs = anki_proto::deck_config::DeckConfigsForUpdate::decode(answer.body.as_slice()).unwrap();
    assert!(!configs.all_config.is_empty());
    assert_eq!(send(&phone, "POST", "/anki-pages/_anki/deckOptionsReady", &[], Vec::new()).status, 204);
    assert_eq!(send(&phone, "POST", "/anki-pages/_anki/removeNotes", &[], Vec::new()).status, 404);
    let _ = std::fs::remove_dir_all(&tmp);
}
