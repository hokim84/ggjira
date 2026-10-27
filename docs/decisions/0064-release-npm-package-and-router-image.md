# ADR 0064: Release as an npm package and a Router image

## Context

GGJIRA had no release. A Router operator cloned the repository and built the image on the server
(`docker compose up -d --build`); every worker machine cloned the whole repository and ran the CLI
from source (`npm run dev -- worker start`). The package was `private`, the version never changed
from 0.1.0, and README asked to upgrade Router and Worker together without a version to agree on.
Someone trying GGJIRA needed a full development setup on each machine before seeing it work.

## Decision

- A tag `vX.Y.Z` that matches `package.json` publishes one version (`.github/workflows/release.yml`)
  after `npm run check` passes:
  - npm package `ggjira` (dist, web UI): `npm install -g ggjira` gives the `ggjira` command for
    Worker and Router. Published with provenance; needs the `NPM_TOKEN` repository secret.
  - Router image `ghcr.io/hokim84/ggjira-router:X.Y.Z` and `:latest` for linux/amd64 and
    linux/arm64.
  - A GitHub release with generated notes.
- `docker-compose.yml` and `docker-compose.cloudflare.yml` use the released image
  (`GGJIRA_VERSION` pins one, default `latest`). They keep the `build` section, so Compose builds
  the checkout when the image cannot be pulled or with `--build`.
- The CLI's `--version` must equal `package.json`'s version (a test checks it); Router and workers
  run the same released version.
- CI also builds the Router image, so a broken Dockerfile shows before a tag.
- Running from a checkout (`npm run dev`, `run-*.bat`) stays the way to develop GGJIRA.

## Consequences

A user installs a worker with one npm command and starts a Router without building it. Releasing
needs a version bump in `package.json` and `src/version.ts`, then a pushed tag (CONTRIBUTING.md).
The npm name `ggjira` and the GHCR package must be owned by the maintainer; after the first image
push the GHCR package's visibility must be public so `docker compose pull` works without login.
README's install steps describe released versions, so they only work after the first release.
