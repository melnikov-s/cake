import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("opens a durable Pi session in the sandboxed desktop and survives a Pi runtime reset", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-s1-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
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
    await expect(
      page.getByRole("button", { name: "New chat in project", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Model")).toBeVisible();
    await expect(page.getByLabel("Thinking level")).toBeVisible();
    await expect(page.locator(".workspace-settings-icon")).toBeHidden();
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
          const toggle = document.querySelector(".header-sidebar-toggle")?.getBoundingClientRect();
          const settingsElement = document.querySelector(".workspace-settings-icon");
          const settings = settingsElement?.getBoundingClientRect();
          const composer = document.querySelector(".composer-dock");
          return {
            sidebarRemoved: sidebar?.width === 0,
            toggleClearsWindowControls: Boolean(toggle && toggle.left >= 84),
            settingsOnWorkspace: Boolean(
              settings && settings.left === 16 && Math.abs(innerHeight - settings.bottom - 9.5) < 1,
            ),
            settingsAboveComposer: Boolean(
              settingsElement &&
              composer &&
              Number(getComputedStyle(settingsElement).zIndex) >
                Number(getComputedStyle(composer).zIndex),
            ),
          };
        }),
      )
      .toEqual({
        sidebarRemoved: true,
        toggleClearsWindowControls: true,
        settingsOnWorkspace: true,
        settingsAboveComposer: true,
      });
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await page.locator(".sidebar").getByLabel("Open settings").click();
    await expect(page.getByRole("switch", { name: "Auto-compact" })).toBeVisible();
    await expect(page.getByLabel("Provider transport")).toHaveValue("auto");
    await expect(page.getByLabel("Default project trust")).toHaveValue("ask");
    await expect(page.getByLabel("Color theme")).toHaveValue("system");
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(page.getByLabel("Message")).toBeVisible();
    await expect(page.locator(".session-item.active")).toContainText("New chat");
    await expect(page.getByLabel("Back to chat")).toHaveCount(0);
    await page.evaluate(() => {
      const longTitle = `Investigate-${"very-long-session-name-".repeat(500)}`;
      const headerTitle = document.querySelector<HTMLElement>(".workspace-header strong");
      const sidebarTitle = document.querySelector<HTMLElement>(".session-row span");
      if (headerTitle) headerTitle.textContent = longTitle;
      if (sidebarTitle) sidebarTitle.textContent = longTitle;
    });
    expect(
      await page.evaluate(() => {
        const transcript = document.querySelector(".transcript");
        const composer = document.querySelector(".workbench-composer");
        const sidebar = document.querySelector(".sidebar");
        const workspace = document.querySelector(".workspace");
        const conversation = document.querySelector('[aria-label="Conversation"]');
        const sidebarRect = sidebar?.getBoundingClientRect();
        const workspaceRect = workspace?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        const conversationRect = conversation?.getBoundingClientRect();
        const visibleWorkspaceCenter = sidebarRect
          ? sidebarRect.right + (innerWidth - sidebarRect.right) / 2
          : 0;
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          transcriptFits: !transcript || transcript.scrollWidth <= transcript.clientWidth,
          workspaceFits: !workspaceRect || Math.abs(workspaceRect.right - innerWidth) < 1,
          composerFits: !composerRect || composerRect.right <= innerWidth,
          composerCentered:
            !composerRect ||
            Math.abs(composerRect.left + composerRect.width / 2 - visibleWorkspaceCenter) < 1,
          conversationCentered:
            !conversationRect ||
            Math.abs(conversationRect.left + conversationRect.width / 2 - visibleWorkspaceCenter) <
              1,
        };
      }),
    ).toEqual({
      documentFits: true,
      transcriptFits: true,
      workspaceFits: true,
      composerFits: true,
      composerCentered: true,
      conversationCentered: true,
    });

    const rendererCapabilities = await page.evaluate(() => ({
      require: typeof Reflect.get(window, "require"),
      process: typeof Reflect.get(window, "process"),
      rawElectron: typeof Reflect.get(window, "electron"),
      bridgeKeys: Object.keys(window.cake).sort(),
    }));
    expect(rendererCapabilities).toEqual({
      require: "undefined",
      process: "undefined",
      rawElectron: "undefined",
      bridgeKeys: ["request", "subscribe"],
    });

    await page.getByLabel("Message").fill("Persist this draft");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await application.evaluate(() => {
      const reset = Reflect.get(globalThis, "cakeSmokeResetPi");
      if (typeof reset !== "function") throw new Error("Pi reset hook is unavailable");
      reset();
    });

    await expect(page.getByText(/Pi runtime stopped/)).toBeVisible();
    await expect(page.getByLabel("Message")).toHaveValue("Persist this draft");
    expect(page.isClosed()).toBe(false);
    await page.getByRole("button", { name: "Restart and reopen" }).click();
    await expect(page.getByText(/Pi runtime stopped/)).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Message")).toHaveValue("Persist this draft", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
