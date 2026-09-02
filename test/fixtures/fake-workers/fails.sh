#!/usr/bin/env bash
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","subtype":"error","is_error":true,"result":"could not complete the task","duration_ms":5,"session_id":"fake-session-fail"}'
exit 1
