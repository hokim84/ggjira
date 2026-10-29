# ADR 0069: Done or deleted issues leave the attention list and the review queue

## Context

ADR 0067 settles an issue's attention items when a person moves it to Done. Re-running the
user-guide scenario on 2026-10-29 (KAN-58~61, docs/known-issues.md #13·#14) showed two gaps:

- KAN-47 had been deleted in Jira. The settling pass skipped every lookup error, so its
  `review_required` item stayed on the dashboard for good and cost one Jira lookup on every pass.
- The review queue (ADR 0043) still listed the results of Done issues as `pending`, and
  `router status` counted them in `reviews waiting` (9, among them KAN-52·54~57·61 in Done and the
  deleted KAN-47). The queue
  holds results waiting on a person's look; a person who moved the issue to Done has looked.

## Decision

- The settling pass also looks up issues whose current result still waits in the review queue.
- An issue whose Jira status is `doneStatus`, or for which Jira answers 404 (deleted), is closed:
  - its `SETTLED_BY_DONE` attention items are resolved with `moved to "<Done>" in Jira` or
    `deleted in Jira`;
  - each waiting result gets a review record `issue.closed` (actor none, authentication `jira`,
    outcome `unverified`, detail `{ reason: "done" | "deleted", status }`). A result with that record
    is in the new queue state `closed` and leaves the waiting list and count.
- Only 404 counts as deleted. Any other error (permission, network, rate limit) is looked at again on
  the next pass, as before.
- `issue.closed` is not a judgment. A person can still confirm, hold or ask for rework afterwards;
  that judgment takes precedence in the queue state, as a merge or a confirmation does.

## Consequences

The dashboard and `reviews waiting` stop counting work a person has finished or removed. Each such
issue is looked up until it is closed, then never again. Jira also answers 404 when the Router's
account loses permission to see an issue; that issue's items are closed as deleted, which is the
right outcome for an issue Router can no longer report to. A result closed by Done and then reopened
in Jira without a new run stays `closed`; the next run's result is a new target and waits again.
