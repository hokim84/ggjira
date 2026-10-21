# ADR 0051: Child approval and parent completion quality review

## Context

The parent is a coordination unit. Moving it into in-progress merely to authorize children
adds a redundant action and hides the distinction between approving one task and approving
all work. Finishing children does not demonstrate that their integrated result meets the
parent objective or that maintenance costs have been considered.

## Decision

New planning requests use lifecycle v2. A valid plan must have at least one child, parent
acceptance criteria and integration verification. Publishing creates waiting children; each
human move of a child to in-progress authorizes only that frozen contract. The parent remains
in requestStatus until all mandatory children are reviewed, completed and actually integrated.
This supersedes the parent-approval and automatic child-start rules of ADRs 0044/0050 for v2.
Existing requests retain v1 and finish under their original rules.

Protocol 3 adds quality_review, qualityContext/quality and Git integration evidence. Workers
fetch a target, verify dependency merge ancestry and use an isolated worktree. The trusted
Worker validateCommand runs with cancellation and timeout; the review provider is read-only.
Neither exit success nor a manual Jira completion substitutes for integration or verification.

Evidence-based findings are judged one at a time through numbered Jira comments by the current
parent assignee. Fix-now adds an immutable plan extension and a mandatory child, still awaiting
manual start. Deferral creates a separately linked Task by default; accept/dismiss and hold
require reasons. Defects, environment failures and unknown evidence cannot be waived through
deferral or acceptance. Follow-up issue type is planning.followupIssueType.

The parent completion procedure carries previous findings/decisions into focused rechecks after
improvements. Final freshness and trusted validation are checked without an additional model
call. Only a fully satisfied gate journals the parent move from requestStatus to reviewStatus;
the parent is never automatically done or merged. Changed targets require an explicit retry.

Migration 17 preserves job data, foreign keys and indexes while extending the job-kind CHECK,
and stores lifecycle versions, merge evidence, evaluation runs, decisions and plan extensions.
Creation and transitions reuse the report journal, including uncertain-write recovery.

## Consequences

Router and Workers must upgrade together after in-flight calls and spool results settle.
Lifecycle v2 initially requires Git, matched reviewed PR heads, actual merge commits and a
trusted validation command. Missing evidence holds completion. No extra Jira AI status is needed,
but requestStatus must be able to transition directly to reviewStatus.

Editing requirements after work has started holds new work and final completion. Running work
finishes under its existing contract; an assignee replan request is accepted after execution
settles, and started/completed tasks must be explicitly preserved. A manually closed parent is
respected as a withdrawal and recorded as incomplete verification.

Automatic tests use Fake Jira/providers, temporary SQLite and local Git remotes. Real Jira
permissions, transitions and provider CLI behavior require separate operational verification.
