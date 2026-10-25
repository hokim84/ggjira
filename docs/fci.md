# FCI: one graph, deterministic structural observations

FCI is an **experimental relative structural index**, not validated development cost, elapsed time,
failure probability, or an approval gate. Higher values indicate more structural change burden under
the selected rule. Repositories and languages should not be ranked against one another with it.

The UI calls this **기술부채 추이**, with the heading **코드 구조 기반 기술부채 추이** and the score
**구조 부채 지수**. This is a structural proxy for one aspect of technical debt, not a measurement of
all debt: test deficiencies, security findings and outdated dependencies are outside the score.
The internal FCI identifiers, calculation rules, series, baselines and saved scores are unchanged.

## Use

Open **기술부채 추이**, enable **기술부채 추적 사용** and enter **비교 시작 커밋** (7–40 hexadecimal characters).
The Worker resolves an unambiguous commit and checks that it is on the configured target branch's
first-parent history. No language, model, weight, or provider input is required.
An offline Worker means pending verification; an invalid baseline produces an explicit error.

The baseline is evaluated automatically. **다음 커밋 평가** evaluates one oldest missing commit;
**미평가 모두 평가** fills the known historical range. **일시정지** stops scheduling historical work
after the current commit finishes. Press the all button to resume. Completed snapshots are reused.
The known target tip is frozen when requesting a range; newly arriving target commits are evaluated
automatically through Worker polling. Failed/unassessable commits require explicit retry and do not
loop indefinitely. An unassessable baseline blocks normalized history until corrected/retried.

There is one chart, with overall FCI shown initially. The legend toggles the four component lines.
Pages contain 100 commits, retaining individual points and keyboard-accessible selection. Missing
and failed observations break lines instead of producing zero/stale points. Selecting a point opens
evidence, confidence, raw observations, PR/Jira references and independent retries.

**AI로 설명** explicitly requests a read-only explanation from the existing Worker provider.
It never changes the static score. No explicit model ID is required for this explanation; the reported
model or `unreported`, prompt hash, frozen input, evidence and result remain in the attempt record.
The prompt is editable at **설정 → 프롬프트 → 기술부채 변화 설명**. Explanation and Jira-report failure
are separate from structural-analysis and implementation failure.

## Rules: fci-static-v2

The four components have equal weights. Let `clamp(x)=max(0,min(1,x))` and
`Q(values)=(mean(values)+nearest-rank-90th-percentile(values))/2`.

| Component | Raw score, 0–100 |
| --- | --- |
| Dependency | `100 × (0.7 × Q(clamp(file fanOut/10)) + 0.3 × cycle-participating-file fraction)` |
| Complexity | `100 × Q(0.6 × clamp((function cyclomatic−1)/14) + 0.4 × clamp((nesting−1)/4))` |
| Duplication | `100 × excess duplicated function-body tokens / all evaluated function-body tokens` |
| Ripple | `100 × Q(clamp(unique transitive dependent files/20))` |

These constants are experimental anchors, not empirically validated cost thresholds. Cycles and
transitive reachability count each consumer once and exclude self. Nested functions are evaluated
independently rather than being counted in their outer function. Duplication considers bodies of at
least 50 syntax tokens, ignores comments/whitespace, normalizes local names and preserves operators
and literals. Different languages are not compared as textual clones. All product function tokens
form the duplication denominator; trivial bodies alone do not count as clones.

```text
R(S) = mean(four raw component scores)
FCI(S) = 100 + R(S) - R(baseline)
componentIndex(S) = 100 + componentRaw(S) - componentRaw(baseline)
delta = FCI(after) - FCI(before)
```

Raw values are saved before rounding. A zero raw baseline is valid. Missing components are null,
never zero or redistributed weights. A repository with no assessable product source cannot establish
100. Fewer than 80% of candidate product files parsed successfully makes the aggregate unavailable.
Unresolved internal references lower confidence; if reference candidates exist but none resolve,
dependency and ripple are unavailable. Otherwise the graph is an explicitly partial observation.
Known absence of branches, clones or internal references in observed code is a legitimate zero.

File/line counts do not add a penalty. Adding simple code can change distributions; commonization can
reduce duplication while increasing ripple. Component changes expose these tradeoffs. Test code,
generated code, dependencies and build outputs are excluded from product scores. Test presence,
actual execution evidence, co-change history and Unity serialization are context only. Adding tests
alone therefore does not lower structural FCI. Parsing C# does not compile Unity or run Editor tests.

## Language coverage and limits

Pinned Tree-sitter grammars cover TS/TSX, JS/JSX/MJS/CJS, Python and C#. Source files form the common
graph; class/type references project into file edges. C# namespaces, using scopes, type declarations,
partial-type files, fields, parameters, return types, inheritance and explicit static references are
observed conservatively. Ambiguous references are not guessed. JS/TS relative imports, `.js` to `.ts`
source resolution, local path aliases, literal require/import and re-exports are considered. Inherited
tsconfig aliases are disclosed as gaps. Python package and relative imports are observed.

Reflection, runtime dispatch, computed imports, custom build resolution, binary assets and Unity
lifecycle dependencies are not fully resolved. `.asmdef`/`.asmref` and text asset GUID references
remain separate evidence; framework types or prefab counts do not inflate structural scores.
Tracked regular files only; symlinks and files over 2 MB are skipped and disclosed. Unsupported or
skipped source counts against coverage. Per-file parse results use a bounded in-process cache keyed
by analyzer, path and content hash. Durable whole-snapshot caching survives restarts.

Design references: [Tree-sitter queries](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html),
[AST graph analysis and its limits](https://arxiv.org/abs/2308.15669),
[class coupling](https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-class-coupling?view=visualstudio),
[Git first-parent traversal](https://git-scm.com/docs/git-rev-list).

## History, PRs, reliability

Only actual target first-parent states enter the curve, including direct commits. Unmerged PR branches
are excluded. Rebase commits appear as actual target commits; merge commits represent the resulting
target state. PR delta still uses proven actual merge boundaries, not a sum of intermediate penalties.
Ambiguous PR boundaries can fail independently of valid commit snapshots. Historical backfills never
create bulk Jira comments; existing registered parent/direct PR reporting retains its outbox/marker.

Worker history scans run at most once per minute through the existing polling queue. Ordinary jobs
take priority. SQLite persists the initial tip, known history, range, pause state and attempts. SHA +
series + revision deduplicates observations; overlapping PR and history tasks share snapshot claims.
Retries do not execute implementation. Explicit reanalysis keeps an auditable revision and does not
silently replace the canonical curve. Force-pushed-away commits remain archived and are removed from
the active curve. Losing baseline ancestry stops evaluation instead of joining unrelated histories.

Admin routes under `/api/v1/admin`:

- `GET /fci?summary=1`: repository/series metadata without all evidence payloads.
- `PUT /repositories/:id/fci`: enable/baseline configuration.
- `GET /repositories/:id/fci/history?offset=0&limit=100`: paginated active history.
- `GET /repositories/:id/fci/commits/:sha`: selected immutable observations and explanation.
- `POST /repositories/:id/fci/control`: `{action:all|next|pause|resume|explain, sha?:...}`.
- Existing `/fci/:id/retry`, `/reanalyze`, `/report-retry`: independent recovery.

## Upgrade

Router config version remains 7; Worker wire protocol is **8**, database schema **23**.
Drain active jobs and Worker result spools, stop both processes, then run
`npx tsx tools/migrate-fci-static.ts` for a preview and add `--apply` to migrate.
The tool backs up SQLite/config, preserves enabled flags and baseline references, removes obsolete
model/weight requirements, and archives old FCI prompt instructions in the config backup rather than
applying scoring instructions to explanations. Restart Router and Worker together.

Old AI results are retained as separate series; they are not comparable with static v2. See
[the archived v1 specification](./fci-v1.md). Disabling FCI stops reservations and requests cancellation
of an in-flight analysis through heartbeat; saved results remain available through legacy/detail APIs.

## Verification limits

Automated tests use real temporary Git repositories/remotes, SQLite, HTTP and fake providers/Jira.
They cover static determinism, wording-only changes, duplication/removal/test additions, cache reuse,
sequential backfill, pause/resume, automatic new commits and first-parent rejection. Existing PR-boundary
and reporting tests cover merge/squash/rebase and independent retries. Actual AI explanations, real
GitHub/Jira writes and Unity Editor tests must be reported separately from these local fixtures.

Local verification on 2026-10-26: 668 regression tests passed with the four existing Windows CLI
process-fixture files excluded. Type checking, lint and build passed. The live Router/Worker was
upgraded with SQLite/config backups; baseline `68677de` was selected by the user and six target
commits were evaluated through the real UI (100.0 → 104.3531746031746). Desktop/mobile layout,
one-step/all-history controls and selected evidence were checked in Chrome. Real AI explanation
calls, actual Jira/GitHub writes, Unity Editor tests and OS dark-mode rendering were not exercised;
AI evidence validation and report retries use fake-provider/Jira tests.
