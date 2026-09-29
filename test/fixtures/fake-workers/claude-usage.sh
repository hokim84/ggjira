#!/usr/bin/env bash
# Fake Claude Code for plan-usage tests: `auth status` prints the plan, anything else is a run that
# reports a rate_limit_event before its result.
if [ "$1" == "auth" ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
  exit 0
fi
echo '{"type":"system","subtype":"init"}'
echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790674200,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.8123,"resetsAt":1790674200},"seven_day":{"utilization":0.17,"resetsAt":1790906400}}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"fake-session"}'
exit 0
