# agent-bun-runtime

Getty's Bun runtime for agent plugins, `getty-bun` for short
([ADR 0008](docs/adr/0008-repository-and-package-name.md)).

- **Bootstrap** (`bootstrap/`): two small starters, `getty-bun.sh` (POSIX `sh`, Linux)
  and `getty-bun.ps1` (Windows PowerShell 5.1 and PowerShell 7), that put one exact,
  checksum-verified Bun into `~/.getty/runtimes/bun/<version>/<target>/` and run a
  plugin's TypeScript with it. No Bun, Node or Python needed beforehand. To be delivered
  to plugins as the skilletor template `getty-bun-install` (not built yet).
- **`@getty/agent-bun-runtime`**: shared APIs and ready commands for Getty plugins
  running under that Bun: host hook codecs for Claude Code, Codex and Hermes, a
  dispatcher, context and process helpers.

Status: phase 1 (the starters in `bootstrap/`) is merged into `main` at `262bc95` (PR 1,
CI run 45603412444). The SDK and everything from phase 2 onward are not built yet.
Nothing is released: no tag, nothing on npm. Plan and phases:
[docs/plan.md](docs/plan.md).

## License

Artistic License 2.0, see [LICENSE](LICENSE).
