# 0005: Bun pin and version table

Status: accepted, 2026-11-25; the pin is confirmed after phase 1.

## Context

The starter must verify the archive with a checksum it already holds. Bun releases
`bun-<target>.zip` per target plus `SHASUMS256.txt` and the GPG signature
`SHASUMS256.txt.asc` (observed for bun-v1.4.5, released 2026-11-19).

## Decision

- `bootstrap/versions.json` lists each approved version with the SHA256 of every
  supported target's archive and the name of the single expected member.
- Adding a version: download `SHASUMS256.txt` and its signature, verify the signature
  against Bun's release key (fingerprint recorded in the table's README), copy the
  checksums of the supported targets, and run the phase 1 scenarios. The commit names
  the verification.
- MVP targets: `linux-x64`, `linux-x64-baseline` (no AVX2), `linux-aarch64`,
  `windows-x64`, `windows-x64-baseline`. Detection that fails chooses the baseline
  build. musl, `windows-aarch64` and macOS come later as explicit table entries.
- Pin candidate: 1.4.5.

## Consequences

- The starter never downloads `SHASUMS256.txt` at install time.
- An unsupported target fails with a message that names the detected target.
