# Release checklist: 0.1.0

The first release of `@getty/agent-bun-runtime` and of the consumer skills in `skills/`.
The owner publishes by hand ([ADR 0006](adr/0006-npm-distribution.md)); afterwards
trusted publishing from GitHub Actions takes over. Nothing here is done by an agent
without the owner's explicit go: the tag, the GitHub release and npm are behind the
publish gate.

## Before the tag

`bun` in these steps is Bun 1.4.5, the pin in `bootstrap/versions.json`; on a machine
without Bun, the harness Bun `.dev/harness/bun` described in the team skill
`getty-bun-core` (`.claude/skills/getty-bun-core/SKILL.md`, "Tooling on this machine").

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
   --check --nunjucks <dir>/node_modules/nunjucks` (byte identity through a real render;
   without `--check` it writes the template), and
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
   - `Changes`: replace `{{$NEXT}}` with the version line in the house format of
     `getty-git-commit-style`, the version padded to nine columns, a space and the UTC
     time of the stamp commit, `printf '%-9s %s' 0.1.0 "$(date -u '+%F %TZ')"` (for
     example `0.1.0     2026-11-27 09:15:00Z`); add a new `{{$NEXT}}` and a blank line
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
     green in CI runs `<pr run>` (pull request) and `<push run>` (`main`), and released
     as 0.1.0 (tag `v0.1.0`, npm). Phase 3 onward is not implemented yet."
   - `docs/plan.md`, the "Names" bullet under "Decided": "(not published yet; release
     checklist: [release-0.1.0.md](release-0.1.0.md))" becomes "(on npm since 0.1.0;
     release checklist: [release-0.1.0.md](release-0.1.0.md))".
   - The placeholders: `4f9c556` is where PR 3 landed on `main`; `<pre-0.1.0 merge>` and
     `<n>` are where the branch `pre-0.1.0` landed and its PR; `<pr run>` and
     `<push run>` are the two green CI runs on that commit, of the pull request and of the
     push to `main`. One rule for the status lines this stamp writes and for later ones:
     a line that cites a gate names both runs, the pull request's and `main`'s, as
     `skills/getty-bun-integration/references/verification.md` does for phase 1; older
     lines stay as they are. Nothing else changes in the stamp commit (ADRs are records
     and keep their wording).
2. Merge the stamp PR into `main` fast-forward, so that `main` is the stamp commit itself
   (`git merge --ff-only` on `main` and push; GitHub's merge buttons do not fast-forward,
   and "Rebase and merge" gives the commit a new hash and committer date). Wait for the
   push CI on `main` on that commit; every job must be green. Tag exactly that commit,
   `git tag -a v0.1.0 -m "0.1.0" <stamp commit>`, push the tag, and from then on name
   that run wherever the release is cited, in the GitHub release and in consumer reviews
   (`verification.md`: "cite the run of the tagged commit"; the stamp commit cannot hold
   its own run). The tag pins the SDK source **and** the skills: consumers install the
   skills with skilletor at `"ref": "v0.1.0"`, `"path": "skills"`.
3. Publish by hand, logged in as an owner of the npm org `getty`. In a fresh clone or
   worktree of the tag (`git clone --branch v0.1.0 <repository> <dir>` or `git worktree
   add <dir> v0.1.0`; not `git checkout v0.1.0` in a working copy), with the pinned Bun
   (1.4.5), run `bun install --frozen-lockfile` and `bun pm pack` again, check it with
   `tar tzf`, and publish exactly that tarball: `npm publish --access public
   getty-agent-bun-runtime-0.1.0.tgz`. Never the tarball from "Before the tag", step 3: it
   predates the stamp commit. The package is public, Artistic-2.0.
4. Check: `npm view @getty/agent-bun-runtime@0.1.0 dist.tarball`, install it into a
   scratch consumer, bundle and run one hook through a starter.
5. The GitHub release for `v0.1.0` with the `Changes` entry; it names the tagged commit
   and the green push CI run on it (step 2).

## After the release

- Trusted publishing for `Getty/agent-bun-runtime` on npm (provenance, no long-lived
  token), in this order; 0.1.1 is its first publish:
  1. The publish workflow is on `main`: `.github/workflows/publish.yml`. It runs on a
     pushed `vX.Y.Z` tag, checks the tag against `package.json` and `Changes`, packs with
     `bun pm pack` and publishes that tarball. npm registers its file name, and the file
     must already exist in `.github/workflows/`.
  2. Then the trusted publisher on npm for the package: organization `Getty`, repository
     `agent-bun-runtime`, workflow `publish.yml`, no environment. `npm stage publish` is always allowed;
     a direct `npm publish` from the workflow is an "allowed action" that has to be
     switched on in that configuration.
  3. Then publish 0.1.1 through the workflow within 2 days: a new configuration that has
     no successful publish within 2 days expires and can no longer be used or edited.
  4. Then, under the package's publishing access, require two-factor authentication and
     disallow tokens.

  The workflow needs npm CLI 11.5.1 or later and Node 22.14.0 or later. Source:
  [docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers), read
  2026-11-26T23:29Z.
- The hub removes `agent-plugins/getty-bun-integration` from Getty/skills and points
  consumers at `Getty/agent-bun-runtime` (`skills/`, `"ref": "v0.1.0"`).
- Consumers move in their own repositories, skilletor first.
- Consumers take 0.1.0 from npm; a git-commit pin gets no `dist/` (card `k28`, open).
