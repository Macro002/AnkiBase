//! The C interface the iPhone app calls (see include/ankibase_engine.h).

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;

use crate::app::{App, Config};
use crate::http::{Reply, Request, Sink};

static APP: OnceLock<App> = OnceLock::new();

pub type HeadFn = unsafe extern "C" fn(ctx: *mut c_void, status: u16, headers_json: *const c_char);
pub type DataFn = unsafe extern "C" fn(ctx: *mut c_void, data: *const u8, len: usize) -> bool;

unsafe fn text<'a>(ptr: *const c_char) -> &'a str {
    if ptr.is_null() {
        ""
    } else {
        CStr::from_ptr(ptr).to_str().unwrap_or_default()
    }
}

/// Start the app with a JSON config (app.rs `Config`). NULL on success, otherwise an error
/// message to free with `ab_string_free`. Later calls do nothing.
#[no_mangle]
pub unsafe extern "C" fn ab_start(config_json: *const c_char) -> *mut c_char {
    if APP.get().is_some() {
        return std::ptr::null_mut();
    }
    match serde_json::from_str::<Config>(text(config_json)) {
        Ok(config) => {
            let _ = APP.set(App::start(config));
            std::ptr::null_mut()
        }
        Err(err) => CString::new(format!("Bad config: {err}")).unwrap_or_default().into_raw(),
    }
}

struct Callbacks {
    ctx: *mut c_void,
    head: HeadFn,
    data: DataFn,
    started: bool,
}

impl Sink for Callbacks {
    fn head(&mut self, status: u16, headers: &[(String, String)]) {
        let map: serde_json::Map<String, serde_json::Value> =
            headers.iter().map(|(n, v)| (n.clone(), serde_json::Value::String(v.clone()))).collect();
        let json = CString::new(serde_json::to_string(&map).unwrap()).unwrap_or_default();
        self.started = true;
        unsafe { (self.head)(self.ctx, status, json.as_ptr()) }
    }

    fn data(&mut self, bytes: &[u8]) -> bool {
        unsafe { (self.data)(self.ctx, bytes.as_ptr(), bytes.len()) }
    }
}

/// Answer a request: `head` is called once, then `data` for each piece of the body (return
/// false from it to stop). Blocks until the reply is complete, so call it off the main thread.
#[no_mangle]
pub unsafe extern "C" fn ab_handle(
    method: *const c_char,
    target: *const c_char,
    headers_json: *const c_char,
    body: *const u8,
    body_len: usize,
    ctx: *mut c_void,
    head: HeadFn,
    data: DataFn,
) {
    let mut sink = Callbacks { ctx, head, data, started: false };
    let Some(app) = APP.get() else {
        return Reply::error(500, "The app hasn't started").send(&mut sink);
    };
    let headers: Vec<(String, String)> = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text(headers_json))
        .unwrap_or_default()
        .into_iter()
        .map(|(n, v)| (n, v.as_str().unwrap_or_default().to_string()))
        .collect();
    let request = Request {
        method: text(method).to_string(),
        target: text(target).to_string(),
        headers,
        body: if body.is_null() { Vec::new() } else { std::slice::from_raw_parts(body, body_len).to_vec() },
    };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.handle(&request, &mut sink)));
    if outcome.is_err() && !sink.started {
        Reply::error(500, "The app crashed on this request").send(&mut sink);
    }
}

#[no_mangle]
pub unsafe extern "C" fn ab_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(CString::from_raw(text));
    }
}
