import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("node-pty/package.json"));
  await Promise.all(
    ["arm64", "x64"].map((architecture) =>
      chmod(join(packageRoot, "prebuilds", `darwin-${architecture}`, "spawn-helper"), 0o755),
    ),
  );
}
