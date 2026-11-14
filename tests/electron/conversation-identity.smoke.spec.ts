import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

test("identity stays docked in its chat column, preserves input/navigation, and persists hidden across relaunch", async () => {
  test.setTimeout(180_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-conversation-identity-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    project: join(temporary, "project"),
    userData: join(temporary, "user-data"),
  };
  const scenario = findVisualCaptureScenario("conversation-identity")!;
  const cleanup = await scenario.seed(paths, "dark");
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  let application = await launch();
  try {
    const page = await application.firstWindow();
    for (const state of ["project-chat", "long-title", "browser", "global-chat", "hidden"]) {
      await application.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 784),
        state === "project-chat" ? 1440 : 960,
      );
      await scenario.prepare(page, state, application);
      await page.screenshot({ path: test.info().outputPath(`${state}.png`) });
    }
    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await expect(
      restored.getByRole("navigation", { name: "Conversation breadcrumb" }),
    ).toBeVisible();
    await expect(restored.getByRole("navigation", { name: "Conversation identity" })).toHaveCount(
      0,
    );
    await expect(restored.locator('[data-slot="conversation-identity-layout"]')).toHaveCount(0);
    await restored.getByRole("button", { name: "Settings", exact: true }).click();
    await restored.getByRole("button", { name: /^Appearance/ }).click();
    const toggle = restored.getByRole("switch", { name: "Conversation identity tab", exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await restored.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(restored.getByRole("navigation", { name: "Conversation identity" })).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
    if (typeof cleanup === "function") await cleanup();
    await rm(temporary, { recursive: true, force: true });
  }
});
