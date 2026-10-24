import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const action of ["close", "quit"] as const) {
  test(`persists a settings edit immediately before native ${action} and restores it on relaunch`, async () => {
    test.setTimeout(90_000);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-window-settings-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(join(userData, "window-state.json"), windowState({ project }));
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: project,
            name: "Fixture",
            addedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString(),
          },
        ],
        trustedProjectPaths: [],
      }),
    );
    const launch = () =>
      electron.launch({
        args: [repositoryRoot],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_ELECTRON_USER_DATA: userData,
          CAKE_HOME: cakeHome,
          PI_CODING_AGENT_DIR: join(temporaryRoot, "pi-agent"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
    let application = await launch();
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
      await page.getByRole("button", { name: /^Appearance/ }).click();
      // Native select interaction, not direct Store mutation.
      await page.getByLabel("Color theme", { exact: true }).selectOption("dark");
      const closed =
        action === "quit" ? application.waitForEvent("close") : page.waitForEvent("close");
      await application
        .evaluate(({ app, BrowserWindow }, operation) => {
          const window = BrowserWindow.getAllWindows().find(
            (candidate) => !candidate.isDestroyed(),
          );
          if (window?.isVisible()) throw new Error("Persistence smoke window must stay hidden");
          if (operation === "quit") app.quit();
          else window?.close();
        }, action)
        .catch((error: unknown) => {
          // Quitting can close the debugging transport before evaluate's receipt.
          if (action !== "quit") throw error;
        });
      await closed;
      const document = JSON.parse(await readFile(join(userData, "window-state.json"), "utf8"));
      expect(document.data.children.settingsStore.children.appearance.state.theme).toBe("dark");
      if (action === "close") await application.close();
      application = await launch();
      const restored = await application.firstWindow();
      await restored.getByRole("button", { name: /^Appearance/ }).click({ timeout: 20_000 });
      await expect(restored.getByLabel("Color theme", { exact: true })).toHaveValue("dark");
    } finally {
      await application.close().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
