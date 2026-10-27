//! The AnkiBase iPhone app's core: Anki's engine with the collection on the phone, and
//! everything the app's web view asks for (see app.rs).

#[cfg(target_os = "android")]
mod android;
pub mod api;
pub mod app;
pub mod engine;
mod ffi;
pub mod http;
pub mod httpd;
mod notes;
mod pages;
pub mod server;
mod sessions;
mod stats;

pub use app::{App, Config};
pub use engine::Engine;
pub use http::{Collect, Reply, Request, Sink};
