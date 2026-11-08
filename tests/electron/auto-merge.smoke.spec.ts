import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("activity-bar Auto-merge authorizes on/off and restarts safely off", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-auto-merge-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "light" }));
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  try {
    const app = await launch();
    try {
      const page = await app.firstWindow();
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      await expect(
        rail.getByRole("button", { name: "Auto-merge: off", exact: true }),
      ).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
      await rail.getByRole("button", { name: "Auto-merge: off", exact: true }).click();
      await expect(
        rail.getByRole("button", { name: "Auto-merge: on", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({ path: testInfo.outputPath("auto-merge-on.png") });
      await rail.getByRole("button", { name: "Auto-merge: on", exact: true }).click();
      await expect(
        rail.getByRole("button", { name: "Auto-merge: off", exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      await rail.getByRole("button", { name: "Auto-merge: off", exact: true }).click();
      await expect(rail.getByRole("button", { name: "Auto-merge: on", exact: true })).toBeVisible();
    } finally {
      await app.close();
    }
    const restarted = await launch();
    try {
      const page = await restarted.firstWindow();
      await expect(
        page.getByRole("button", { name: "Auto-merge: off", exact: true }),
      ).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
