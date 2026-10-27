# ADR 0063: Router store on built-in node:sqlite

## Context

The Router kept its SQLite store through `better-sqlite3`, a native addon. On a fresh Windows
machine (Node 25.8, npm 11.11, 2026-10-27) `npm install` and `npm ci` ran `node-gyp rebuild` for it
and failed without Visual Studio's C++ workload and a Windows SDK, even though the package ships a
prebuilt `win32-x64` binary. `run-router.bat` and `run-worker.bat` run `npm install` on first start,
and every worker installs the whole package although only the Router opens the store, so a new user
could not start either part on Windows. The Docker image needed `python3 make g++` for the same
reason. Node 24, the minimum GGJIRA supports, has `node:sqlite` built in with what the Router uses:
synchronous statements, `backup()`, `isTransaction` and a busy `timeout`.

## Decision

- The Router opens its store with `node:sqlite` (`DatabaseSync`). `better-sqlite3` and
  `@types/better-sqlite3` are removed; GGJIRA has no native dependency.
- `RouterDatabase` (`src/router/db/connection.ts`) extends `DatabaseSync` with what the code used
  from better-sqlite3: `transaction(fn)` (BEGIN/COMMIT/ROLLBACK, a savepoint when nested),
  `pragmaValue` / `pragmaRows`, and `backupTo(path)`. Every Router module and test takes
  `RouterDatabase`.
- Connections keep WAL and foreign keys and wait up to 5 seconds on a busy database, as
  better-sqlite3 did by default. They also set `synchronous = NORMAL`, which better-sqlite3 was
  built with under WAL: without it every commit waits for an fsync, and 2000 small commits took
  over 12 seconds in a Linux container on Windows. A Router crash loses nothing; a power loss can
  lose the last commits, as before. A UNIQUE violation is recognised by SQLite's extended result code
  2067 instead of better-sqlite3's `SQLITE_CONSTRAINT_UNIQUE` string.
- `@types/node` follows the runtime (24), and vitest moves to 3, whose module resolution knows
  `node:sqlite`.

## Consequences

`npm install` needs no compiler on any platform, and the Docker build drops its toolchain stage.
The database file format is unchanged, so an existing `router.sqlite3` opens as before; there is
nothing to migrate. Early Node 24 releases print one `ExperimentalWarning` for `node:sqlite` at
start; later 24.x releases (24.22 checked) do not. Named parameters behave differently: node:sqlite
rejects an unknown key, which better-sqlite3 ignored, and binds NULL for a missing key, where
better-sqlite3 threw. New statements pass exactly the keys they name.
