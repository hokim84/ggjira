# ADR 0066: An unverified child completes automatically

## Context

ADR 0061 kept a child whose agent reported acceptance criteria as `not_verified` (and nothing
failed) in progress, and took a person moving it to `implementationCompleteStatus` as the
confirmation that those criteria hold. In use (KAN-50: three GUI criteria on a worker without a
display) the operator had to find the comment and move the card by hand before any dependent child
or the parent PR could go on, although the parent PR is merged by a person anyway. The board read
as if the run had stalled. A verified child already moves to `implementationCompleteStatus` by
itself.

A report-journal problem showed up while changing this: the comment journaled after a child's
transition was always skipped, because a result step finds its issue moved by the transition before
it and treats that as a human move.

## Decision

- A pushed child result awaiting a human check (ADR 0061's definition: only `not_verified` gaps,
  no failed check, no scope deviation) moves to `implementationCompleteStatus` like a verified
  child. Its comment lists the unchecked criteria and asks the person to check them before merging
  the parent PR, to record the confirmation on Router's review screen, and to move the issue back
  to `inProgressStatus` (after fixing the description) if something is wrong.
- Such a child counts as done for dependent children and the parent PR while it stays in
  `implementationCompleteStatus` or Done (`acceptedImplementation`). Because Router moves it, the
  status is no longer a person's confirmation: Router records no `jira-status` confirm and leaves
  the `review_required` attention item open.
- A confirm on the review screen stays the one judgment that completes such a child (ADR 0061): it
  records the confirmation, resolves the attention item and comments. Its transition finds the
  child already complete. The issue view keeps listing the unchecked criteria (`humanCheck`) for a
  child in progress or complete until that confirm.
- A child's result comments are journaled before its transition, so they reach Jira.
- This replaces ADR 0061's "stays in progress" and "a person's move is the confirmation". The
  worker side of ADR 0061 (a `not_verified` check does not fail a child) is unchanged.

## Consequences

Children and the parent PR no longer wait on a manual move, and the board shows a finished child as
finished. The human check moves to the parent PR merge: a person who merges without checking the
listed criteria accepts them unchecked; the open attention item and the review screen still show
them. Moving a child back to in progress after the parent PR was built withdraws that aggregate as
for any reopened child.
