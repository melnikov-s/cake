import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { provokeRendererCrash } from "./renderer-crash-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("crash diagnostics cover DOM and native overlays, reach both consoles, and allow reload", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-renderer-crash-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
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
  let terminal = "";
  application.process().stderr?.on("data", (chunk: Buffer) => {
    terminal += chunk.toString();
  });
  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await provokeRendererCrash(page, application);
    const crash = page.getByRole("dialog", { name: "Cake encountered an error", exact: true });
    await expect(crash).toBeVisible();
    expect(await crash.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
    const details = await crash.locator("pre").innerText();
    expect(details).toContain("Backend boundary regression: full diagnostic stack");
    expect(details).toContain("React component stack:");
    await expect.poll(() => terminal).toContain(details);
    expect(consoleErrors.some((message) => message.includes(details))).toBe(true);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, "rendererCrashCover").getVisible()),
    ).toBe(false);
    const reload = crash.getByRole("button", { name: "Reload Cake", exact: true });
    expect(
      await reload.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
    await expect(reload).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(crash).toBeVisible();
    await reload.click();
    await expect(page.getByRole("button", { name: "Open settings", exact: true })).toBeVisible();
    await expect(crash).toHaveCount(0);
    const teardownErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") teardownErrors.push(message.text());
    });
    await page.goto("about:blank");
    expect(teardownErrors).toEqual([]);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application.evaluate(() =>
      Reflect.get(globalThis, "rendererCrashCover")?.webContents.close(),
    );
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
