#!/usr/bin/env bash
# Writes each argument on its own line to $GGJIRA_FAKE_ARGS_FILE, then succeeds like either CLI.
printf '%s\n' "$@" >"$GGJIRA_FAKE_ARGS_FILE"
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" == "--output-last-message" ]; then
    j=$((i + 1))
    printf 'done\n' >"${!j}"
  fi
done
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","duration_ms":10,"session_id":"fake-session"}'
exit 0
