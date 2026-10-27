//! The focus lock: today's file appears once nothing is due, strict mode refuses the ways
//! around it, and Screen Time passcodes stay sealed until their date.

mod common;

use common::*;
use serde_json::json;

fn day_files(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
    names.sort();
    names
}

#[test]
fn locks_until_the_cards_are_done() {
    let tmp = temp_dir("focus");
    let folder = tmp.join("Documents").join("Focus");
    let phone = app_with(&tmp, None, Some(folder.clone()));

    // Off: the coming month is open, so the automation never sends anyone here.
    let state = ok(&phone, "GET", "/api/app/focus", json!(null));
    assert_eq!(state["available"], true);
    assert_eq!(state["enabled"], false);
    let today = state["today"].as_str().unwrap().to_string();
    assert_eq!(day_files(&folder).len(), 30);
    assert_eq!(day_files(&folder)[0], format!("{today}.txt"));
    assert_eq!(state["rollover_hour"], 4);

    // Cards due, lock on: no file for today, and the folder can't be written by others.
    add_cards(&phone, "French", &["chat", "chien"]);
    let state = ok(&phone, "PUT", "/api/app/focus", json!({"enabled": true, "strict": true, "strict_days": 7, "min_answer_secs": 2}));
    assert_eq!(state["locked"], true);
    assert_eq!(state["due"], 2);
    assert!(day_files(&folder).is_empty(), "{:?}", day_files(&folder));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o555);
    }

    // Strict: can't loosen, can't skip, can't delete the deck or lower its limits.
    let (status, body) = call(&phone, "PUT", "/api/app/focus", json!({"enabled": false}));
    assert_eq!(status, 423, "{body}");
    assert_eq!(call(&phone, "PUT", "/api/app/focus", json!({"min_answer_secs": 0})).0, 423);
    assert_eq!(call(&phone, "POST", "/api/app/focus/pass", json!(null)).0, 423);
    assert_eq!(call(&phone, "POST", "/api/decks/delete", json!({"deck_name": "French"})).0, 423);
    assert_eq!(send(&phone, "POST", "/anki-pages/_anki/updateDeckConfigs", &[], vec![]).status, 423);
    // Stricter is fine.
    ok(&phone, "PUT", "/api/app/focus", json!({"min_answer_secs": 3, "strict_days": 30}));

    // Too quick an answer is refused; a read card counts.
    let current = ok(&phone, "POST", "/api/review/current", json!({"deck": "French"}));
    assert_eq!(current["min_answer_ms"], 3000);
    let first = current["card"]["card_id"].as_i64().unwrap();
    let (status, _) = call(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": first, "ease": 4}));
    assert_eq!(status, 429);
    let mut card = first;
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(3100));
        let next = ok(&phone, "POST", "/api/review/answer", json!({"deck": "French", "card_id": card, "ease": 4}));
        match next["card"]["card_id"].as_i64() {
            Some(id) => card = id,
            None => break,
        }
    }

    // Done: today's file is there and stays, even if new cards arrive later today.
    assert_eq!(day_files(&folder), vec![format!("{today}.txt")]);
    assert_eq!(std::fs::read_to_string(folder.join(format!("{today}.txt"))).unwrap(), "done");
    add_cards(&phone, "French", &["oiseau"]);
    let state = ok(&phone, "GET", "/api/app/focus", json!(null));
    assert_eq!(state["open"], true);
    assert_eq!(state["locked"], false);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn flexible_mode_has_emergency_passes() {
    let tmp = temp_dir("focus-pass");
    let folder = tmp.join("Focus");
    let phone = app_with(&tmp, None, Some(folder.clone()));
    add_cards(&phone, "Spanish", &["gato"]);
    let state = ok(&phone, "PUT", "/api/app/focus", json!({"enabled": true, "passes_per_month": 1}));
    assert_eq!(state["locked"], true);
    assert_eq!(state["passes_left"], 1);
    // Flexible mode doesn't block deleting decks.
    let state = ok(&phone, "POST", "/api/app/focus/pass", json!(null));
    assert_eq!(state["open"], true);
    assert_eq!(state["passes_left"], 0);
    assert_eq!(std::fs::read_to_string(folder.join(format!("{}.txt", state["today"].as_str().unwrap()))).unwrap(), "pass");
    // Turning it off opens the coming days again.
    let state = ok(&phone, "PUT", "/api/app/focus", json!({"enabled": false}));
    assert_eq!(state["enabled"], false);
    assert_eq!(day_files(&folder).len(), 30);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn passcodes_stay_sealed_until_their_date() {
    let tmp = temp_dir("focus-code");
    let phone = app_with(&tmp, None, Some(tmp.join("Focus")));
    let made = ok(&phone, "POST", "/api/app/focus/passcode", json!({"days": 30}));
    let code = made["code"].as_str().unwrap();
    assert_eq!(code.len(), 4);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    // Only the sealed copy is kept.
    let saved = std::fs::read_to_string(tmp.join("settings.json")).unwrap();
    assert!(saved.contains("sealed") && !saved.contains(&format!("\"{code}\"")));
    let (status, body) = call(&phone, "POST", "/api/app/focus/passcode/reveal", json!({"id": 0}));
    assert_eq!(status, 423, "{body}");
    assert_eq!(made["state"]["passcodes"][0]["revealable"], false);
    let _ = std::fs::remove_dir_all(&tmp);
}
