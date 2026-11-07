import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { showSessions } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("icon buttons reveal their tooltip bubble on hover and hide on leave", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-tooltip-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const cakeState = join(cakeHome, "state");
  await mkdir(userData, { recursive: true });
  await mkdir(cakeState, { recursive: true });
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      theme: "system",
      draft: "",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(cakeState, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [],
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
    await expect(page.getByRole("button", { name: "Close Workspace" }).first()).toBeVisible({
      timeout: 20_000,
    });

    const modifier = /Mac/.test(await page.evaluate(() => navigator.userAgent)) ? "⌘" : "Ctrl+";
    const sidebarToggle = page.locator('[aria-label="Close Workspace"]').first();
    await sidebarToggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText(`Close Workspace (${modifier}B)`, {
      timeout: 2_000,
    });

    await page.mouse.move(400, 300);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await showSessions(page);
    const newSession = page.getByRole("button", { name: "New Session", exact: true });
    await newSession.hover();
    await expect(page.getByRole("tooltip")).toHaveText(`New Session (${modifier}N)`, {
      timeout: 2_000,
    });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
