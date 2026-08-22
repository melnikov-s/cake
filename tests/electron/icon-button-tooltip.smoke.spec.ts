import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("icon buttons reveal their tooltip bubble on hover and hide on leave", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-tooltip-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      theme: "system",
      draft: "",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    }),
  );

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible({
      timeout: 20_000,
    });

    const sidebarToggle = page.locator('[aria-label="Toggle sidebar"]').first();
    await sidebarToggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Toggle sidebar", { timeout: 2_000 });

    await page.mouse.move(400, 300);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    const settingsToggle = page.locator('button[aria-label="Open settings"]').first();
    await settingsToggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Open settings", { timeout: 2_000 });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
