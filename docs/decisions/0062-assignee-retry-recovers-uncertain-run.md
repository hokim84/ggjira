# ADR 0062: The assignee's retry recovers an uncertain run

## Context

A started run whose worker stops answering (worker stopped, network lost, worker revoked) goes to
`recovery_required` and is never rerun by itself (ADR 0020, 0021): Router cannot tell whether the
agent is still changing a working copy. Until now only an admin could release it, with
`router jobs resolve` or `jobs retry`, and Jira said nothing while it waited. People who work only in
Jira saw an issue stuck in progress with no explanation and no way to move it on. Every other
human step of the issue lifecycle (requests, answers, approval, retry after a failure, merge, Done,
and the human check of ADR 0061) already happens in Jira.

## Decision

- Once per attempt, the reconcile pass comments on an issue whose run is `recovery_required`: what
  happened, that GGJIRA will not rerun it by itself, and that the assignee's "재시도" comment starts a
  new run once the worker is known to be stopped.
- The current assignee's "재시도" comment, posted after the run became `recovery_required`, counts as
  the stop confirmation: the attempt becomes `superseded`, the job closes (`job.resolved`, actor
  `jira:<accountId>`) and the same request runs again under a new approval, exactly as a retry after
  a failure (the comment is consumed once, `workflow_retry_comments`). Comments by anyone else do
  nothing.
- The admin commands stay for operators.

## Consequences

The confirmation is now the assignee's statement rather than an admin's check on the worker machine.
If the old run was in fact still going, the work runs twice: both write only to their own job branch
and worktree, and the old attempt's late result is not applied (ADR 0021), but the old agent may still
push its branch. The Jira comment says so. Router config, the database schema and the wire protocol do
not change.
