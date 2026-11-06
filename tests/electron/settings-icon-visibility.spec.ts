import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("global Settings stays usable when Workspace closes and reopens", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-settings-icon-check-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "system" }));
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
    }),
  );
  const application = await electron.launch({
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
    const page = await application.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    const settings = rail.getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await rail.getByRole("button", { name: "Close Workspace", exact: true }).click();
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await rail.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await expect(settings).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
