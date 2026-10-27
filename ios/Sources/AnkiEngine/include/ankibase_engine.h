// The C interface of engine/ (Rust): the app's core, which answers everything the web
// view asks for (the web UI, Anki on the phone, the AnkiBase server). See engine/src/ffi.rs.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/// Called once per reply with its status and headers (a JSON object of strings).
typedef void (*ab_head_fn)(void *ctx, uint16_t status, const char *headers_json);
/// Called for each piece of the reply's body; return false to stop it.
typedef bool (*ab_data_fn)(void *ctx, const uint8_t *data, size_t len);

/// Start the core with a JSON config: {dir, web, pages, default_server, version, build,
/// update_feed}. NULL on success, otherwise an error message to free with ab_string_free.
char *ab_start(const char *config_json);

/// Answer a request. `target` is the path with its query; `headers_json` a JSON object.
/// Blocks until the reply is complete (streams call `data` as they go), so call it off the
/// main thread.
void ab_handle(const char *method, const char *target, const char *headers_json,
               const uint8_t *body, size_t body_len, void *ctx, ab_head_fn head, ab_data_fn data);

void ab_string_free(char *text);
