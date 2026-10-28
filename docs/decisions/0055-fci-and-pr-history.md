# ADR 0055: Independent experimental FCI analysis and PR tracking

## Context

GGJIRA needs a longitudinal, commit-based description of future maintenance difficulty without
conflating implementation effort, approval, defect review or successful integration with a structural score.

## Decision

Retire the AI-review workflow status and general quality-review dispatch. Keep human approvals,
trusted integration checks and manual Done. AI roles are planning, implementation and FCI analysis.
FCI is opt-in per repository and uses existing Workers/CLI providers with an explicitly identified model.
Use a separate background queue and reporting outbox, reusing authentication, sessions, leases and spool
patterns without moving analysis into Router or allowing Workers to access Jira.

Use deterministic tracked-file AST/Git/Unity observations and evidence-backed AI grades. Five weights
start at 25/20/25/20/10 percent. All axes are needed for a total. Store raw score separately from
`100 + currentRaw - baselineRaw`; missing evidence stays unavailable. Grade anchors, exclusions and
limitations are in [the FCI specification](../fci.md).

Version every evaluation profile and explicitly register its tracking baseline. Cache whole snapshots,
coalesce concurrent claims, and retain attempt/reanalysis history. Compare actual merged states after
proving the Git boundary; previews are never confirmed points. Do not sum PR risk scores.

Router configVersion is 7; Worker protocol is 6; DB migration 21 adds FCI tables without deleting
historical review data. ADR 0053's optional AI review and ADR 0054's review prompt are superseded;
the planning/implementation prompt settings and the rest of the approval workflow remain valid.

## Consequences

Analysis and Jira reporting can fail/retry independently of code execution. Scores cannot gate work.
AST support is language-specific; C#/Unity static evidence does not imply Editor validation. AI scores
remain experimental and non-deterministic; fixed IDs and cached evidence aid traceability but do not
validate development-cost predictions or guarantee unchanged weights behind model aliases.
