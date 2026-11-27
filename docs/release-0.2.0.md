# Release checklist: 0.2.0

The second release of `@getty/agent-bun-runtime` and of the consumer skills in `skills/`:
what skilletor, loadguard and agent-irc need to move onto getty-bun (`docs/plan.md`,
"Release 0.2.0"; [ADR 0010](adr/0010-claude-code-on-windows-cmd-polyglot.md),
[ADR 0011](adr/0011-release-0.2.0-interface.md)). Built on branch `next-0.2.0` (hub card
`agent-developer k14`). Nothing here is done by an agent without the owner's explicit go:
the merge into `main`, the tag, the GitHub release and npm are behind the publish gate.

0.2.0 is the first release published by the workflow `.github/workflows/publish.yml`
(trusted publishing, card `k58`), not by hand.

## Before the merge

`bun` in these steps is Bun 1.4.5, the pin in `bootstrap/versions.json`; on a machine
without Bun, the harness Bun `.dev/harness/bun` (team skill `getty-bun-core`).

1. Every job of the pull request's CI run on the branch head is green, the macOS legs
   included (`scenarios`, `gate`, `hook-cost` on `macos-15` and `macos-15-intel`, `sdk` on
   `macos-15`), and the gate JUnit of every gate leg shows no skip
   (`assert-tests-ran.ts` in strict mode).
2. `getty-bun-reviewer` and `getty-bun-windows-reviewer` approved the branch head.
3. From a clean checkout of the branch head, with the pinned Bun:

   ```sh
   bun install --frozen-lockfile
   bun run typecheck
   bun test ./test/
   bun pm pack --dry-run          # dist/ (index, codex, claude-code and their .d.ts), README.md, LICENSE, package.json
   bun bootstrap/render-pin.ts --table bootstrap/versions.json --version 1.4.5 \
     --check bootstrap/getty-bun.sh bootstrap/getty-bun.ps1
   bun bootstrap/render-template.ts --check
   bun bootstrap/render-template.ts --check --nunjucks <dir>/node_modules/nunjucks   # nunjucks 3.2.4 outside the checkout
   ```

   `render-template.ts --check` covers both starter templates and the copy of
   `bootstrap/getty-bun.cmd` in `skills/getty-bun-install/bootstrap/`.
4. `bootstrap/versions.json` carries the two new rows `darwin-x64` and `darwin-aarch64`
   for 1.4.5, checked against Bun's signed `SHASUMS256.txt.asc` (ADR 0005; signer
   `F3DCC08A8572C0749B3E18888EAB4D40A7B22B59`, the check recorded in
   `bootstrap/README.md`).

## Release (owner)

The same steps as [release-0.1.0.md](release-0.1.0.md), "Release (owner)", with these
differences:

1. **Stamp commit**, on `main` through a reviewed PR, as for 0.1.0: `package.json`
   `"version": "0.2.0"`; `Changes`: `{{$NEXT}}` becomes the version line
   (`printf '%-9s %s' 0.2.0 "$(date -u '+%F %TZ')"`), a new `{{$NEXT}}` above it; the
   status paragraphs of `README.md` and `docs/plan.md` name where `next-0.2.0` landed and
   its two green CI runs (pull request and `main`), by the rule in release-0.1.0.md; the
   example `"ref": "v0.2.0"` in the skills stays as it is. A separate task, as for 0.1.0.
2. **Merge fast-forward and tag** exactly the stamp commit, `git tag -a v0.2.0 -m "0.2.0"`,
   after the push CI on `main` is green on it, as for 0.1.0, but create the tag **locally
   only**: pushing it starts `publish.yml`, which fails until npm knows the workflow
   (step 3.2). The tag is pushed in step 3.3.
3. **Publish through the workflow**, not by hand. In this order (release-0.1.0.md,
   "After the release"; npm CLI 11.5.1 or later and Node 22.14.0 or later, which the
   workflow checks):
   1. `publish.yml` is on `main` (it lands with the merge of `next-0.2.0`; the hub
      pushed its commit because the deploy key may not push workflows).
   2. Getty adds the trusted publisher on npm for `@getty/agent-bun-runtime`: repository
      `Getty/agent-bun-runtime`, workflow file name `publish.yml`, no environment, and
      direct `npm publish` switched on as an allowed action.
   3. Within 2 days of that configuration, push the tag `v0.2.0` (created in step 2). If
      the publish job fails, re-run it within the same 2 days. The workflow runs only
      for a pushed `v*` tag whose commit is on `origin/main` and whose name equals
      `v<package.json version>`; it builds and tests with Bun 1.4.5, packs, and publishes
      that tarball with provenance. A configuration without a successful publish within 2
      days expires.
   4. Then, under the package's publishing access, require two-factor authentication and
      disallow tokens.
4. **Check:** `npm view @getty/agent-bun-runtime@0.2.0 dist.tarball` and the provenance
   on the package page; install it into a scratch consumer, bundle and run one hook
   through a starter.
5. **GitHub release** for `v0.2.0` with the `Changes` entry, naming the tagged commit and
   the green push CI run on it.

## For consumers: from `v0.1.0` to `v0.2.0`

Nothing breaks for a consumer that only bumps: `contractVersion` stays 1, `gettyBun`
without `platforms` is valid as before, and the starter commands of 0.1.0 behave as
before. What changes on a bump, and what to adopt:

1. **Bump and re-render.** `.claude/skilletor.json`: `"ref": "v0.2.0"`;
   `@getty/agent-bun-runtime` `0.2.0` exactly in `devDependencies`; `bun install`, commit
   `bun.lock`; `skilletor sync --scope project`; copy the rendered starters into
   `bootstrap/` again: the pin block now has seven target lines (the two macOS targets),
   so both starters change even with `bun_version` still 1.4.5. Rebuild the bundled entry
   (`bun build --target=bun`). Codex asks users to review the hooks again when the
   plugin's scripts change.
2. **Drift check** (skill `getty-bun-install`, "Check the copy in CI"): add the `cmp` of
   `bootstrap/getty-bun.cmd` if the plugin ships it, and the `# platforms` check if it
   declares platforms.
3. **Starter behavior that changes without a line of consumer code:**
   - x64 hosts take an existing x64 slot without reading the CPU (starter cost on Linux
     about 4 ms over Bun instead of about 28 ms on agent-lab);
   - `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` reaches the entry and its children (k46): a
     non-bundled `.ts` entry no longer writes `.pile` files into the user's cache;
     bundled entries were never cached. Child processes must keep the variable
     (`dependencies-and-execution.md`);
   - an interrupted download resumes from `<GETTY_HOME>/runtimes/bun/.downloads/`, and a
     killed `getty-bun.sh` leaves no `curl`/`wget` running;
   - entry arguments beginning with `-` pass through `getty-bun.ps1` too (except a lone
     leading `--`, which Bun consumes).
4. **New, opt-in:**
   - `run-ready <entry>` for hot hooks with short timeouts (loadguard `PreToolUse` 5 s):
     exits 0 without installing while the slot is missing; keep one `SessionStart` hook
     with `run` or `ensure` and timeout 600 that installs.
   - `onFailure: "silent"` in `main()` for guards that must stay invisible on broken
     input (exit 0, nothing on stdout, one stderr line).
   - `gettyBun.platforms` plus `vars.bun_platforms` (for example `["linux"]` for
     loadguard): on other platforms the starters exit 0 without downloading Bun; replaces
     a `uname` guard in the hook line.
   - macOS: `darwin-x64` and `darwin-aarch64` (skilletor and agent-irc releases wait on
     this).
   - Claude Code on Windows: ship `bootstrap/getty-bun.cmd` and use the shell-form line
     `. "${CLAUDE_PLUGIN_ROOT}/bootstrap/getty-bun.cmd" run dist/hook.js claude-code; exit $LASTEXITCODE`
     in `hooks/hooks.json` (ADR 0010; skill `getty-bun-install`). Plugins that serve Claude
     Code only on Linux and macOS keep their `sh` lines.
   - A long-lived stdio server (MCP) under the starter: `contract.md`, "Long-lived stdio
     server"; under Codex `codex.md` (the locator lives in the consumer); add a
     `SessionStart` command hook `ensure` with timeout 600.
5. **Per consumer:**
   - **skilletor:** bump; Claude Code on Windows through the polyglot (F2); CLI flags on
     Windows pass through `getty-bun.ps1` (F4); macOS (F5); the background sync keeps
     `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` and starts with the isolation flags.
   - **loadguard:** bump; `onFailure: "silent"` (L1; Invariant 1 can return to exit 0);
     `run-ready` on `PreToolUse` and `UserPromptSubmit` with 5 s (L2); `platforms:
     ["linux"]` instead of the `uname` guard (L4); the watcher as a detached child
     (`dependencies-and-execution.md`). The latency gate (L3) is measured by the hub on
     reuben after the bump.
   - **agent-irc:** bump; the server through the starter as a long-lived stdio server
     (G2) with a `SessionStart` `ensure` hook (G3), `gettyBun` without an SDK dependency;
     under Codex the `sh -c` locator (G5; `codex.md` also names `env_vars` for
     `GETTY_HOME` as source-checked, not run); macOS (F5). Windows stays off (G4).

## Not in 0.2.0

The Hermes codec, MCP helpers in the SDK, a Windows MCP launcher and the job object
(`k13`), `k28`.
