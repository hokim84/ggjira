# ADR 0057: Static FCI and target commit history

FCI v2 replaces mandatory AI grading with four equally weighted deterministic structural components:
dependency, complexity, duplication and ripple. Tests/history remain evidence outside the score.
No model/language/weight settings are needed. A starting commit anchors each versioned series at 100.
Old AI series remain archived. Formula, thresholds, coverage rules and limitations are in docs/fci.md.

Target first-parent history includes direct commits and actual merged states. Users backfill past
commits one-at-a-time or sequentially, pause/resume, and retry analysis without reimplementation.
New target commits are automatically evaluated. FCI uses the existing independent queue, leases,
snapshot claims, spool and reporting outbox. Protocol 8 and migration 23 add history/range state.

One chart shows overall FCI with optional component lines; details are loaded only for a selected
commit. Missing observations are gaps. Optional AI explanations consume frozen facts, cite validated
file/line evidence and never modify scores. Model/prompt changes do not invalidate static history.

ADR 0056's child approvals, aggregate PR, human merge and trusted post-merge integration checks remain.
No FCI result blocks approval, merging, Jira transitions or manual Done. Historical backfill does not
post old Jira comments. Actual PR delta remains a comparison of proven before/after target states.
