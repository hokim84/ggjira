#!/usr/bin/env bash
# A --json-schema run: the result text carries a different (stale) JSON block than
# structured_output, so a test can tell which one the provider used.
echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"```json\n{\"outcome\":\"completed\",\"summary\":\"from text\"}\n```","structured_output":{"outcome":"needs_decision","summary":"from structured_output"},"duration_ms":10,"num_turns":1,"session_id":"fake-session"}'
exit 0
