//! The C interface the iPhone app calls (see include/ankibase_engine.h).

use std::ffi::{c_char, CStr};
use std::sync::Mutex;

use crate::api::handle;
use crate::engine::Engine;

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

#[repr(C)]
pub struct AbReply {
    /// 0: not an Anki request, send it to the AnkiBase server instead.
    pub status: u16,
    pub content_type: *mut c_char,
    pub body: *mut u8,
    pub body_len: usize,
}

unsafe fn text<'a>(ptr: *const c_char) -> &'a str {
    if ptr.is_null() {
        ""
    } else {
        CStr::from_ptr(ptr).to_str().unwrap_or_default()
    }
}

/// Open the collection in `dir` (created if needed). Returns NULL on success, or an
/// error message to free with `ab_string_free`.
#[no_mangle]
pub unsafe extern "C" fn ab_open(dir: *const c_char) -> *mut c_char {
    let mut engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if engine.is_some() {
        return std::ptr::null_mut();
    }
    match Engine::open(text(dir)) {
        Ok(opened) => {
            *engine = Some(opened);
            std::ptr::null_mut()
        }
        Err(failure) => std::ffi::CString::new(failure.detail).unwrap_or_default().into_raw(),
    }
}

/// Answer an AnkiBase API request. Free the reply with `ab_reply_free`.
#[no_mangle]
pub unsafe extern "C" fn ab_request(
    method: *const c_char,
    path: *const c_char,
    body: *const u8,
    body_len: usize,
) -> AbReply {
    let data = if body.is_null() { &[][..] } else { std::slice::from_raw_parts(body, body_len) };
    let mut engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(engine) = engine.as_mut() else {
        return AbReply { status: 0, content_type: std::ptr::null_mut(), body: std::ptr::null_mut(), body_len: 0 };
    };
    let reply = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handle(engine, text(method), text(path), data)
    })) {
        Ok(reply) => reply,
        Err(_) => crate::api::Reply {
            status: 500,
            content_type: "application/json".into(),
            body: br#"{"detail":"The Anki engine crashed on this request"}"#.to_vec(),
        },
    };
    let body = reply.body.into_boxed_slice();
    let body_len = body.len();
    AbReply {
        status: reply.status,
        content_type: std::ffi::CString::new(reply.content_type).unwrap_or_default().into_raw(),
        body: Box::into_raw(body) as *mut u8,
        body_len,
    }
}

#[no_mangle]
pub unsafe extern "C" fn ab_reply_free(reply: AbReply) {
    ab_string_free(reply.content_type);
    if !reply.body.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(reply.body, reply.body_len)));
    }
}

#[no_mangle]
pub unsafe extern "C" fn ab_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(std::ffi::CString::from_raw(text));
    }
}
