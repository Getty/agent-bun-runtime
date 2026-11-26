/** Receives the bytes of one write; its result is awaited. */
export type OutputWriter = (bytes: Uint8Array) => unknown;

/**
 * The real stdout. Bun.write resolves once all bytes are written, also on a slow pipe
 * (executed on Linux, Bun 1.4.5: 1 KB, 200 KB and 4 MB to a reader that starts 1.5 s
 * late; Windows not checked yet: the 256 KiB late-reader test in `test/entry.test.ts` is
 * to run on the Windows CI legs).
 */
export async function writeStdout(bytes: Uint8Array): Promise<void> {
  await Bun.write(Bun.stdout, bytes);
}

/**
 * The one place hook stdout is written. Empty output writes nothing: Bun 1.4.5 on Windows
 * rejects an empty Bun.write to a stdout pipe with EINVAL (ftruncate) (executed, CI
 * 45572032454 and 45579886904; card k11; the exit 9 in those runs is the phase 1
 * fixture's own `process.exit(9)` in its catch, not Bun's).
 */
export async function writeOutput(output: Uint8Array, write: OutputWriter = writeStdout): Promise<void> {
  if (output.byteLength === 0) return;
  await write(output);
}
