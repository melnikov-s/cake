import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 1 || !["--plan", "--apply"].includes(args[0])) {
  throw new Error(
    "Usage: node scripts/migrate-pi-sessions.mjs --plan | --apply. --apply requires Cake and terminal Pi to be closed.",
  );
}
// Build beside the project so native dependencies resolve from its node_modules.
const temporary = await mkdtemp(join(root, ".cake-pi-migration-"));
try {
  const output = join(temporary, "migration.mjs");
  await build({
    entryPoints: [join(root, "src/services/pi/PiSessionMigrationCommand.ts")],
    outfile: output,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
  });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [output, ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
