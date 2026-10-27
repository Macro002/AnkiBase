//! Anki's own pages (Statistics, Deck Options, Card Info, Congrats) on the phone.
//!
//! The pages are Anki Desktop's SvelteKit app, bundled with the app (scripts/anki-pages.py
//! takes them from the `aqt` wheel matching the engine's Anki). They call the backend by
//! POSTing protobuf messages to `/anki-pages/_anki/<method>`, answered here.

use anki::prelude::*;
use prost::Message;

use crate::engine::{Engine, Failure, Outcome};

/// (service, method) indices of the backend methods the pages use, in Anki 26.09.3's
/// collection services (rslib's generated `run_service_method`).
const METHODS: &[(&str, u32, u32)] = &[
    ("i18nResources", 34, 2),
    ("getDeckNames", 6, 13),
    ("getDeck", 6, 8),
    ("getConfigBool", 8, 5),
    ("getConfigJson", 8, 0),
    ("setConfigJson", 8, 1),
    ("getNotetypeNames", 22, 8),
    // statistics
    ("cardStats", 42, 0),
    ("getReviewLogs", 42, 1),
    ("graphs", 42, 2),
    ("getGraphPreferences", 42, 3),
    ("setGraphPreferences", 42, 4),
    ("congratsInfo", 12, 8),
    // deck options and FSRS
    ("getDeckConfigsForUpdate", 10, 6),
    ("updateDeckConfigs", 10, 7),
    ("getIgnoredBeforeCount", 10, 8),
    ("getRetentionWorkload", 10, 9),
    ("computeFsrsParams", 12, 27),
    ("getOptimalRetentionParameters", 12, 28),
    ("computeOptimalRetention", 12, 29),
    ("simulateFsrsReview", 12, 30),
    ("simulateFsrsWorkload", 12, 31),
    ("evaluateParamsLegacy", 12, 33),
    ("latestProgress", 2, 6),
    ("setWantsAbort", 2, 7),
];

/// Desktop window plumbing the pages call; nothing to do on a phone.
const WINDOW_METHODS: &[&str] = &["deckOptionsReady", "deckOptionsRequireClose"];

impl Engine {
    /// Answer one backend call from a page (an empty reply is a valid answer).
    pub fn page_call(&mut self, method: &str, input: &[u8]) -> Outcome<Vec<u8>> {
        if WINDOW_METHODS.contains(&method) {
            return Ok(Vec::new());
        }
        match method {
            // Anki Desktop's profile settings: kept for this launch only.
            "getProfileConfigJson" | "getMetaJson" => {
                let key = anki_proto::generic::String::decode(input).map_err(bad_input)?.val;
                let json = self.page_settings.get(&key).cloned().unwrap_or_else(|| b"null".to_vec());
                return Ok(anki_proto::generic::Json { json }.encode_to_vec());
            }
            "setProfileConfigJson" | "setMetaJson" => {
                let request = SetSettingJsonRequest::decode(input).map_err(bad_input)?;
                self.page_settings.insert(request.key, request.value_json);
                return Ok(Vec::new());
            }
            _ => {}
        }
        let &(_, service, index) = METHODS
            .iter()
            .find(|(name, _, _)| *name == method)
            .ok_or_else(|| Failure::new(404, format!("{method} isn't available to pages.")))?;
        self.col()?.run_service_method(service, index, input).map_err(|error| {
            let message = anki_proto::backend::BackendError::decode(error.as_slice())
                .map(|e| e.message)
                .unwrap_or_else(|_| "The Anki engine failed".into());
            Failure::new(500, message)
        })
    }

    /// The Statistics page shows `deck:current`; select the deck first, as Anki Desktop does.
    pub fn select_deck(&mut self, deck_id: i64) -> Outcome<()> {
        let col = self.col()?;
        if col.get_deck(DeckId(deck_id))?.is_none() {
            return Err(Failure::new(404, format!("Deck not found: {deck_id}")));
        }
        if col.get_current_deck()?.id != DeckId(deck_id) {
            col.set_current_deck(DeckId(deck_id))?;
        }
        Ok(())
    }
}

/// anki.frontend.SetSettingJsonRequest (the frontend protos aren't part of anki_proto).
#[derive(Clone, PartialEq, prost::Message)]
struct SetSettingJsonRequest {
    #[prost(string, tag = "1")]
    key: String,
    #[prost(bytes = "vec", tag = "2")]
    value_json: Vec<u8>,
}

fn bad_input(err: prost::DecodeError) -> Failure {
    Failure::new(400, err.to_string())
}
