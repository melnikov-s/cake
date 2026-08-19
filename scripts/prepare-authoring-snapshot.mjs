import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "out", "authoring");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const path of [
  "AGENTS.md",
  "tsconfig.json",
  "package.json",
  ".agents/skills/cake-plugin-authoring",
  "docs/architecture",
  "src/renderer",
  "src/ipc",
  "src/plugin",
]) {
  await cp(join(root, path), join(target, path), { recursive: true });
}
await writeFile(
  join(target, "cake-authoring.json"),
  `${JSON.stringify({ schemaVersion: 1, cakeVersion: packageJson.version }, null, 2)}\n`,
);
