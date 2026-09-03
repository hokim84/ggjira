#!/usr/bin/env bash
output_file=""
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" == "--output-last-message" ]; then
    j=$((i + 1))
    output_file="${!j}"
  fi
done

echo '{"type":"item.completed","item":{"type":"agent_message"}}'
if [ -n "$output_file" ]; then
  printf 'codex finished the task\n' >"$output_file"
fi
exit 0
