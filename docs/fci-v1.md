# FCI: experimental Future Change Cost Index

FCI measures an experimental, relative view of a repository's future change difficulty. It is
not validated against actual development costs. It is **not** a development-time multiplier,
cost increase percentage, incident probability, PR approval rule, or implementation-effort score.
Higher values mean more maintenance burden under the selected rubric, not a prediction of money or hours.

## Enable and register a baseline

FCI is disabled unless explicitly enabled for a Router repository. In **저장소 FCI → FCI 설정**,
enable **FCI 사용**, enter **비교 시작 커밋** (the full 40-character baseline commit SHA) and
**분석 모델** (the explicit model ID configured on the Worker), then save. The starting commit
represents index 100 after a complete evaluation; it is not an estimate of actual development cost.
**고급 설정** is collapsed by default: leave the evaluation name and weights at their defaults unless
changing the rubric deliberately. Choose Claude Code there only when using a Claude Code Worker;
the default execution tool is Codex. Existing custom settings are preserved on save.
The history selector **비교 기록** appears only when multiple evaluation series exist.
The Worker repository must have the matching provider ID/model configured, using its existing CLI login.
The baseline is never silently selected from the current branch tip. The initial baseline analysis must
provide all five axes before normalized indices can be calculated. A queued/failed/unassessable baseline
is shown as such; it does not produce invented values of 100 or zero for later commits.

Example Router repository settings (configVersion **7**, Worker wire protocol **7**):

```json
{
  "id": "main-repo",
  "baseBranch": "main",
  "fci": {
    "enabled": true,
    "baselineSha": "<replace with an actual 40-character commit SHA>",
    "providerType": "codex",
    "modelId": "<the explicit model ID configured on the Worker>",
    "ruleVersion": "fci-v1",
    "weights": { "coupling": 0.25, "complexity": 0.20, "verification": 0.25, "ripple": 0.20, "history": 0.10 },
    "timeoutMs": 600000
  }
}
```

`providerType` can be `codex` or `claude-code`. For example, set `providers[].model` in
`worker.config.json` to the same explicit model ID. Account-selected defaults without a model ID
are not eligible for FCI. Router does not create credentials or install Unity Editor on Workers.

## Calculation and uncertainty

For each complete snapshot, the AI supplies evidence-backed integer grades `g_i` from 0 to 4.
Weights are configurable but must sum to 1. Arithmetic is deterministic:

```text
Axis raw score A_i(S) = 25 * g_i(S)
Repository raw score R(S) = sum(weight_i * A_i(S))   [0..100]
FCI(S) = 100 + R(S) - R(baseline)
deltaRaw = R(after) - R(before)
deltaFCI = FCI(after) - FCI(before)
Axis trend = 100 + A_i(S) - A_i(baseline)
```

The baseline index is 100 after successful complete evaluation. A raw baseline of zero is valid;
there is no division by zero. Scores are stored before display rounding. Under this affine formula,
raw and normalized deltas have the same numerical value; both underlying raw scores are retained.
No clipping or percentage conversion is applied. Any unavailable axis makes the overall raw score,
FCI and delta unavailable (`null`). Available axes remain visible. There is no weight redistribution.

### Versioned grading anchors

These are repository-structure examples, not rules to award points solely from a count.
Every assigned grade needs existing SHA-pinned file/line evidence and an explanation. Missing data
means uncertainty or an unavailable grade, never assumed high risk or an automatic zero.

| Axis / initial weight | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| Coupling / 25% | Clearly isolated modules | Limited direct dependencies | Coupling concentrated in shared modules | Cycles/state cross boundaries | Widespread cycles and hidden shared state |
| Structural complexity / 20% | Simple independent flows | Local branching | Repeated nesting/duplicated rules | Interacting branches and duplicated decisions | Change paths cannot readily be isolated |
| Verification difficulty / 25% | Core behavior independently verifiable | Some setup needed | Important verification gaps | Environment/global-state dependencies impede tests | Core outcomes very difficult to reproduce or judge |
| Ripple/interfaces / 20% | Narrow contracts, local impact | Limited consumers | Multiple consumers need coordination | Public/serialized contracts propagate broadly | Widespread hidden contracts require coordinated changes |
| Observed Git change risk / 10% | Sufficient history shows independent changes | Rare co-change | Repeated nonlocal co-change | Repeated fixes/reverts supported by structural evidence | Persistent cross-boundary correction chains |

Facts and AI judgments are separate. Deterministic facts include tracked AST observations, function
branch/nesting counts, resolvable imports, graph cycles/fan-in/fan-out, candidate duplicate bodies,
test paths, assembly dependencies, Unity GUID references and observed co-change pairs.
AI grades are not deterministic measurements. The index is a hypothesis about structure and testability.

## Language and Unity coverage

Languages are detected automatically. Version-pinned Tree-sitter WASM grammars support TypeScript,
TSX, JavaScript/JSX, Python and C#. No Python interpreter, .NET SDK or Unity Editor is needed just to parse.
The package lock pins `web-tree-sitter@0.24.7` and `tree-sitter-wasms@0.1.13` together. Runtime downloads
are not used. Newer unsupported syntax and parser errors are explicitly recorded.

The analyzer reads tracked regular files, excluding `.git`, dependency/build/cache folders such as
`node_modules`, Unity `Library/Temp/Logs/UserSettings/Build`, and `obj/bin/dist/coverage`.
It does not follow symlinks. Files over 2 MB and binary assets are recorded as observation gaps.
Unity observations include `.asmdef`/`.asmref` names and references, `.meta` GUIDs and references in
text `.unity`, `.prefab` and `.asset` files. Reference existence is not proof of runtime coupling.
C# reflection, compiler symbols, runtime dispatch, Unity lifecycle behavior, addressable/runtime-loaded
assets and binary serialized data are not fully resolved. Unsupported source languages remain visible
as coverage gaps; AI can inspect files but must not claim equivalent static coverage.

Git observations use the most recent **200 non-merge commits reachable from the evaluated SHA**, never
future commits or the current wall-clock date. Co-change pairs for commits touching over 40 source files
are omitted and the omission is disclosed. Large commits are not automatically penalized. Fewer than
10 commits lowers evidence quality; fewer than 2 makes the history axis unavailable.

FCI does not automatically rerun project tests. Snapshot evidence records `not_run` and the configured
validation command. Implementation and integration test results remain linked through the source job;
a cached structural evaluation is not evidence of fresh tests. No missing run is recorded as a pass.
Unity Editor/EditMode/PlayMode tests require a trusted validation command and an installed, usable Editor;
they are not implied by successful C# parsing.

## Lifecycle and cache

- Worker records the implementation start SHA before the AI call and spools reporting failures.
  Child results are preserved for parent assembly; they do not enqueue FCI analyses.
- Existing GitHub polling observes registered GGJIRA parent/direct PRs. Open or closed-unmerged PRs
  do not enqueue analyses. There are no implementation-result or pre-merge preview evaluations.
  Baseline registration remains independent of PRs. Legacy task/preview records are archived and
  cannot be retried; they never enter confirmed history.
- Actual merged before/after states are evaluated only after a human merges the parent/direct PR. Merge commits
  use the first parent. Squash and rebase use aggregate and per-commit stable patch IDs to establish a
  unique boundary. An ambiguous boundary is not silently approximated. The actual result must still
  belong to the configured target history. Closed, unmerged PRs do not enter the confirmed timeline.
- Confirmed points are ordered by their target first-parent ancestry. A gap between consecutive
  after/before SHAs is not interpolated: it may include untracked PRs, direct commits or missing analysis.
  A history rewrite is not joined to the old history as though it were continuous.
- Each snapshot is scored independently of the implementation's duration, number of retries or PR effort.
  PR delta is the difference between whole-repository states, not a sum of local risk penalties.
- Series identity includes repository, baseline, target branch, rubric, weights, analyzer/grammar version,
  prompt fingerprint and model/provider identity. Changing any condition creates another series and
  evaluates the registered baseline under those conditions. Old results remain available.
- A repository/SHA/profile is reused. In-flight snapshot claims coalesce simultaneous Workers. A partial
  result is preserved in attempt history but does not prevent a later complete retry. Explicit reanalysis
  creates a linked revision and does not replace the canonical historical curve automatically.

Model IDs reported by the CLI are checked against the configured ID. Configured-only identity is
labelled as such; provider/backend version not exposed by the CLI is `unreported`, not invented.
Silent changes behind a model alias and global CLI instructions remain reproducibility limitations.

## Failures, retry and operations

FCI has a separate queue, attempts, immutable evidence, leases, snapshot cache and reporting outbox.
Normal Jira jobs take priority. FCI does not occupy the issue's normal workflow-job slot, never creates
approval records, and never transitions issues. Analysis failure does not fail implementation.

The repository screen offers analysis retry, explicit reanalysis and report-only retry. Retrying does
not execute implementation code. The outbox uses one Jira comment marker per analysis; a new outcome
for a retry updates that comment. Uncertain writes look up the marker before creating a comment.
If a gateway cannot update the existing comment, reporting fails visibly rather than duplicating it.
Expired/late attempts remain auditable and cannot replace current results.

Admin API (existing bearer token): `GET /fci`, `GET /fci/:id`,
`PUT /repositories/:id/fci`, `POST /fci/:id/retry`, `POST /fci/:id/reanalyze`,
`POST /fci/:id/report-retry` under `/api/v1/admin`.
Worker FCI reserve/heartbeat/lookup/snapshot/result routes reuse Worker tokens and sessions.

Before upgrading, drain ordinary jobs, old AI-review jobs and result spools, back up SQLite, stop
Router/Worker, then run `npx tsx tools/migrate-fci-config.ts --apply` and update both processes.
Without `--apply`, the command only validates/previews. It backs up old config including review
instructions; those instructions are not automatically applied to FCI. Existing AI-review statuses are
retired from configuration/provisioning; move any remaining issues appropriately before hiding the
board column. Do not delete a shared Jira status blindly. Historical general-review records are retained.

When disabled, no FCI analysis/model calls/reporting occur. Existing historical data remains readable.
FCI cannot block PR approval, merge, integration completion or manual Done, even when enabled.

## Validation limits

Automatic checks use temporary Git repositories, SQLite, HTTP loopback and fake AI/Jira/GitHub.
Fixtures include wording-only changes, duplicated shared logic, deduplication and added tests; they
validate observations and evidence contracts, not a hardcoded expected AI score.
Actual AI score plausibility requires a separately recorded manual assessment; exact AI grades are not
a deterministic test oracle. C# parsing is not Unity Editor compilation. Real GitHub merges, real Jira
writes and real Unity tests must be reported separately from local fixtures.
