// Which starter targets a host (process.platform, process.arch) may detect. A module with no
// test hooks and no imports, so targets.test.ts can check every mapping on any machine.

/**
 * The targets a starter may choose on a host, or null for a host no starter supports.
 * Linux x64 and Windows x64 have a baseline build beside the AVX2 one; macOS has none
 * (docs/plan.md, Release 0.2.0 item 5: no `darwin-x64-baseline`).
 */
export function targetsFor(platform: string, arch: string): string[] | null {
  if (platform === "linux") {
    if (arch === "x64") return ["linux-x64", "linux-x64-baseline"];
    if (arch === "arm64") return ["linux-aarch64"];
  }
  if (platform === "darwin") {
    if (arch === "x64") return ["darwin-x64"];
    if (arch === "arm64") return ["darwin-aarch64"];
  }
  if (platform === "win32" && arch === "x64") return ["windows-x64", "windows-x64-baseline"];
  return null;
}
