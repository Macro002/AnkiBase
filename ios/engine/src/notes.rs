//! Decks, notes, search, media and importing, as AnkiBase's server answers them.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use anki::import_export::package::ImportAnkiPackageOptions;
use anki::prelude::*;
use anki::search::SortMode;
use base64::Engine as _;
use regex::Regex;
use serde_json::{json, Map, Value};
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

use crate::engine::{Engine, Failure, Outcome};

/// Fields AnkiBase reads a deck's words from, best first (as the server does).
const WORD_FIELDS: &[&str] = &[
    "Word", "Front", "Expression", "Vocabulary", "Term", "Question", "Kanji", "Japanese", "Chinese",
    "Korean", "Spanish", "German", "French", "English", "Target", "Source", "Text", "Item", "Phrase",
    "Sentence",
];

/// A card's state as AnkiBase names it.
pub(crate) fn card_category(card: &anki_proto::cards::Card) -> &'static str {
    match (card.queue, card.ctype) {
        (-1, _) => "suspended",
        (-2 | -3, _) => "buried",
        (_, 0) => "new",
        (_, 1) => "learning",
        (_, 3) => "relearning",
        (_, 2) if card.interval < 21 => "young",
        (_, 2) => "mature",
        _ => "unknown",
    }
}

/// Free text as an Anki search term: quoted, with wildcards escaped.
pub(crate) fn search_text(prefix: &str, text: &str) -> String {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"").replace('*', "\\*").replace('_', "\\_");
    format!("\"{prefix}{escaped}\"")
}

/// Lowercase without accents, for matching words the way people type them.
pub(crate) fn fold(text: &str) -> String {
    text.to_lowercase()
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .replace('œ', "oe")
        .replace('æ', "ae")
        .replace('’', "'")
}

/// A field's text without HTML and media references.
pub(crate) fn plain_text(value: &str) -> String {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| Regex::new(r"<[^>]+>|\[sound:[^\]]+\]|\[image:[^\]]+\]").unwrap());
    tags.replace_all(value, "").trim().to_string()
}

impl Engine {
    fn deck_id(&mut self, name: &str) -> Outcome<DeckId> {
        self.col()?.get_deck_id(name)?.ok_or_else(|| Failure::new(404, format!("No deck named {name:?}")))
    }

    fn proto_card(&mut self, cid: CardId) -> Outcome<Option<anki_proto::cards::Card>> {
        Ok(self.col()?.storage.get_card(cid)?.map(Into::into))
    }

    /// A deck's words for stories: one per note, from its word field, with each note's
    /// fields and its least-known card's state.
    pub fn deck_words(&mut self, deck: &str, limit: usize, field: &str) -> Outcome<Value> {
        // Quoted like the server's search, so names with spaces and "::" work.
        let search = format!("\"deck:{}\"", deck.replace('\\', "\\\\").replace('"', "\\\""));
        let col = self.col()?;
        let mut card_ids = col.search_cards(search.as_str(), SortMode::NoOrder)?;
        card_ids.truncate(2000);
        if card_ids.is_empty() {
            return Ok(json!({"words": [], "word_data": {}, "field_used": null, "available_fields": [],
                             "categories": {}, "category_counts": {}}));
        }
        let priority = |c: &str| ["learning", "relearning", "young", "new", "mature", "suspended", "buried", "unknown"]
            .iter()
            .position(|p| *p == c)
            .unwrap_or(99);
        let mut note_categories: BTreeMap<NoteId, &'static str> = BTreeMap::new();
        for cid in card_ids {
            let Some(card) = self.col()?.storage.get_card(cid)? else { continue };
            let nid = card.note_id();
            let proto: anki_proto::cards::Card = card.into();
            let category = card_category(&proto);
            let entry = note_categories.entry(nid).or_insert(category);
            if priority(category) < priority(entry) {
                *entry = category;
            }
        }

        let mut words: Vec<String> = Vec::new();
        let mut word_data = Map::new();
        let mut categories = Map::new();
        let mut field_used: Option<String> = (!field.is_empty()).then(|| field.to_string());
        let mut available_fields: Vec<String> = Vec::new();
        let mut notetypes: HashMap<NotetypeId, Vec<String>> = HashMap::new();
        for (&nid, &category) in &note_categories {
            if words.len() >= limit {
                break;
            }
            let col = self.col()?;
            let Some(note) = col.storage.get_note(nid)? else { continue };
            if !notetypes.contains_key(&note.notetype_id) {
                let names = col
                    .get_notetype(note.notetype_id)?
                    .map(|nt| nt.fields.iter().map(|f| f.name.clone()).collect())
                    .unwrap_or_default();
                notetypes.insert(note.notetype_id, names);
            }
            let names = &notetypes[&note.notetype_id];
            if available_fields.is_empty() {
                available_fields = names.clone();
            }
            if field_used.is_none() {
                field_used = WORD_FIELDS
                    .iter()
                    .find_map(|want| names.iter().find(|n| n.eq_ignore_ascii_case(want)))
                    .or(names.first())
                    .cloned();
            }
            let Some(index) = field_used.as_ref().and_then(|f| names.iter().position(|n| n == f)) else { continue };
            let word = plain_text(&note.fields()[index]);
            if word.is_empty() || categories.contains_key(&word) {
                continue;
            }
            let fields: Map<String, Value> = names
                .iter()
                .zip(note.fields())
                .filter(|(_, value)| !value.trim().is_empty())
                .map(|(name, value)| (name.clone(), json!(value)))
                .collect();
            word_data.insert(word.clone(), json!({"fields": fields, "category": category}));
            categories.insert(word.clone(), json!(category));
            words.push(word);
        }
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for category in note_categories.values() {
            *counts.entry(category).or_default() += 1;
        }
        Ok(json!({
            "words": words, "word_data": word_data, "total": note_categories.len(), "field_used": field_used,
            "available_fields": available_fields, "categories": categories, "category_counts": counts,
        }))
    }

    pub fn delete_deck(&mut self, name: &str) -> Outcome<Value> {
        let did = self.deck_id(name)?;
        self.shown = None;
        self.col()?.remove_decks_and_child_decks(&[did])?;
        Ok(json!({"success": true, "message": format!("Deleted deck: {name}")}))
    }

    pub fn rename_deck(&mut self, old: &str, new: &str) -> Outcome<Value> {
        let new = new.trim();
        if new.is_empty() {
            return Err(Failure::new(400, "The new name is empty"));
        }
        let did = self.deck_id(old)?;
        self.col()?.rename_deck(did, new)?;
        Ok(json!({"success": true, "message": format!("Renamed deck to: {new}")}))
    }

    /// A media file as base64 (the Reading screen plays card audio this way).
    pub fn media_base64(&mut self, name: &str) -> Outcome<Value> {
        let bytes = self.media_file(name)?;
        Ok(json!({"filename": name, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}))
    }

    /// Notes containing `query` (accents ignored), best matches first, for the Search tab.
    pub fn search_cards(&mut self, query: &str, limit: usize) -> Outcome<Value> {
        let col = self.col()?;
        let note_ids = col.search_notes_unordered(search_text("nc:", query).as_str())?;
        let total = note_ids.len();
        let target = fold(query);
        let mut notes = Vec::new();
        for nid in note_ids.into_iter().take(200) {
            if let Some(note) = col.storage.get_note(nid)? {
                let first = note.fields().first().map(|f| fold(&plain_text(f))).unwrap_or_default();
                let rank = if first == target {
                    0
                } else if first.starts_with(&target) {
                    1
                } else if first.contains(&target) {
                    2
                } else {
                    3
                };
                notes.push(((rank, first.chars().count()), note));
            }
        }
        notes.sort_by_key(|(rank, note)| (*rank, note.id));
        notes.truncate(limit);

        let mut hits = Vec::new();
        for (_, note) in notes {
            let col = self.col()?;
            let notetype = col.get_notetype(note.notetype_id)?.or_not_found(note.notetype_id)?;
            let fields: Vec<Value> = notetype
                .fields
                .iter()
                .zip(note.fields())
                .map(|(field, value)| json!({"name": field.name, "value": value}))
                .collect();
            let first_card = col.storage.all_cards_of_note(note.id)?.into_iter().min_by_key(|c| c.template_idx());
            let (deck, deck_id, state) = match first_card {
                Some(card) => {
                    let did = card.deck_id();
                    let deck = col.get_deck(did)?.map(|d| d.human_name());
                    let proto: anki_proto::cards::Card = card.into();
                    let state = match card_category(&proto) {
                        "suspended" => "suspended",
                        "new" => "new",
                        "learning" | "relearning" => "learning",
                        "mature" => "mature",
                        "buried" | "unknown" => "young",
                        other => other,
                    };
                    (deck, Some(did.0), Some(state))
                }
                None => (None, None, None),
            };
            hits.push(json!({
                "note_id": note.id.0, "model": notetype.name, "tags": note.tags, "fields": fields,
                "deck": deck, "deck_id": deck_id, "state": state,
            }));
        }
        Ok(json!({"anki": hits, "anki_total": total, "anki_error": null}))
    }

    /// Replace some of a note's fields, by field name.
    pub fn update_note_fields(&mut self, nid: i64, fields: &Map<String, Value>) -> Outcome<Value> {
        let col = self.col()?;
        let mut note = col.storage.get_note(NoteId(nid))?.or_not_found(NoteId(nid))?;
        let notetype = col.get_notetype(note.notetype_id)?.or_not_found(note.notetype_id)?;
        for (name, value) in fields {
            let index = notetype
                .fields
                .iter()
                .position(|f| &f.name == name)
                .ok_or_else(|| Failure::new(400, format!("The note has no field named {name:?}")))?;
            note.set_field(index, value.as_str().unwrap_or_default())?;
        }
        col.update_note(&mut note)?;
        Ok(json!({"success": true}))
    }

    /// Add a front/back note to `deck` with the Basic note type (or the first with two fields).
    pub fn add_basic_note(&mut self, deck: &str, front: &str, back: &str) -> Outcome<Value> {
        let did = self.deck_id(deck)?;
        let col = self.col()?;
        let mut notetypes = col.get_all_notetypes()?;
        notetypes.sort_by_key(|nt| nt.name != "Basic");
        let notetype = notetypes
            .into_iter()
            .find(|nt| nt.fields.len() >= 2 && nt.config.kind() == anki_proto::notetypes::notetype::config::Kind::Normal)
            .ok_or_else(|| Failure::new(400, "No note type with two fields found"))?;
        let mut note = notetype.new_note();
        note.set_field(0, front)?;
        note.set_field(1, back)?;
        col.add_note(&mut note, did)?;
        Ok(json!({"success": true, "note_id": note.id.0}))
    }

    /// Import an .apkg file (as AnkiConnect's importPackage does: with scheduling).
    pub fn import_package(&mut self, name: &str, data: &[u8]) -> Outcome<Value> {
        if !name.to_lowercase().ends_with(".apkg") && !name.to_lowercase().ends_with(".colpkg") {
            return Err(Failure::new(400, "Only .apkg files are supported"));
        }
        if name.to_lowercase().ends_with(".colpkg") {
            return Err(Failure::new(400, "That's a whole collection backup (.colpkg). Export a deck as .apkg instead."));
        }
        let dir = self.dir.join("imports");
        std::fs::create_dir_all(&dir).map_err(|e| Failure::new(500, e.to_string()))?;
        let path = dir.join(format!("import-{}.apkg", TimestampMillis::now().0));
        std::fs::write(&path, data).map_err(|e| Failure::new(500, e.to_string()))?;
        let options = ImportAnkiPackageOptions {
            merge_notetypes: false,
            update_notes: anki_proto::import_export::ImportAnkiPackageUpdateCondition::IfNewer as i32,
            update_notetypes: anki_proto::import_export::ImportAnkiPackageUpdateCondition::IfNewer as i32,
            with_scheduling: true,
            with_deck_configs: true,
        };
        let result = self.col().and_then(|col| Ok(col.import_apkg(&path, options)?));
        let _ = std::fs::remove_file(&path);
        let log = result?.output;
        let added = log.new.len();
        let updated = log.updated.len();
        Ok(json!({
            "success": true,
            "message": format!("Imported {name}: {added} new notes, {updated} updated"),
        }))
    }

    pub fn card_info(&mut self, cid: i64) -> Outcome<Value> {
        let card = self.proto_card(CardId(cid))?.ok_or_else(|| Failure::new(404, "Card not found"))?;
        Ok(json!({"cardId": card.id, "note": card.note_id, "deckId": card.deck_id, "type": card.ctype,
                  "queue": card.queue, "due": card.due, "interval": card.interval, "factor": card.ease_factor,
                  "reps": card.reps, "lapses": card.lapses}))
    }
}
