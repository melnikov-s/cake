/* global process, console */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { nativeBuildMode } from "./native-build-mode.mjs";

const mode = nativeBuildMode({ CAKE_BUILD_MODE: process.argv[2] ?? "full" });
const root = resolve(import.meta.dirname, "..");
const run = (arguments_) =>
  new Promise((done, fail) => {
    const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", arguments_, {
      cwd: root,
      env: { ...process.env, CAKE_BUILD_MODE: mode },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", fail);
    child.once("close", (code, signal) =>
      code === 0 ? done() : fail(new Error(`Cake ${mode} build failed (${signal ?? code})`)),
    );
  });
try {
  await run(["exec", "electron-vite", "build"]);
  await run(["build:browser"]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
