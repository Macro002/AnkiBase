//! AnkiBase on a computer. Like the Android app, the app's core (../ios/engine) serves the
//! web UI and Anki's engine on 127.0.0.1 behind a random token (see httpd.rs), and this
//! shows it in a native window: WebView2 on Windows, WebKit on macOS and Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::sync::Arc;

use ankibase_engine::{httpd, App, Config};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// New versions: GitHub's latest release, with this platform's installer (see app.rs).
const UPDATE_FEED: &str = "https://api.github.com/repos/Macro002/AnkiBase/releases/latest";

const PLATFORM: &str = if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let resources = app.path().resource_dir()?;
            let version = app.package_info().version.clone();
            // The same build number as the Android app's versionCode.
            let build = (version.major * 10000 + version.minor * 100 + version.patch).to_string();
            let token = token();

            let listener = TcpListener::bind(("127.0.0.1", 0))?;
            let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
            let core = Arc::new(App::start(Config {
                dir: data.join("ankibase"),
                web: Some(resources.join("web")),
                pages: Some(resources.join("pages")),
                default_server: option_env!("ANKIBASE_SERVER").filter(|s| !s.is_empty()).map(Into::into),
                version: version.to_string(),
                build: build.clone(),
                update_feed: Some(UPDATE_FEED.into()),
                bundle_id: Some(app.config().identifier.clone()),
                media_token: Some(token.clone()),
            }));
            let serve_token = token.clone();
            std::thread::spawn(move || httpd::serve(core, listener, Some(serve_token)));

            // What the page knows about the app (frontend/src/native.ts).
            let info = serde_json::json!({"version": version.to_string(), "build": build, "platform": PLATFORM});
            let start = format!("{origin}/__start?token={token}").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start))
                .title("AnkiBase")
                .inner_size(1200.0, 820.0)
                .min_inner_size(380.0, 560.0)
                .initialization_script(&format!("window.ankibaseNative = {info};"))
                .on_navigation(move |url| {
                    // Links out of the app open in the browser (frames' about: pages stay).
                    let external = matches!(url.scheme(), "http" | "https" | "mailto")
                        && !url.as_str().starts_with(&format!("{origin}/"));
                    if external {
                        let _ = open::that_detached(url.as_str());
                    }
                    !external
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AnkiBase couldn't start");
}

/// 32 random bytes as hex.
fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("no random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
