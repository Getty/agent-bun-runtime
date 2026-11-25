# 0006: npm distribution of @getty/bun-runtime

Status: accepted, 2026-11-25 (owner: npm org `getty`, Artistic-2.0); package name
superseded by [0008](0008-repository-and-package-name.md).

## Decision

- Package `@getty/bun-runtime`, public (`publishConfig.access: public`; scoped
  packages default to private), license Artistic-2.0, ESM plus declarations.
- The first release is published by hand after review and the owner's explicit go.
  Afterwards trusted publishing from GitHub Actions (`Getty/getty-bun`) with provenance;
  no long-lived token.
- Until the first release, consumers pin a git commit of `Getty/getty-bun`. Because
  consumers bundle (ADR 0003), the npm package is a build-time dependency only.

## Consequences

- This machine has no npm login (`npm whoami`: ENEEDAUTH, no `~/.npmrc`); the owner
  logs in for the first publish.
