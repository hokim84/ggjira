# ADR 0059: Trusted validation and verification method

## Context

Router judged an implementation result only by the agent's own report: one `pass` looked like any
other, whether the agent ran a test or read the code. Workers run several agents (Claude Code,
Codex, more later) whose tools differ; Claude Code's default tools cannot run commands at all. The
one check no agent reports on itself is the worker's `repositories[].validateCommand`, but it is
off by default and the implementation path ran it without the job's cancel signal or timeout.
The pstack analysis (docs/pstack-adoption-analysis.md) recommends carrying its verification rules
through Router prompts and the result contract rather than installing skills per host.

## Decision

- The implementation `validateCommand` runs with the job's abort signal and a separate
  `envelope.timeoutMs` cap, like the integration check. A cancel returns `cancelled` with the
  validation line; a timeout returns `failed` with `timedOut` (GGJ-105). `result.validation` keeps
  its `string[]` shape.
- review-gate adds the `immediate` reason `no_trusted_validation` for a succeeded implementation
  result with no `validation` output. It amends ADR 0040's reason list. `verifiedImplementation`,
  `verifiedNoChange`, child completion and parent PR assembly do not change.
- Each verification entry may carry `method`: `executed` or `inspected`. The provider JSON Schema
  requires it; Zod keeps it optional and drops an unknown value, so stored results and a slightly
  wrong answer still parse. No protocol bump: it is an additive field. The review tally counts
  `executed`/`inspected` (optional on older assessments). `method` is self-reported and never
  decides the review class.
- The default implementation prompt asks for the method and honest evidence, a failing-then-passing
  check for bug fixes when the repository offers a cheap one, no fixes beyond the evidence, and a
  consumer check for contract, serialization or stored-data changes. It names no language, tool or
  agent. Additional role instructions (ADR 0054) still append after it.
- Failure logs (not the three-line comment, ADR 0048) include the agent's checks and the validation
  output. `worker check` warns about a repository without `validateCommand`.
- Routing review to a different agent is not adopted: ADR 0055 retired general AI review.

## Consequences

A worker configured by `worker start` has `validateCommand: null`, so every implementation result
from it is `immediate` and opens a `review_required` attention item until an operator sets the
command. Validation can add up to one more `timeoutMs` after the agent run. Attempts issued before
the upgrade keep their frozen prompt; their entries have no `method` and are counted as unreported.
The method counts are agent claims; only the validation command is evidence GGJIRA produced itself.
