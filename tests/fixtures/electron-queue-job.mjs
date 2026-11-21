import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const [root, name, mode = "wait"] = process.argv.slice(2);
if (mode === "detached" || mode === "parallel" || mode === "alongside") {
  const shim = fileURLToPath(
    new URL("../../scripts/electron-queue-executable.mjs", import.meta.url),
  );
  const launch = (jobName, alongside = false) =>
    new Promise((resolve, reject) => {
      const child = spawn(shim, [fileURLToPath(import.meta.url), root, jobName], {
        detached: true,
        stdio: "inherit",
        env: {
          ...process.env,
          CAKE_QUEUED_ELECTRON_EXECUTABLE: process.execPath,
          CAKE_ELECTRON_QUEUE_ALONGSIDE: alongside ? "1" : "",
        },
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
  if (mode === "alongside") {
    const first = launch(name);
    while (!existsSync(join(root, `${name}.started`)))
      await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all([first, launch(`${name}-second`, true)]);
  } else
    await Promise.all([launch(name), ...(mode === "parallel" ? [launch(`${name}-second`)] : [])]);
} else if (mode === "boundary") {
  // A run step (nested harness) versus a shell command started by the Cake application.
  const { leaveLaunchingRun } = await import("../../src/main/electron-run-boundary.ts");
  const appEnv = { ...process.env };
  leaveLaunchingRun(appEnv);
  const queue = fileURLToPath(new URL("../../scripts/electron-run-queue.mjs", import.meta.url));
  const probe = (env) =>
    JSON.parse(
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { isElectronRun } from ${JSON.stringify(queue)};
          console.log(JSON.stringify({ nested: isElectronRun(),
            socket: Boolean(process.env.CAKE_ELECTRON_QUEUE_SOCKET) }));`,
        ],
        { env, encoding: "utf8" },
      ).stdout,
    );
  writeFileSync(
    join(root, `${name}.json`),
    JSON.stringify({ runStep: probe(process.env), startedByApp: probe(appEnv) }),
  );
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
