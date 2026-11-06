import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const [root, name, mode = "wait"] = process.argv.slice(2);
if (mode === "detached" || mode === "parallel") {
  const shim = fileURLToPath(
    new URL("../../scripts/electron-queue-executable.mjs", import.meta.url),
  );
  const launch = (jobName) =>
    new Promise((resolve, reject) => {
      const child = spawn(shim, [fileURLToPath(import.meta.url), root, jobName], {
        detached: true,
        stdio: "inherit",
        env: { ...process.env, CAKE_QUEUED_ELECTRON_EXECUTABLE: process.execPath },
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
  await Promise.all([launch(name), ...(mode === "parallel" ? [launch(`${name}-second`)] : [])]);
} else {
  writeFileSync(
    join(root, `${name}.started`),
    JSON.stringify({ pid: process.pid, cwd: process.cwd() }),
  );
  const release = join(root, `${name}.release`);
  const finish = () => {
    if (existsSync(release)) process.exit(Number(readFileSync(release, "utf8")));
  };
  watch(dirname(release), finish);
  finish();
}
