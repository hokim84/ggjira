#!/usr/bin/env bash
# Fake Codex for plan-usage tests: `app-server` answers initialize and account/rateLimits/read over
# stdio JSON-RPC; `exec` behaves like codex-succeeds.sh.
if [ "$1" == "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"id":1'*) echo '{"id":1,"result":{"userAgent":"fake"}}' ;;
      *'"id":2'*)
        echo '{"method":"account/updated","params":{"planType":"plus"}}'
        echo '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":3,"windowDurationMins":300,"resetsAt":1790674690},"secondary":{"usedPercent":61.25,"windowDurationMins":10080,"resetsAt":1791162475},"planType":"plus","rateLimitReachedType":null}}}'
        ;;
    esac
  done
  exit 0
fi
output_file=""
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" == "--output-last-message" ]; then
    j=$((i + 1))
    output_file="${!j}"
  fi
done
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
if [ -n "$output_file" ]; then
  printf 'codex finished the task\n' >"$output_file"
fi
exit 0
