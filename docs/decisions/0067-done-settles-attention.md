# ADR 0067: Moving an issue to Done settles its attention items

## Context

Attention items (ADR 0041) are what a person still has to look at. A fresh approval, a newer result
or a matching merge settles them; moving the issue to Done did not. In the 2026-10-29 user-guide
run, KAN-47 and KAN-52 sat in Done for a day while the dashboard still listed "결과에 주의사항
있음" for both (docs/known-issues.md #8). Done is always a person's move (ADR 0053), and it is the
last one: whatever the runs left for that person has been decided. Router never saw it, because
Done issues are not reconcile candidates.

## Decision

- Each reconcile pass looks up issues that still have open items of the kinds below and were not
  among this pass's candidates. One whose Jira status is its workspace's `doneStatus` has those
  items resolved with `moved to "<Done>" in Jira`.
- Settled kinds (`SETTLED_BY_DONE`): `failed`, `decision_needed`, `scope_deviation`,
  `review_required`, `plan_approval_refused`, `unassigned`. Router-side problems stay open:
  `report_blocked` (Jira refused a step) and `pull_request_unchecked` (GitHub access) are not fixed
  by Done.
- This is bookkeeping only, like every resolution: it runs nothing and records no review judgment.
  A child's unchecked criteria (ADR 0066) moved to Done count as accepted, as the human check asks.

## Consequences

The dashboard stops listing work a person has already closed. The lookup costs one `getIssue` per
issue with open items outside the candidate statuses, and an item is looked up only until it is
settled. A deleted or unreachable issue is skipped and looked at again on the next pass.
