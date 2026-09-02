#!/usr/bin/env bash
trap '' TERM
echo '{"type":"system","subtype":"init"}'
# write our own pid + child (sleep) pid to a file so the test can verify cleanup
echo "$$" > "$PID_FILE"
sleep 30 &
echo $! >> "$PID_FILE"
wait
