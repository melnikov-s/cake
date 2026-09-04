import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("promotes a staged chat immediately and leaves New Chat free for the next session", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-staged-promotion-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
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
      trustedProjectPaths: [project],
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
    },
  });

  try {
    const page = await application.firstWindow();
    const synchronizationErrors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("synchronization failed")) synchronizationErrors.push(text);
    });
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });

    await composer.fill("First promoted session");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText(
      "[project] First promoted session",
    );
    const firstSession = page.locator(".session-item.active");
    await expect(firstSession).toHaveCount(1, { timeout: 20_000 });

    const firstSessionId = await firstSession.getAttribute("data-session-id");
    expect(firstSessionId).toBeTruthy();
    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await stop.click();
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(page.locator(".session-item.active")).toHaveCount(0);
    await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText(
      "[project] New chat",
    );
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();

    await composer.fill("Second promoted session");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText(
      "[project] Second promoted session",
    );
    await expect(page.locator(".session-item.active")).toHaveCount(1, { timeout: 20_000 });

    const firstSessionAfterPromotion = page.locator(
      `.session-item[data-session-id='${firstSessionId}']`,
    );
    await firstSessionAfterPromotion.locator(".session-row").click();
    await expect(firstSessionAfterPromotion).toHaveClass(/active/);
    await expect(firstSessionAfterPromotion.locator(".session-resolve-action")).toBeAttached();
    await firstSessionAfterPromotion.locator(".session-resolve-action").click();
    await expect(page.getByRole("region", { name: "Resolved sessions" })).toBeVisible();
    await expect(
      page.locator(`.session-item.active[data-session-id='${firstSessionId}']`),
    ).toHaveCount(0);
    await expect.poll(() => synchronizationErrors).toEqual([]);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
