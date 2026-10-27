//! Focus lock (iPhone): other apps stay closed until today's cards are done.
//!
//! An app can't block other apps without Apple's Screen Time entitlement, which free
//! accounts can't get. So the blocking is a Shortcuts automation ("when Instagram is
//! opened…") that looks for today's file in the app's `Focus` folder and opens AnkiBase
//! when it isn't there. The app writes that file once nothing is due (or an emergency pass
//! is used), and keeps the folder read-only so the Files app can't put one there. The
//! Shortcuts app and Screen Time's settings are then locked behind a Screen Time passcode
//! the app makes up and time-locks with drand: nobody can read it before the chosen date.
//!
//! A day is Anki's day: it starts at the collection's rollover hour (4:00 by default), and
//! its file is named after the date it started on (`2026-10-27.txt`).

use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use base64::Engine as _;
use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::App;
use crate::http::{Reply, Request};

/// drand's quicknet: a new public random value every 3 s, signed by the League of Entropy.
/// A message time-locked to round n can only be read with that round's signature.
const DRAND_URL: &str = "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const DRAND_CHAIN: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const DRAND_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
const DRAND_GENESIS: i64 = 1692803367;
const DRAND_PERIOD: i64 = 3;

/// With the lock off, days are opened this far ahead, so the automation never fires.
const OPEN_AHEAD_DAYS: i64 = 30;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct FocusSettings {
    enabled: bool,
    /// No emergency passes, no quick answers, no lowering today's load, and no turning it
    /// off (or loosening it) before `strict_until`.
    strict: bool,
    strict_until: Option<i64>,
    /// New cards count too (not only reviews and learning).
    include_new: bool,
    /// Seconds a card must be on screen before it can be answered (0: off).
    min_answer_secs: u32,
    /// Flexible mode: days per month an emergency pass can open.
    passes_per_month: u32,
    /// Days opened with a pass (yyyy-mm-dd).
    passes_used: Vec<String>,
    /// Screen Time passcodes the app made up, time-locked.
    passcodes: Vec<Passcode>,
}

impl Default for FocusSettings {
    fn default() -> Self {
        FocusSettings {
            enabled: false,
            strict: false,
            strict_until: None,
            include_new: true,
            min_answer_secs: 0,
            passes_per_month: 2,
            passes_used: Vec::new(),
            passcodes: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Passcode {
    created: i64,
    reveal_at: i64,
    round: u64,
    /// The code, tlock-encrypted (age format, base64).
    sealed: String,
}

/// Settings → Focus lock changes.
#[derive(Deserialize)]
struct Change {
    enabled: Option<bool>,
    strict: Option<bool>,
    /// Strict for this many days from now.
    strict_days: Option<i64>,
    include_new: Option<bool>,
    min_answer_secs: Option<u32>,
    passes_per_month: Option<u32>,
}

/// Today in Anki's terms.
struct Today {
    day: NaiveDate,
    next_day_at: i64,
    rollover_hour: u32,
    new: u32,
    learn: u32,
    review: u32,
}

impl Today {
    fn key(&self) -> String {
        self.day.format("%Y-%m-%d").to_string()
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

impl App {
    fn focus_dir(&self) -> Option<&Path> {
        self.config.focus_dir.as_deref()
    }

    fn focus_settings(&self) -> FocusSettings {
        self.settings.lock().unwrap().focus.clone()
    }

    fn save_focus(&self, focus: FocusSettings) {
        let mut settings = self.settings.lock().unwrap();
        settings.focus = focus;
        self.save_settings(&settings);
    }

    fn today(&self) -> Option<Today> {
        let (new, learn, review, next_day_at) = self.with_engine(|engine| engine.due_today()).ok()?.ok()?;
        let start = Local.timestamp_opt(next_day_at.0 - 86_400, 0).single()?;
        let rollover_hour = Local.timestamp_opt(next_day_at.0, 0).single()?.format("%H").to_string().parse().ok()?;
        Some(Today { day: start.date_naive(), next_day_at: next_day_at.0, rollover_hour, new, learn, review })
    }

    fn due(focus: &FocusSettings, today: &Today) -> u32 {
        today.review + today.learn + if focus.include_new { today.new } else { 0 }
    }

    fn day_open(&self, day: &str) -> bool {
        self.focus_dir().is_some_and(|dir| dir.join(format!("{day}.txt")).exists())
    }

    /// Bring the Focus folder up to date: open today when it's earned, open the coming
    /// days while the lock is off. Called after anything that changes what's due.
    pub(super) fn focus_refresh(&self) {
        let Some(dir) = self.focus_dir() else { return };
        let focus = self.focus_settings();
        let Some(today) = self.today() else { return };
        let min_ms = if focus.enabled && Self::due(&focus, &today) > 0 { focus.min_answer_secs * 1000 } else { 0 };
        let _ = self.with_engine(|engine| engine.min_answer_ms = min_ms);
        let key = today.key();
        let mut open: Vec<(String, &str)> = Vec::new();
        if !focus.enabled {
            open.extend((0..OPEN_AHEAD_DAYS).map(|n| {
                ((today.day + chrono::Days::new(n as u64)).format("%Y-%m-%d").to_string(), "off")
            }));
        } else if Self::due(&focus, &today) == 0 {
            open.push((key.clone(), "done"));
        } else if focus.passes_used.contains(&key) {
            open.push((key.clone(), "pass"));
        }
        let _ = write_focus_dir(dir, &open, focus.enabled.then_some(&key));
    }

    /// Whether the lock holds right now: on, and cards still due today.
    pub(super) fn focus_locked(&self) -> bool {
        let focus = self.focus_settings();
        if !focus.enabled || self.focus_dir().is_none() {
            return false;
        }
        let Some(today) = self.today() else { return false };
        Self::due(&focus, &today) > 0 && !self.day_open(&today.key())
    }

    /// Strict mode refuses what would only make today's cards go away.
    pub(super) fn focus_refuses(&self, request: &Request) -> Option<Reply> {
        let path = request.path();
        let cheat = (request.method == "POST" && path == "/api/decks/delete")
            || path == "/anki-pages/_anki/updateDeckConfigs";
        if !cheat || !self.focus_settings().strict || !self.focus_locked() {
            return None;
        }
        Some(Reply::error(423, "Focus lock: finish today's cards first."))
    }

    fn focus_state(&self) -> Value {
        let focus = self.focus_settings();
        let Some(dir) = self.focus_dir() else { return json!({"available": false}) };
        let today = self.today();
        let key = today.as_ref().map(Today::key);
        let open = key.as_deref().is_some_and(|k| self.day_open(k));
        let due = today.as_ref().map(|t| Self::due(&focus, t)).unwrap_or(0);
        let month = key.as_deref().map(|k| &k[..7]).unwrap_or_default();
        let used = focus.passes_used.iter().filter(|d| d.starts_with(month)).count() as u32;
        let committed = focus.strict && focus.strict_until.is_some_and(|until| until > now());
        let now = now();
        json!({
            "available": true,
            "enabled": focus.enabled,
            "strict": focus.strict,
            "strict_until": focus.strict_until,
            "committed": committed,
            "include_new": focus.include_new,
            "min_answer_secs": focus.min_answer_secs,
            "passes_per_month": focus.passes_per_month,
            "passes_left": if focus.strict { 0 } else { focus.passes_per_month.saturating_sub(used) },
            "today": key,
            "rollover_hour": today.as_ref().map(|t| t.rollover_hour),
            "next_day_at": today.as_ref().map(|t| t.next_day_at),
            "due": due,
            "counts": today.as_ref().map(|t| json!({"new": t.new, "learn": t.learn, "review": t.review})),
            "open": open,
            "locked": focus.enabled && due > 0 && !open,
            "folder": dir.file_name().map(|n| n.to_string_lossy().to_string()),
            "passcodes": focus.passcodes.iter().enumerate().map(|(i, p)| json!({
                "id": i, "created": p.created, "reveal_at": p.reveal_at, "revealable": p.reveal_at <= now,
            })).collect::<Vec<_>>(),
        })
    }

    /// `/api/app/focus…`
    pub(super) fn focus_route(&self, request: &Request) -> Option<Reply> {
        let path = request.path();
        if !path.starts_with("/api/app/focus") {
            return None;
        }
        if self.focus_dir().is_none() {
            return Some(Reply::error(404, "Focus lock isn't available in this app"));
        }
        Some(match (request.method.as_str(), path) {
            ("GET", "/api/app/focus") => {
                self.focus_refresh();
                Reply::ok(self.focus_state())
            }
            ("PUT", "/api/app/focus") => match serde_json::from_slice::<Change>(&request.body) {
                Ok(change) => self.focus_change(change),
                Err(err) => Reply::error(422, err.to_string()),
            },
            ("POST", "/api/app/focus/pass") => self.focus_pass(),
            ("POST", "/api/app/focus/passcode") => {
                let days = serde_json::from_slice::<Value>(&request.body).ok().and_then(|v| v["days"].as_i64());
                match days {
                    Some(days) if (1..=366).contains(&days) => self.focus_new_passcode(days),
                    _ => Reply::error(422, "Choose 1 to 366 days"),
                }
            }
            ("POST", "/api/app/focus/passcode/reveal") => {
                let id = serde_json::from_slice::<Value>(&request.body).ok().and_then(|v| v["id"].as_u64());
                match id {
                    Some(id) => self.focus_reveal(id as usize),
                    None => Reply::error(422, "Which passcode?"),
                }
            }
            _ => Reply::error(404, "Not found"),
        })
    }

    fn focus_change(&self, change: Change) -> Reply {
        let mut focus = self.focus_settings();
        let before = focus.clone();
        if let Some(enabled) = change.enabled {
            focus.enabled = enabled;
        }
        if let Some(strict) = change.strict {
            focus.strict = strict;
        }
        if let Some(days) = change.strict_days {
            let until = now() + days.clamp(0, 366) * 86_400;
            focus.strict_until = Some(until.max(before.strict_until.unwrap_or(0)));
        }
        if let Some(include_new) = change.include_new {
            focus.include_new = include_new;
        }
        if let Some(secs) = change.min_answer_secs {
            focus.min_answer_secs = secs.min(30);
        }
        if let Some(passes) = change.passes_per_month {
            focus.passes_per_month = passes.min(31);
        }
        let committed = before.strict && before.strict_until.is_some_and(|until| until > now());
        let loosened = !focus.enabled
            || !focus.strict
            || (before.include_new && !focus.include_new)
            || focus.min_answer_secs < before.min_answer_secs;
        if committed && before.enabled && loosened {
            let until = Local.timestamp_opt(before.strict_until.unwrap(), 0).single().map(|d| d.format("%-d %B %Y").to_string());
            return Reply::error(423, format!("Strict until {}: it can only get stricter until then.", until.unwrap_or_default()));
        }
        // Turning it off (flexible mode) while cards are due works, but not as a way out
        // of strict mode's "finish first".
        if before.enabled && before.strict && !focus.enabled && self.focus_locked() {
            return Reply::error(423, "Focus lock: finish today's cards first, then turn it off.");
        }
        self.save_focus(focus);
        self.focus_refresh();
        Reply::ok(self.focus_state())
    }

    fn focus_pass(&self) -> Reply {
        let mut focus = self.focus_settings();
        let Some(today) = self.today() else { return Reply::error(500, "Couldn't read today's cards") };
        let key = today.key();
        let used = focus.passes_used.iter().filter(|d| d.starts_with(&key[..7])).count() as u32;
        if focus.strict {
            return Reply::error(423, "Strict mode has no emergency passes.");
        }
        if used >= focus.passes_per_month {
            return Reply::error(423, "No emergency passes left this month.");
        }
        if !focus.passes_used.contains(&key) {
            focus.passes_used.push(key);
            focus.passes_used.retain(|d| d.as_str() >= &today.key()[..7]);
        }
        self.save_focus(focus);
        self.focus_refresh();
        Reply::ok(self.focus_state())
    }

    /// A Screen Time passcode nobody knows: shown once (to type into Settings), kept only
    /// time-locked until `days` from now.
    fn focus_new_passcode(&self, days: i64) -> Reply {
        let code = match random_digits(4) {
            Ok(code) => code,
            Err(err) => return Reply::error(500, format!("No randomness: {err}")),
        };
        let reveal_at = now() + days * 86_400;
        let round = ((reveal_at - DRAND_GENESIS) / DRAND_PERIOD + 1) as u64;
        let chain = hex(DRAND_CHAIN);
        let key = hex(DRAND_KEY);
        let mut sealed = Vec::new();
        if let Err(err) = tlock_age::encrypt(&mut sealed, code.as_bytes(), &chain, &key, round) {
            return Reply::error(500, format!("Couldn't time-lock the passcode: {err}"));
        }
        let mut focus = self.focus_settings();
        focus.passcodes.push(Passcode {
            created: now(),
            reveal_at,
            round,
            sealed: base64::engine::general_purpose::STANDARD.encode(sealed),
        });
        self.save_focus(focus);
        Reply::ok(json!({"code": code, "reveal_at": reveal_at, "state": self.focus_state()}))
    }

    fn focus_reveal(&self, id: usize) -> Reply {
        let focus = self.focus_settings();
        let Some(passcode) = focus.passcodes.get(id) else { return Reply::error(404, "No such passcode") };
        if passcode.reveal_at > now() {
            return Reply::error(423, "Not yet: nobody can open it before its date.");
        }
        let Some(beacon) = self.server.fetch_json(&format!("{DRAND_URL}/public/{}", passcode.round)) else {
            return Reply::error(503, "Couldn't reach drand. Opening a passcode needs the internet.");
        };
        let signature = hex(beacon["signature"].as_str().unwrap_or_default());
        let Ok(sealed) = base64::engine::general_purpose::STANDARD.decode(&passcode.sealed) else {
            return Reply::error(500, "The saved passcode is damaged");
        };
        // tlock panics (rather than failing) on a wrong signature.
        let opened = std::panic::catch_unwind(|| {
            let mut code = Vec::new();
            tlock_age::decrypt(&mut code, sealed.as_slice(), &hex(DRAND_CHAIN), &signature).map(|_| code)
        });
        match opened {
            Ok(Ok(code)) => Reply::ok(json!({"code": String::from_utf8_lossy(&code)})),
            _ => Reply::error(502, "drand's answer didn't open it. Try again later."),
        }
    }
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).filter_map(|i| u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()).collect()
}

fn random_digits(count: usize) -> std::io::Result<String> {
    let mut bytes = vec![0u8; count * 4];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes
        .chunks(4)
        .map(|chunk| char::from(b'0' + (u32::from_le_bytes(chunk.try_into().unwrap()) % 10) as u8))
        .collect())
}

/// Write the day files in `open` and remove the others, except a day `today` already
/// earned (done or pass: new cards arriving later don't close it again). The folder is
/// read-only between writes, so nothing but the app can add a day.
fn write_focus_dir(dir: &Path, open: &[(String, &str)], today: Option<&String>) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    set_mode(dir, 0o755)?;
    let result = (|| {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(day) = name.strip_suffix(".txt") else { continue };
            let earned = today.is_some_and(|t| t == day) && fs::read(entry.path()).is_ok_and(|why| why != b"off");
            let keep = open.iter().any(|(d, _)| d == day) || earned;
            if !keep {
                set_mode(&entry.path(), 0o644)?;
                fs::remove_file(entry.path())?;
            }
        }
        for (day, why) in open {
            let path = dir.join(format!("{day}.txt"));
            if !path.exists() {
                fs::write(&path, why)?;
                set_mode(&path, 0o444)?;
            }
        }
        Ok(())
    })();
    set_mode(dir, 0o555)?;
    result
}

fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    let _ = (path, mode);
    Ok(())
}
