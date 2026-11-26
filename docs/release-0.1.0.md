# Release checklist: 0.1.0

The first release of `@getty/agent-bun-runtime` and of the consumer skills in `skills/`.
The owner publishes by hand ([ADR 0006](adr/0006-npm-distribution.md)); afterwards
trusted publishing from GitHub Actions takes over. Nothing here is done by an agent
without the owner's explicit go: the tag, the GitHub release and npm are behind the
publish gate.

## Before the tag

1. The phase 2b branch (PR 3) and the branch `pre-0.1.0` are merged into `main` after all
   CI jobs were green and both reviewers approved; `main` CI (push) is green on the merge
   commit.
2. `package.json` says `"version": "0.1.0"`; `Changes` has the 0.1.0 entry under
   `{{$NEXT}}`.
3. From a clean checkout of `main`, with the pinned Bun (1.4.5):

   ```sh
   bun install --frozen-lockfile
   bun run typecheck
   bun test ./test/
   bun pm pack --dry-run          # dist/ (index, codex, claude-code and their .d.ts), README.md, LICENSE, package.json
   bun pm pack                    # getty-agent-bun-runtime-0.1.0.tgz, inspect: tar tzf
   ```

   The tarball holds `dist/`, no `src/`, no `test/`, no `bunfig.toml`. It is a check
   only: it is built before the stamp commit and is never published; delete it.
4. The template matches the starters: `bun bootstrap/render-template.ts --check`, and with
   nunjucks 3.2.4 installed outside the checkout `bun bootstrap/render-template.ts
   --nunjucks <dir>/node_modules/nunjucks` (byte identity through a real render), and
   `bootstrap/render-pin.ts --table bootstrap/versions.json --version 1.4.5 --check
   bootstrap/getty-bun.sh bootstrap/getty-bun.ps1`.
5. This repository's own `.claude/skilletor.json` already takes `getty-bun-integration`
   from `skills/` at `"ref": "v0.1.0"`; until the tag exists, `skilletor sync` here
   cannot fetch that source (a `skilletor.local.json` with `"local"` pointing at the
   checkout works meanwhile).
6. The registry name is still free: `npm view @getty/agent-bun-runtime` answers 404
   (free on 2026-11-26).

## Release (owner)

1. The stamp commit, on `main` through a reviewed PR:
   - `Changes`: replace `{{$NEXT}}` with `0.1.0  <date>` and add a new empty `{{$NEXT}}`
     above it.
   - `Changes`, in the 0.1.0 entry: "SDK package @getty/agent-bun-runtime, not published
     yet." becomes "SDK package @getty/agent-bun-runtime on npm."; "SDK
     @getty/agent-bun-runtime (not published yet): main() reads" becomes "SDK
     @getty/agent-bun-runtime: main() reads".
   - `README.md`, the status paragraph above "The SDK" (it ships in the tarball): the
     sentences from "Phase 2b (the Claude Code codec, …" to the end of the paragraph become
     "Phase 2b (the Claude Code codec, the consumer skills, release preparation for 0.1.0,
     [ADR 0009](docs/adr/0009-first-release-claude-code-and-consumer-skills.md)) is merged
     into `main` at `4f9c556` (PR 3), the last fixes before the release at `<pre-0.1.0
     merge>` (PR `<n>`). Released: 0.1.0, tag `v0.1.0`, on npm as
     `@getty/agent-bun-runtime`; the release steps are in
     [docs/release-0.1.0.md](docs/release-0.1.0.md). Plan and phases:
     [docs/plan.md](docs/plan.md)."
   - `docs/plan.md`, the status paragraph: "is being built on branch
     `phase-2b-claude-code`; phase 3 onward is not implemented yet." becomes "is complete:
     merged into `main` at `4f9c556` (PR 3) and `<pre-0.1.0 merge>` (PR `<n>`), gate
     green in CI run `<run id>`, and released as 0.1.0 (tag `v0.1.0`, npm). Phase 3
     onward is not implemented yet."
   - `docs/plan.md`, the "Names" bullet under "Decided": "(not published yet; release
     checklist: [release-0.1.0.md](release-0.1.0.md))" becomes "(on npm since 0.1.0;
     release checklist: [release-0.1.0.md](release-0.1.0.md))".
   - The placeholders: `4f9c556` is where PR 3 landed on `main`; `<pre-0.1.0 merge>` and
     `<n>` are where the branch `pre-0.1.0` landed and its PR; `<run id>` is the green CI
     run on that commit. Nothing else changes in the stamp commit (ADRs are records and
     keep their wording).
2. Tag the commit: `git tag -a v0.1.0 -m "0.1.0"`, push the tag. The tag pins the SDK
   source **and** the skills: consumers install the skills with skilletor at
   `"ref": "v0.1.0"`, `"path": "skills"`.
3. Publish by hand, logged in as an owner of the npm org `getty`. In a clean checkout of
   the tag (`git checkout v0.1.0`), with the pinned Bun (1.4.5), run `bun install
   --frozen-lockfile` and `bun pm pack` again, check it with `tar tzf`, and publish exactly
   that tarball: `npm publish --access public getty-agent-bun-runtime-0.1.0.tgz`. Never
   the tarball from "Before the tag", step 3: it predates the stamp commit. The package is
   public, Artistic-2.0.
4. Check: `npm view @getty/agent-bun-runtime@0.1.0 dist.tarball`, install it into a
   scratch consumer, bundle and run one hook through a starter.
5. Optional: a GitHub release for `v0.1.0` with the `Changes` entry.

## After the release

- Set up trusted publishing for `Getty/agent-bun-runtime` on npm (provenance, no
  long-lived token) before 0.1.1; a CI workflow change by the CI worker.
- The hub removes `agent-plugins/getty-bun-integration` from Getty/skills and points
  consumers at `Getty/agent-bun-runtime` (`skills/`, `"ref": "v0.1.0"`).
- Consumers move in their own repositories, skilletor first.
- Consumers take 0.1.0 from npm; a git-commit pin gets no `dist/` (card `k28`, open).
