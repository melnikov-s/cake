import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const packageRoot = join(dirname(require.resolve("node-pty")), "..");
  chmodSync(join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), 0o755);
}
