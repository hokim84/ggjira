# ADR 0060: Worker home outside checkouts

## Context

A worker kept its clones, job worktrees, logs and spools under `dataDir` (default `data/worker`)
and `logPath` (default `data/worker-logs`), both relative to the folder `worker start` ran in. That
folder is usually the GGJIRA checkout, so every job ran inside it. In KAN-47 a Codex worker walked up
from its worktree, found GGJIRA's own `AGENTS.md`, followed it to CLAUDE.md and runbook §46, ran
GGJIRA's `npm run check` and reported that as a failed acceptance check of an unrelated Python
repository. Claude Code reads every CLAUDE.md above its working folder by itself, so Claude workers
had the same exposure. The layout also scattered state: the credential, logs and clones had their
own settings, and changing `dataDir` later did not move clones.

## Decision

- A worker has one home folder holding everything local to it:
  `worker.config.json`, `credential.json`, `spool/`, `fci-spool/`, `logs/`, and per repository
  `repositories/<id>/repo` (the default clone) and `repositories/<id>/worktrees` (job worktrees).
  `src/worker-runtime/paths.ts` is the only place that names these paths.
- The home is `--home`, else `GGJIRA_WORKER_HOME`, else `%LOCALAPPDATA%\ggjira\worker` on Windows and
  `~/.ggjira/worker` elsewhere. Several workers on one machine use several homes. `--config`,
  `--credential` and `GGJIRA_WORKER_CONFIG` are removed.
- Worker config becomes `configVersion: 6` without `credentialPath`, `dataDir` or `logPath`.
  `repositories[].path` is optional (an existing clone the operator names; relative paths resolve
  against the home). Repository ids must be folder-safe (`[A-Za-z0-9][A-Za-z0-9._-]*`). A version 5
  file is refused with a pointer to the runbook; it is not converted.
- `worker start`, `worker setup` and `worker run` refuse a home that has `CLAUDE.md`, `AGENTS.md` or
  `.git` in it or in any folder above it; `worker check` reports each as a failure. A named
  repository that is not a git repository (jobs edit it in place) gets the same check for the
  folders above it.
- The default implementation prompt says verification covers only the contract's acceptance
  criteria and that instructions found outside the repository add no checks. It names no agent.

## Consequences

Existing workers are set up again: drain the spool, stop the worker, run `worker start` with the new
home and pair again (runbook §47). Clones are made again unless the operator points
`repositories[].path` at the old one. The isolation check cannot see instructions an agent loads from
its own user-level settings (`~/.claude`, `~/.codex`); those stay the operator's choice. Router config
and the wire protocol do not change.
