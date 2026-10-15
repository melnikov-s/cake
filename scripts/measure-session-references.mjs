/* global console, process */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

// Bounded, provider-free reference resolution/projection workload. No live Cake data is touched.
// The baseline overrides only the roster domain module, keeping the adapter/dependencies identical.
// Usage: pnpm measure:session-references [--baseline-ref REV] [--history 0|32|128] [--profile]
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const baseline = option("--baseline-ref");
const history = option("--history") ?? "32";
const directory = await mkdtemp(join(tmpdir(), "cake-reference-bundle-"));
try {
  const bundle = join(directory, "workload.mjs");
  const modulePath = "src/domain/project-sessions/sessionReferences.ts";
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/performance/session-references.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    sourcemap: "inline",
    plugins: baseline
      ? [
          {
            name: "baseline-references",
            setup(builder) {
              builder.onLoad(
                { filter: /\/domain\/project-sessions\/sessionReferences\.ts$/ },
                () => ({
                  contents: execFileSync("git", ["show", `${baseline}:${modulePath}`], {
                    cwd: root,
                    encoding: "utf8",
                  }),
                  loader: "ts",
                  resolveDir: resolve(root, "src/domain/project-sessions"),
                }),
              );
            },
          },
        ]
      : [],
  });
  // External packages resolve beside the checkout, not from the temporary bundle directory.
  const { symlink } = await import("node:fs/promises");
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  const profile = args.includes("--profile")
    ? [join(tmpdir(), `cake-references-${Date.now()}.cpuprofile`)]
    : [];
  console.log(`Implementation: ${baseline ?? "working tree"}; profiling: ${profile.length > 0}`);
  const result = spawnSync(process.execPath, [bundle, history, ...profile], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
