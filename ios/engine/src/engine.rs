use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;
use std::time::Instant;

use anki::collection::CollectionBuilder;
use anki::error::{SyncErrorKind, AnkiError};
use anki::prelude::*;
use anki::scheduler::answering::{CardAnswer, Rating};
use anki::sync::collection::normal::SyncActionRequired;
use anki::sync::login::{sync_login, SyncAuth};
use anki_proto::decks::DeckTreeNode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// An error with the HTTP status AnkiBase's server would answer with.
#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub detail: String,
}

impl Failure {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        Failure { status, detail: detail.into() }
    }
}

impl From<AnkiError> for Failure {
    fn from(err: AnkiError) -> Self {
        let status = match &err {
            AnkiError::SyncError { source } if source.kind == SyncErrorKind::AuthFailed => 401,
            AnkiError::NotFound { .. } => 404,
            AnkiError::InvalidInput { .. } => 400,
            _ => 500,
        };
        let detail = if status == 401 {
            "AnkiWeb didn't accept the saved login. Log in to AnkiWeb again.".to_string()
        } else {
            err.message(&I18n::template_only())
        };
        Failure { status, detail }
    }
}

pub type Outcome<T> = std::result::Result<T, Failure>;

/// The AnkiWeb login, kept next to the collection.
#[derive(Default, Serialize, Deserialize)]
struct Account {
    hkey: Option<String>,
    endpoint: Option<String>,
    username: Option<String>,
    last_sync: Option<i64>,
}

pub struct Engine {
    pub(crate) dir: PathBuf,
    col: Option<Collection>,
    pub(crate) rt: tokio::runtime::Runtime,
    pub(crate) web: reqwest::Client,
    account: Account,
    /// The card on screen and when it was shown, for the review's time taken.
    pub(crate) shown: Option<(CardId, Instant)>,
    media_sync: Option<JoinHandle<Result<()>>>,
    media_error: Option<String>,
    /// Desktop-only settings Anki's pages remember (`getProfileConfigJson`…), per launch.
    pub(crate) page_settings: std::collections::HashMap<String, Vec<u8>>,
}

impl Engine {
    /// Open (or create) the collection in `dir`.
    pub fn open(dir: impl Into<PathBuf>) -> Outcome<Engine> {
        let dir = dir.into();
        fs::create_dir_all(&dir).map_err(|e| Failure::new(500, e.to_string()))?;
        let account = fs::read(dir.join("account.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| Failure::new(500, e.to_string()))?;
        Ok(Engine {
            col: Some(open_collection(&dir)?),
            dir,
            rt,
            web: reqwest::Client::new(),
            account,
            shown: None,
            media_sync: None,
            media_error: None,
            page_settings: Default::default(),
        })
    }

    pub fn col(&mut self) -> Outcome<&mut Collection> {
        if self.col.is_none() {
            self.col = Some(open_collection(&self.dir)?);
        }
        Ok(self.col.as_mut().unwrap())
    }

    fn save_account(&self) -> Outcome<()> {
        let data = serde_json::to_vec(&self.account).unwrap();
        fs::write(self.dir.join("account.json"), data).map_err(|e| Failure::new(500, e.to_string()))
    }

    // Decks --------------------------------------------------------------------------

    pub fn deck_names(&mut self) -> Outcome<BTreeMap<String, i64>> {
        let names = self.col()?.get_all_deck_names(false)?;
        Ok(names.into_iter().map(|(id, name)| (name, id.0)).collect())
    }

    /// Deck names and ids, and Anki's due counts per deck id (as AnkiConnect's getDeckStats).
    pub fn decks(&mut self) -> Outcome<Value> {
        let names = self.deck_names()?;
        let tree = self.col()?.deck_tree(Some(TimestampSecs::now()))?;
        let mut stats = serde_json::Map::new();
        for id in names.values() {
            stats.insert(id.to_string(), json!({"deck_id": id, "new_count": 0, "learn_count": 0,
                                                "review_count": 0, "total_in_deck": 0}));
        }
        fn walk(node: &DeckTreeNode, stats: &mut serde_json::Map<String, Value>) {
            if node.level > 0 {
                stats.insert(node.deck_id.to_string(), json!({
                    "deck_id": node.deck_id, "name": node.name, "new_count": node.new_count,
                    "learn_count": node.learn_count, "review_count": node.review_count,
                    "total_in_deck": node.total_in_deck,
                }));
            }
            for child in &node.children {
                walk(child, stats);
            }
        }
        walk(&tree, &mut stats);
        Ok(json!({"decks": names, "stats": stats}))
    }

    // Studying -----------------------------------------------------------------------

    /// The next card in `deck` as Anki's reviewer would show it, with the day's counts.
    pub fn current(&mut self, deck: &str) -> Outcome<Value> {
        let col = self.col()?;
        let did = col.get_deck_id(deck)?.ok_or_else(|| Failure::new(404, format!("No deck named {deck:?}")))?;
        if col.get_current_deck()?.id != did {
            col.set_current_deck(did)?;
        }
        let queued = col.get_queued_cards(1, false)?;
        let counts = json!({"new": queued.new_count, "learn": queued.learning_count, "review": queued.review_count});
        let Some(next) = queued.cards.into_iter().next() else {
            self.shown = None;
            return Ok(json!({"card": null, "counts": counts, "mode": "reviewer", "media_token": "local"}));
        };
        let cid = next.card.id();
        let rendered = col.render_existing_card(cid, false, false)?;
        let note = col.storage.get_note(next.card.note_id())?.or_not_found(next.card.note_id())?;
        let notetype = col.get_notetype(note.notetype_id)?.or_not_found(note.notetype_id)?;
        let fields: Vec<Value> = notetype
            .fields
            .iter()
            .zip(note.fields())
            .map(|(field, value)| json!({"name": field.name, "value": value}))
            .collect();
        let next_reviews: Vec<String> = col
            .describe_next_states(&next.states)?
            .into_iter()
            .map(|label| label.replace(['\u{2068}', '\u{2069}'], ""))
            .collect();
        let deck_name = col.get_deck(next.card.deck_id())?.map(|d| d.human_name()).unwrap_or_else(|| deck.to_string());
        let card = json!({
            "card_id": cid.0,
            "question": rendered.question(),
            "answer": rendered.answer(),
            "css": rendered.css,
            "model": notetype.name,
            "deck": deck_name,
            "buttons": [1, 2, 3, 4],
            "next_reviews": next_reviews,
            "fields": fields,
        });
        if self.shown.map(|(id, _)| id) != Some(cid) {
            self.shown = Some((cid, Instant::now()));
        }
        Ok(json!({"card": card, "counts": counts, "mode": "reviewer", "media_token": "local"}))
    }

    /// Answer `card_id` (if it's still the reviewer's next card) and return the next one.
    pub fn answer(&mut self, deck: &str, card_id: i64, ease: u8) -> Outcome<Value> {
        let rating = match ease {
            1 => Rating::Again,
            2 => Rating::Hard,
            3 => Rating::Good,
            4 => Rating::Easy,
            _ => return Err(Failure::new(400, "card_id and ease (1-4) required")),
        };
        let taken = match self.shown {
            Some((id, at)) if id.0 == card_id => at.elapsed().as_millis().min(u32::MAX as u128) as u32,
            _ => 0,
        };
        let col = self.col()?;
        let queued = col.get_queued_cards(1, false)?;
        // Only answer the card that's actually next, never a stale one.
        if let Some(next) = queued.cards.into_iter().next().filter(|c| c.card.id().0 == card_id) {
            let states = next.states;
            let new_state = match rating {
                Rating::Again => states.again,
                Rating::Hard => states.hard,
                Rating::Good => states.good,
                Rating::Easy => states.easy,
            };
            col.answer_card(&mut CardAnswer {
                card_id: next.card.id(),
                current_state: states.current,
                new_state,
                rating,
                answered_at: TimestampMillis::now(),
                milliseconds_taken: taken,
                custom_data: None,
                from_queue: true,
            })?;
            self.shown = None;
        }
        self.current(deck)
    }

    pub fn undo(&mut self, deck: &str) -> Outcome<Value> {
        let col = self.col()?;
        if col.can_undo().is_some() {
            col.undo()?;
        }
        self.shown = None;
        self.current(deck)
    }

    pub fn media_file(&mut self, name: &str) -> Outcome<Vec<u8>> {
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(Failure::new(400, "Invalid file name"));
        }
        fs::read(self.dir.join("collection.media").join(name))
            .map_err(|_| Failure::new(404, "Media file not found"))
    }

    // AnkiWeb ------------------------------------------------------------------------

    /// Log in to AnkiWeb, or to a self-hosted sync server at `endpoint`.
    pub fn login(&mut self, username: &str, password: &str, endpoint: Option<String>) -> Outcome<()> {
        let endpoint = endpoint.map(|e| normalize_endpoint(&e)).transpose()?;
        let auth = self
            .rt
            .block_on(sync_login(username, password, endpoint.clone(), self.web.clone()))
            .map_err(|err| match Failure::from(err) {
                Failure { status: 401, .. } => {
                    Failure::new(401, "Failed to log in to AnkiWeb. Check your email and password.")
                }
                other => other,
            })?;
        self.account = Account {
            hkey: Some(auth.hkey),
            endpoint,
            username: Some(username.to_string()),
            last_sync: None,
        };
        self.save_account()
    }

    pub fn logout(&mut self) -> Outcome<()> {
        self.account = Account::default();
        self.save_account()
    }

    pub fn status(&mut self) -> Value {
        let logged_in = self.account.hkey.is_some();
        json!({
            "has_credentials": logged_in,
            "configured": logged_in,
            "email": self.account.username,
            "last_sync": self.account.last_sync,
            // Set when syncing with a self-hosted server instead of AnkiWeb.
            "endpoint": self.account.endpoint.as_deref().filter(|e| !is_ankiweb(e)),
        })
    }

    fn auth(&self) -> Outcome<SyncAuth> {
        let hkey = self.account.hkey.clone().ok_or_else(|| {
            Failure::new(503, "AnkiWeb sync not configured. Please configure AnkiWeb login first.")
        })?;
        Ok(anki_proto::sync::SyncAuth { hkey, endpoint: self.account.endpoint.clone(), io_timeout_secs: None }
            .try_into()?)
    }

    /// Sync with AnkiWeb, like Anki's sync button: a normal sync, or a one-way full sync
    /// when one side is empty. When both sides changed, the caller has to choose.
    pub fn sync(&mut self) -> Outcome<&'static str> {
        let auth = self.auth()?;
        self.wait_for_media_sync();
        let web = self.web.clone();
        let col = self.col.as_mut().ok_or_else(|| Failure::new(500, "The collection isn't open"))?;
        let out = self.rt.block_on(col.normal_sync(auth, web))?;
        if let Some(endpoint) = out.new_endpoint {
            self.account.endpoint = Some(endpoint);
        }
        let outcome = match out.required {
            // Anki reports a completed normal sync as "no changes" too.
            SyncActionRequired::NoChanges | SyncActionRequired::NormalSyncRequired => "ok",
            SyncActionRequired::FullSyncRequired { upload_ok: false, .. } => {
                self.full_sync(false)?;
                "fullDownload"
            }
            SyncActionRequired::FullSyncRequired { download_ok: false, .. } => {
                self.full_sync(true)?;
                "fullUpload"
            }
            SyncActionRequired::FullSyncRequired { .. } => {
                self.save_account()?;
                return Err(Failure::new(409, "Full sync required:choose"));
            }
        };
        self.synced()?;
        Ok(outcome)
    }

    /// Replace AnkiWeb's copy with this one (`upload`), or this one with AnkiWeb's.
    pub fn full_sync(&mut self, upload: bool) -> Outcome<()> {
        let auth = self.auth()?;
        self.wait_for_media_sync();
        self.shown = None;
        let col = self.col.take().ok_or_else(|| Failure::new(500, "The collection isn't open"))?;
        let web = self.web.clone();
        let result = if upload {
            self.rt.block_on(col.full_upload(auth, web))
        } else {
            self.rt.block_on(col.full_download(auth, web))
        };
        self.col = Some(open_collection(&self.dir)?);
        result?;
        self.synced()
    }

    fn synced(&mut self) -> Outcome<()> {
        self.account.last_sync = Some(TimestampSecs::now().0);
        self.save_account()?;
        self.start_media_sync()
    }

    /// Media syncs in the background, so studying can start before all files are here.
    fn start_media_sync(&mut self) -> Outcome<()> {
        if self.media_sync.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        self.media_error = None;
        let auth = self.auth()?;
        let col = self.col()?;
        let media = col.media()?;
        let progress = col.new_progress_handler();
        let web = self.web.clone();
        let rt = self.rt.handle().clone();
        self.media_sync = Some(std::thread::spawn(move || {
            rt.block_on(media.sync_media(progress, auth, web, None))
        }));
        Ok(())
    }

    fn wait_for_media_sync(&mut self) {
        if let Some(task) = self.media_sync.take() {
            self.record_media_result(task);
        }
    }

    fn record_media_result(&mut self, task: JoinHandle<Result<()>>) {
        self.media_error = match task.join() {
            Ok(Ok(())) => None,
            Ok(Err(err)) => Some(Failure::from(err).detail),
            Err(_) => Some("Media sync crashed".into()),
        };
    }

    pub fn media_status(&mut self) -> Value {
        if self.media_sync.as_ref().is_some_and(|task| task.is_finished()) {
            let task = self.media_sync.take().unwrap();
            self.record_media_result(task);
        }
        json!({"active": self.media_sync.is_some(), "error": self.media_error})
    }
}

impl Drop for Engine {
    /// Media sync runs on this engine's runtime; let it finish first.
    fn drop(&mut self) {
        self.wait_for_media_sync();
    }
}

/// A self-hosted sync server's address as Anki expects it: http(s), ending in a slash.
fn normalize_endpoint(endpoint: &str) -> Outcome<String> {
    let mut endpoint = endpoint.trim().to_string();
    if !endpoint.contains("://") {
        endpoint = format!("https://{endpoint}");
    }
    let url = reqwest::Url::parse(&endpoint)
        .map_err(|_| Failure::new(400, format!("{endpoint} isn't a valid sync server address")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Failure::new(400, format!("{endpoint} isn't a valid sync server address")));
    }
    if !endpoint.ends_with('/') {
        endpoint.push('/');
    }
    Ok(endpoint)
}

/// AnkiWeb hands out its own server addresses (sync1.ankiweb.net…) after a sync.
fn is_ankiweb(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| host == "ankiweb.net" || host.ends_with(".ankiweb.net")))
        .unwrap_or(false)
}

pub(crate) fn open_collection(dir: &Path) -> Outcome<Collection> {
    Ok(CollectionBuilder::new(dir.join("collection.anki2"))
        .set_media_paths(dir.join("collection.media"), dir.join("collection.media.db"))
        .set_tr(I18n::new(&["en"]))
        .build()?)
}
