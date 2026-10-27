// The C interface of engine/ (Rust): Anki's engine answering AnkiBase API requests.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct {
    /// 0: not an Anki request, send it to the AnkiBase server instead.
    uint16_t status;
    char *content_type;
    uint8_t *body;
    size_t body_len;
} AbReply;

/// Open the collection in `dir` (created if needed). NULL on success, otherwise an
/// error message to free with ab_string_free.
char *ab_open(const char *dir);

/// Answer an AnkiBase API request (`path` may carry a query). Free with ab_reply_free.
AbReply ab_request(const char *method, const char *path, const uint8_t *body, size_t body_len);

void ab_reply_free(AbReply reply);
void ab_string_free(char *text);
