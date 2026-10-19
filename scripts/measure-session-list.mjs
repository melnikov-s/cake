/* global console, process */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

// Isolated, provider-free production sessions.list. Never reads live Cake/Pi data.
// node scripts/measure-session-list.mjs [--baseline-ref REV] [--history-kib 64]
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const baseline = args.includes("--baseline-ref") ? option("--baseline-ref") : undefined;
const directory = await mkdtemp(join(tmpdir(), "cake-list-bundle-"));
try {
  const bundle = join(directory, "workload.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/performance/session-list.mjs"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: { ".md": "text" },
    plugins: baseline
      ? [
          {
            name: "baseline-list",
            setup(builder) {
              builder.onLoad({ filter: /\/src\/.*\.ts$/ }, ({ path }) => {
                const relative = path.slice(root.length);
                if (
                  ![
                    "src/domain/application/agentControl.ts",
                    "src/domain/project-sessions/sessionReferences.ts",
                    "src/domain/project-sessions/projectSessionMetadata.ts",
                    "src/services/pi/runtime/session-title.ts",
                    "src/services/pi/runtime/session-discovery.ts",
                    "src/services/storage/session-files.ts",
                  ].includes(relative)
                )
                  return;
                return {
                  contents: execFileSync("git", ["show", `${baseline}:${relative}`], {
                    cwd: root,
                    encoding: "utf8",
                  }),
                  loader: "ts",
                  resolveDir: resolve(path, ".."),
                };
              });
            },
          },
        ]
      : [],
  });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  console.log(`Implementation: ${baseline ?? "working tree"}`);
  const result = spawnSync(
    process.execPath,
    [bundle, args.includes("--history-kib") ? option("--history-kib") : "64"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
