import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

// Playwright spawns Electron detached (its own process group) and only kills it from the
// runner's exit handlers. A SIGKILLed runner, such as an agent command timeout, never runs them.
const launcher = `
import { _electron as electron } from "@playwright/test";
const application = await electron.launch({ args: [process.cwd()], cwd: process.cwd(), env: process.env });
await application.firstWindow();
console.log("cake-pid=" + application.process().pid);
setInterval(() => {}, 1 << 30);
`;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a smoke Cake process exits when its Playwright runner is SIGKILLed", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-orphaned-runner-"));
  const runner = spawn(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
      CAKE_HOME: join(temporaryRoot, "cake-home"),
      PI_CODING_AGENT_DIR: join(temporaryRoot, "cake-home", "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let electronPid: number | undefined;
  try {
    for await (const line of createInterface({ input: runner.stdout! })) {
      if (!line.startsWith("cake-pid=")) continue;
      electronPid = Number(line.slice("cake-pid=".length));
      break;
    }
    if (electronPid === undefined) throw new Error("The Playwright runner exited before launch");
    expect(alive(electronPid)).toBe(true);
    runner.kill("SIGKILL");
    await expect.poll(() => alive(electronPid!), { timeout: 20_000 }).toBe(false);
  } finally {
    if (runner.exitCode === null) runner.kill("SIGKILL");
    // Never let this guard itself leak: Playwright made Electron a process-group leader.
    if (electronPid !== undefined && alive(electronPid)) process.kill(-electronPid, "SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
