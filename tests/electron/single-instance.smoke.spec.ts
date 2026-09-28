import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import electronBinary from "electron";

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** Launches a bare second Cake process against the same profile and reports its exit code. */
function launchSecondInstance(env: NodeJS.ProcessEnv) {
  return new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(electronBinary, [repositoryRoot], {
      cwd: repositoryRoot,
      env,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The second Cake instance did not exit"));
    }, 20_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

test("a second launch on the same profile exits and hands its window request to the primary", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-single-instance-"));
  const env = {
    ...process.env,
    CAKE_ELECTRON_SMOKE: "1",
    CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
    CAKE_HOME: join(temporaryRoot, "cake-home"),
  };
  const application = await electron.launch({ args: [repositoryRoot], cwd: repositoryRoot, env });

  try {
    const page = await application.firstWindow();
    await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });

    // The primary owns the profile: a second launch exits cleanly without opening anything.
    expect(await launchSecondInstance(env)).toBe(0);
    expect(application.windows()).toHaveLength(1);

    if (process.platform !== "darwin") return;
    // macOS keeps the process alive without windows; a second launch is how the user gets
    // the window back instead of a second process sharing (and corrupting) the profile.
    await page.close();
    await expect.poll(() => application.windows().length).toBe(0);
    const reopened = application.waitForEvent("window");
    expect(await launchSecondInstance(env)).toBe(0);
    await expect((await reopened).locator("body")).toBeVisible({ timeout: 20_000 });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
