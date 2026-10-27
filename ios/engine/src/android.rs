//! The Android app's entry point (android/…/Core.java): start the core on 127.0.0.1 for
//! the app's WebView (see httpd.rs).

use std::net::TcpListener;
use std::sync::{Arc, OnceLock};

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde_json::{json, Value};

use crate::app::{App, Config};

/// `{"port": …, "token": …}` of the running core (started once per process).
static STARTED: OnceLock<Value> = OnceLock::new();

fn start(config_json: &str) -> Value {
    STARTED
        .get_or_init(|| {
            let token = random_token();
            let mut config: Config = match serde_json::from_str(config_json) {
                Ok(config) => config,
                Err(err) => return json!({"error": format!("Bad config: {err}")}),
            };
            config.media_token = Some(token.clone());
            let listener = match TcpListener::bind(("127.0.0.1", 0)) {
                Ok(listener) => listener,
                Err(err) => return json!({"error": format!("Couldn't open a local port: {err}")}),
            };
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            let app = Arc::new(App::start(config));
            let serve_token = token.clone();
            std::thread::spawn(move || crate::httpd::serve(app, listener, Some(serve_token)));
            json!({"port": port, "token": token})
        })
        .clone()
}

/// 32 random bytes as hex, from the kernel's random source.
fn random_token() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        let _ = file.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `String Core.start(String configJson)`: JSON with the port and token, or an error.
#[no_mangle]
pub extern "system" fn Java_io_github_ankibase_Core_start<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    config: JString<'local>,
) -> jstring {
    let config: String = env.get_string(&config).map(Into::into).unwrap_or_default();
    let result = std::panic::catch_unwind(|| start(&config))
        .unwrap_or_else(|_| json!({"error": "The app's core crashed while starting"}));
    env.new_string(result.to_string()).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}
