# ADR 0058: Task-centered Router UI

The top-level UI contains dashboard, workers, repository FCI, settings and guide. Review and issue
screens no longer represent separate required workflow stages. Dashboard lists the latest local
execution per issue, including waiting/running/failed work, with links into task detail. Its labels
describe execution records rather than claiming to be live Jira status. Task detail reads current
Jira state and explains the next action, recent applied result and PR, with technical history folded.

Human confirmation/hold/rework records remain optional inside task detail and are scoped to that
issue. A hold opinion does not pause execution; a rework opinion does not start implementation.
Existing note requirements, stale-target rejection, audit records and Jira-comment reporting remain.
Result/commit review targets are preserved for exact PR merge-SHA matching. Remove the global review
waiting count from the UI without deleting those records or altering the approval/status policies.

Connection diagnostics move under settings and explain first-setup, configuration-change and
integration-error usage. Results prioritize failures/manual checks and collapse successful checks.
Diagnostics read settings/Jira/GitHub; they do not execute code or replace post-merge validation.

Add the read-only paginated admin `GET /tasks`, with no per-row Jira calls. Add optional `issue`
filtering to the existing review API. Old UI hashes redirect to dashboard/task detail/diagnostics.
Resolve route paths separately from query strings so deep links preserve their selected task/repository.
There is no schema migration, Worker protocol change or new approval step.
