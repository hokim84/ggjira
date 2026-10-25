# ADR 0056: Parent aggregate PR and post-merge evaluation

## Decision

Supersedes ADR 0053 child-PR integration gates and ADR 0055 implementation-result/PR-preview FCI scheduling.
Router configuration remains version 7; Worker protocol becomes 7 and database migration 22 adds aggregate execution records.
All existing individual human implementation approvals and manual Done remain required.

Children publish verified result commits without opening PRs, then become AI 구현 완료. Dependencies consume
current approved, published result commits, not merged child PRs. No changed contract, manually completed issue,
missing verification or unpublished commit can count as a finished dependency or aggregate source.
After all current, non-superseded children finish, `assemble_pr` runs through the existing queue/lease/authorization
and result spool. It performs deterministic Git operations without initializing an AI provider or running the
post-merge validation command. It merges pinned heads in dependency order into an isolated worktree fetched
from the current target, preserves shared checkout edits, pushes a parent branch and creates one parent PR.

The immutable manifest records parent/plan/cycle, child result IDs, base/head SHAs, dependencies and legacy
integration evidence. A source change cancels stale assembly/publication/completion. An open parent PR is
updated by fast-forward publication; retries recover its existing remote head and PR. No forced push,
automatic target-branch merge or AI conflict resolution is permitted. Conflicts identify paths and require
separately approved implementation. A new cycle after merge creates a new PR. Unchanged siblings are retained.

Only successful aggregate publication moves the parent to AI 통합 대기. After a human merges, trusted
integration validation runs at the actual immutable merge SHA. Concurrent target-branch advances do not
change that target; loss of ancestry or stale source results prevents completion. Successful validation moves
only the parent to AI 구현 완료; FCI failure cannot block it. Integration, assembly, FCI and Jira reporting
retry separately without rerunning successful children. Empty aggregates skip PR creation and run parent
validation; they do not invent PR FCI. Direct tasks retain one PR and the same post-merge evaluation policy.

FCI keeps explicit baseline registration, deterministic facts, per-SHA cache, independent report outbox and
actual squash/rebase/concurrent-merge boundaries. It creates no child/task-result or pre-merge preview
analysis. Legacy records are archived, excluded from confirmed trends and cannot be retried under the retired policy.

## Cutover

Drain running work and all Worker spools, back up DB/config, stop Router/Worker, dry-run then apply
`tools/migrate-aggregate-pr.ts`. Preserve approvals, commits, branches and historical records. Verified legacy
children in integration pending are marked implementation complete. Current aggregate inputs must be ready
before moving a parent back to automatic coordination; a parent Done is never reopened.
Already merged child changes are recognized through actual integration evidence, checked against target
ancestry and not merged a second time. Remaining changes form the new parent PR. Once the replacement PR
exists, Worker closes old unmerged child PRs with a replacement link; it never deletes branches.
Restart both processes on protocol 7. Migration is resumable; missing/changed/unpublished evidence is held
explicitly instead of manufacturing completion or automatically reimplementing work.

Automated verification uses Fake Jira/providers, real HTTP, temporary SQLite and local Git remotes.
Actual Jira transitions, GitHub writes and AI CLI execution are reported separately from these tests.
