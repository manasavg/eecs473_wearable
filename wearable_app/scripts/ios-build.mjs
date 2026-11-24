/**
 * Builds the static iPhone bundle.
 *
 * Conda's base environment sets DYLD_LIBRARY_PATH. Next.js then loads its
 * compiler and sits there with no output. This starts Next with those
 * variables removed.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

console.log("Starting the iPhone build.");

const env = { ...process.env, CAPACITOR: "1", NEXT_TELEMETRY_DISABLED: "1" };
for (const key of [
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "LD_LIBRARY_PATH",
]) {
  delete env[key];
}

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "build"], {
  env,
  stdio: ["inherit", "pipe", "pipe"],
});

let printed = 0;
const quiet = setTimeout(() => {
  if (printed > 0) return;
  console.error(
    "Next.js still has not printed anything. Run `conda deactivate`, then `npm run cap:sync` again.",
  );
}, 20000);

function pass(stream, dest) {
  stream.on("data", (chunk) => {
    printed += chunk.length;
    dest.write(chunk);
  });
}
pass(child.stdout, process.stdout);
pass(child.stderr, process.stderr);

child.on("exit", (code, signal) => {
  clearTimeout(quiet);
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
