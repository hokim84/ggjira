# ADR 0065: Worker home in the checkout, isolated by the provider CLIs

## Context

ADR 0060 moved the worker home out of the GGJIRA checkout to `%LOCALAPPDATA%\ggjira\worker` or
`~/.ggjira/worker`, and refused a home with `CLAUDE.md`, `AGENTS.md` or `.git` in a folder above
it. That fixed KAN-47 (an agent read GGJIRA's `AGENTS.md` above its worktree and reported GGJIRA's
`npm run check` as a failed acceptance check of another repository), but an operator running from
the checkout found the worker's files in a hidden folder on the system drive, away from the
project they work on. The danger was never the folder itself, only the instruction files the
agent CLIs load from the folders above where they run:

- Claude Code loads `CLAUDE.md`, `CLAUDE.local.md` and, when it finds no `CLAUDE.md`, `AGENTS.md`
  from the working folder and every folder above it. Its `claudeMdExcludes` setting skips files
  by absolute path and is honoured from a `--settings` argument (checked on Windows with Claude Code
  2.1.311: an excluded parent `CLAUDE.md` no longer reaches the prompt).
- Codex reads `AGENTS.md` from the project root (the nearest folder above with a `.git`, which a
  git worktree has) down to the working folder. `-c project_root_markers=[]` makes the working
  folder the only one it reads (checked with codex-cli 0.163.0 on a folder without `.git` under
  a repository).

## Decision

- The default worker home is `<checkout>/data/worker` when GGJIRA runs from its own checkout (the
  package root has `.git`: `run-worker.bat`, `npm run dev`). An installed package keeps ADR 0060's
  user folder. `--home` and `GGJIRA_WORKER_HOME` still override it.
- Every provider run ignores instruction files above the repository it works in (its `cwd`, a
  job worktree or the repository folder):
  - Claude Code gets `--settings {"claudeMdExcludes": [...]}` listing, for each folder above,
    `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md` and
    `.claude/rules/**` (`src/worker/instruction-files.ts`). In the user's home folder only the first
    three are listed, so `~/.claude/CLAUDE.md` and user rules stay the operator's choice.
  - Codex gets `-c project_root_markers=[]`.
- The refusal of a home with instruction files or `.git` above it is removed from `worker start`,
  `setup`, `run` and `check`.
- `isGitRepository` is true only for the top folder of a work tree. A plain folder inside another
  repository (now possible under a home in the checkout) is not treated as that repository, so its
  jobs never branch from GGJIRA. `worker check` fails such a folder when it is configured as a
  repository, because an agent's git commands there would change the outer repository.
- This replaces ADR 0060's default location and its home refusal; the home layout, config
  version 6 and the implementation prompt's verification scope stay.

## Consequences

Running from the checkout keeps the worker's config, clones, worktrees and logs under
`data/worker`, which `.gitignore` already excludes. A worker set up under ADR 0060 keeps working
when started with `--home` or `GGJIRA_WORKER_HOME` pointing at the old folder, or is moved to
`data/worker` (runbook §47). The exclusion depends on the provider CLIs' settings: a Claude Code
or Codex version that changes how it finds instruction files can bring KAN-47 back, so the manual
check in runbook §18 is repeated after upgrading them. An agent can still open a parent file on
purpose with its tools; the implementation prompt's rule that instructions outside the repository
add no checks covers that case.
