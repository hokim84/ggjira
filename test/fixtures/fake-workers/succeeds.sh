#!/usr/bin/env bash
echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","duration_ms":10,"total_cost_usd":0.01,"num_turns":2,"session_id":"fake-session"}'
exit 0
