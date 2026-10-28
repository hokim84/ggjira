# ADR 0068: Validation command timeout and clearer validation evidence

## Context

The worker's `validateCommand` is the only check GGJIRA runs itself (ADR 0059). In the 2026-10-29
user-guide run (docs/known-issues.md #1–#3), the integration check of gg-repo PR #8 ran a GUI test
that opened a real error dialog and waited for someone to close it. The command was bounded only by
the job timeout (30 minutes), so the single worker took no other work for that long, and a window
appeared on the worker's desktop. When the failure was reported, the comment showed:

- output cut in the middle of a line,
- the exit code `4294967295` (Windows' -1 read as unsigned),
- no next step, although `재시도` reruns the same merged code and cannot fix a cause in it.

The same test had passed the child validation, and a passed command left no output at all, so
there was nothing to show whether it had skipped tests there.

## Decision

- Worker `repositories[].validateTimeoutMs` (default 10 minutes) bounds the validation command, for
  implementation and integration checks alike. The job timeout still applies when it is shorter.
  A command that runs past it has its process tree stopped, and the run fails with
  `"<command>" did not finish within <time> and was stopped`, followed by the end of its output.
- A failed command's output is cut to its last 2000 characters starting at a line boundary. The exit
  code is shown signed.
- A passed command's summary keeps its last output line (for example `OK (skipped=3)`), so the
  result comment shows what ran.
- A failed integration check's comment ends with the next step: fix an environment cause and have
  the assignee comment `재시도`, or, when the merged code is the cause, write it in the description
  and move the issue to the request status for a fix (the re-plan keeps finished children).

## Consequences

A hung test costs at most the validation timeout instead of the whole job. A project whose
checks legitimately run longer than 10 minutes sets `validateTimeoutMs`. Validation summaries are
display text only: Router does not parse them (the review gate counts them, ADR 0059), so the
longer pass summary changes no decision. Why the child validation passed while the integration
check hung on the same code is still unknown; the last output line is there to tell next time.
