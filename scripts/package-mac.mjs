/* global console, process */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Cake distribution builds require an Apple Silicon Mac.");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version === "0.0.0")
  throw new Error("Set a stable release version in package.json before packaging.");
for (const file of [
  "out/main/main.js",
  "out/preload/preload.cjs",
  "out/renderer/index.html",
  "out/browser/index.html",
  "out/main/native/cake-dictation",
  "out/main/native/cake-speech",
])
  await access(resolve(root, file));
const result = spawnSync(
  "pnpm",
  ["exec", "electron-builder", "--mac", "--arm64", "--publish", "never"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const name = `Cake-${version}-mac-arm64.dmg`;
const bytes = await readFile(resolve(root, "dist", name));
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(resolve(root, "dist", "SHA256SUMS"), `${sha256}  ${name}\n`);
await writeFile(
  resolve(root, "dist", "latest-mac-arm64.json"),
  `${JSON.stringify(
    {
      version,
      downloadUrl: `https://github.com/melnikov-s/cake/releases/download/v${version}/${name}`,
      sha256,
    },
    null,
    2,
  )}\n`,
);
console.log(`Built ${name}; release metadata targets v${version} (not published).`);
