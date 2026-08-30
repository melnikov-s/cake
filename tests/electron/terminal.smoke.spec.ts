import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Quake terminal runs a shell and remains alive while hidden", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-terminal-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
    }),
  );
  await writeFile(
    join(userData, "application.json"),
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
      resolvedSessionIds: [],
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
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Terminal (⌘~)" }).click();

    const panel = page.locator('section[aria-label="Terminal"]');
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(panel.locator(".xterm-screen")).toBeVisible();
    await panel.locator(".xterm-screen").click();
    await page.keyboard.type("printf CAKE_TERMINAL_OK");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows")).toContainText("CAKE_TERMINAL_OK", {
      timeout: 10_000,
    });

    await page.keyboard.press("Meta+Backquote");
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await page.keyboard.press("Meta+Backquote");
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(panel.locator(".xterm-rows")).toContainText("CAKE_TERMINAL_OK");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
