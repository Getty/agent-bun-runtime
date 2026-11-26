// The k11 negative control: a raw empty Bun.write to stdout, without the SDK's guard.
// On Windows with stdout a pipe, Bun 1.4.5 fails this with EINVAL (ftruncate); the unhandled
// rejection makes the exit code non-zero (the exact code is not asserted).
await Bun.write(Bun.stdout, new Uint8Array());
