import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

/** Build shared runtime assets once, before parallel suites can serve them. */
export default async function setup() {
  const run = promisify(execFile);
  const options = {
    cwd: resolve(import.meta.dirname, "../.."),
    // Vitest's NODE_ENV=test must not change the production assets under test.
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 4 * 1024 * 1024,
  };
  await run(process.execPath, ["scripts/build.mjs", "slim"], options);
  await run(process.execPath, ["scripts/build-server.mjs"], options);
}
