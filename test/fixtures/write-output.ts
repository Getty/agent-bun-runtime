// Writes argv[2] through writeOutput's default writer (the real stdout) and exits.
import { writeOutput } from "../../src/output.js";

await writeOutput(new TextEncoder().encode(process.argv[2] ?? ""));
