# ADR 0061: Human confirmation completes an unverified child

## Context

ADR 0056 lets a child count as done only with verified, published results: every acceptance check
`pass` with evidence. The worker enforced this before commit, so a child whose agent honestly
reported `not_verified` (KAN-47: a GUI criterion on a worker that cannot open a window) failed with an
unclassified error and kept its change only as a local patch. A retry fails the same way, and nobody
can accept the result: ADR 0043 made review judgments records that move nothing, and a child someone
completes by hand never counts. An agent that claimed `pass` instead would have gone through, which is
the opposite of what ADR 0059 asks of agents. People also want to finish the workflow in Jira, without
the Router UI.

## Decision

- The worker no longer fails a child for `not_verified` checks. A `fail` check still fails it
  (`Verification failed: …`, GGJ-302) and an empty report still fails it (GGJ-303). Otherwise it
  commits, runs the validation command and pushes the result branch as for a verified child.
- Router calls a pushed, completed child result *awaiting a human check* when its only gap is
  `not_verified` criteria (no failed check, no scope deviation, every other check `pass` with
  evidence). It stays in progress without the failure label, with a comment listing those criteria
  and asking the person to move the issue to `implementationCompleteStatus` once they have checked
  them. Review-gate already marks it `not_verified` (immediate) and opens a `review_required` item.
- A person moving that issue to `implementationCompleteStatus` (or Done) is the confirmation. Router
  never moves a waiting child itself, so the status is the person's answer: `acceptedImplementation`
  = verified by its checks, or awaiting a human check and in one of those statuses. The first time
  Router sees it, it records a confirm on the result's review target (actor `jira`, authentication
  `jira-status`) and resolves the attention item. Jira's issue history says who moved it. The approved
  inputs must still match, so a manual completion after the request changed still does not count.
- A confirm on the review screen does the same through Router: it moves the child and comments,
  naming the person. This amends ADR 0043 (the one judgment that moves a status) and ADR 0056 (a
  person's move counts as verification for this case only). Hold and rework stay records; stale
  targets are refused as before.

## Consequences

Work that needs a person's eyes (screens, devices, external systems) can finish in Jira without
lowering what an agent must prove, and the agent is no longer rewarded for claiming checks it could
not run. Anyone Jira lets move the issue can confirm it; restricting that is Jira workflow
permissions' job. A child moved to complete while its result failed, or without a result, still does
not count. Direct tasks are unchanged: they open a PR and a person merges it.
