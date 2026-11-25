# getty-bun

Getty's Bun runtime for agent plugins.

- **Bootstrap** (`bootstrap/`): a small POSIX-shell starter and installer that puts one
  exact, checksum-verified Bun into `~/.getty/runtimes/bun/<version>/<target>/` and runs a
  plugin's TypeScript with it. No Bun, Node or Python needed beforehand. Delivered to
  plugins as the skilletor template `getty-bun-install`.
- **`@getty/bun-runtime`**: shared APIs and ready commands for Getty plugins running under
  that Bun: host hook codecs for Claude Code, Codex and Hermes, a dispatcher, context and
  process helpers.

Status: planning. See [docs/plan.md](docs/plan.md). Nothing is implemented or released yet.

## License

Artistic License 2.0, see [LICENSE](LICENSE).
