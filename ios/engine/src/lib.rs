//! Anki's engine for the AnkiBase iPhone app.
//!
//! The app's web view talks to AnkiBase's usual HTTP API. Requests for the Anki parts of
//! it (decks, studying, media, AnkiWeb sync) are answered here, by Anki's own Rust library
//! working on a collection stored on the phone, so they keep working offline. Everything
//! else (stories, AI, Quizlet) still goes to the AnkiBase server.

mod api;
mod engine;
mod ffi;

pub use api::{handle, Reply};
pub use engine::Engine;
