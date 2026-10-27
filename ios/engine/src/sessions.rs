//! Study sessions (the Study hub's "pick up where you left off"), as the server keeps them:
//! used for the phone's own sessions without a server, and to show sessions saved offline.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::http::{Reply, Request};

const KINDS: &[&str] = &["quizlet-learn", "quizlet-flashcards", "quizlet-test", "anki", "reading"];

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// The session after a PUT of `update` (a missing `state` keeps the saved one).
pub fn upsert(existing: Option<Value>, kind: &str, reference: &str, update: &Value) -> Value {
    let now = now();
    let mut record = existing.unwrap_or_else(|| {
        json!({"kind": kind, "ref_id": reference, "created_at": now, "state": null})
    });
    let text = |key: &str, max: usize| {
        update[key].as_str().map(|s| s.chars().take(max).collect::<String>())
    };
    record["title"] = json!(text("title", 200).unwrap_or_default());
    record["detail"] = json!(text("detail", 200).filter(|d| !d.is_empty()));
    record["progress_done"] = json!(update["progress_done"].as_i64().unwrap_or(0).max(0));
    record["progress_total"] = json!(update["progress_total"].as_i64().unwrap_or(0).max(0));
    record["status"] = json!(update["status"].as_str().unwrap_or("active"));
    if !update["state"].is_null() {
        record["state"] = update["state"].clone();
    }
    record["updated_at"] = json!(now);
    record
}

/// `{"sessions": [...]}` with one session replaced (or removed when `record` is None):
/// active ones only, most recent first, without their state.
pub fn list_with(list: Value, record: Option<&Value>, kind: &str, reference: &str) -> Value {
    let mut sessions: Vec<Value> = list["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !(s["kind"] == kind && s["ref_id"] == reference))
        .collect();
    if let Some(record) = record.filter(|r| r["status"] == "active") {
        let mut summary = record.clone();
        if let Some(object) = summary.as_object_mut() {
            object.remove("state");
        }
        sessions.push(summary);
    }
    sessions.sort_by(|a, b| b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));
    sessions.truncate(50);
    json!({"sessions": sessions})
}

/// The phone's own sessions, used when no AnkiBase server is connected.
pub struct LocalSessions {
    path: PathBuf,
}

impl LocalSessions {
    pub fn new(path: PathBuf) -> LocalSessions {
        LocalSessions { path }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or_default()
    }

    fn save(&self, all: &[Value]) {
        let _ = std::fs::write(&self.path, serde_json::to_vec(all).unwrap());
    }

    pub fn handle(&self, request: &Request) -> Option<Reply> {
        let segments = request.segments("/api/sessions")?;
        let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
        let mut all = self.load();
        match (request.method.as_str(), segments.as_slice()) {
            ("GET", [] | [""]) => {
                let list = all.iter().fold(json!({"sessions": []}), |list, s| {
                    list_with(list, Some(s), s["kind"].as_str().unwrap_or(""), s["ref_id"].as_str().unwrap_or(""))
                });
                Some(Reply::ok(list))
            }
            (method, ["", kind, reference]) => {
                if !KINDS.contains(kind) || reference.is_empty() || reference.len() > 64 {
                    return Some(Reply::error(400, "Unknown session"));
                }
                let found = all.iter().position(|s| s["kind"] == *kind && s["ref_id"] == *reference);
                match method {
                    "GET" => Some(Reply::ok(json!({"session": found.map(|i| all[i].clone())}))),
                    "PUT" => {
                        let update: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
                        let record = upsert(found.map(|i| all.remove(i)), kind, reference, &update);
                        all.push(record);
                        self.save(&all);
                        Some(Reply::ok(json!({"success": true})))
                    }
                    "DELETE" => {
                        if let Some(i) = found {
                            all.remove(i);
                            self.save(&all);
                        }
                        Some(Reply::ok(json!({"success": true})))
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }
}
