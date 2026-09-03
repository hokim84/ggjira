#!/usr/bin/env bash
output_file=""
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" == "--output-last-message" ]; then
    j=$((i + 1))
    output_file="${!j}"
  fi
done

echo '{"type":"turn.failed","error":{"message":"could not complete the task"}}'
if [ -n "$output_file" ]; then
  printf 'codex could not complete the task\n' >"$output_file"
fi
exit 1
