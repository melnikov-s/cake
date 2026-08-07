import { _electron as electron, expect, test } from "@playwright/test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("streams Pi output, confirms extension UI, and survives agent termination", async () => {
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: { ...process.env, CAKE_ELECTRON_SMOKE: "1" }
  });

  try {
    const page = await application.firstWindow();

    await expect(page.getByText("Agent ready", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Test Pi session" })).toBeEnabled();

    const rendererCapabilities = await page.evaluate(() => ({
      require: typeof Reflect.get(window, "require"),
      process: typeof Reflect.get(window, "process"),
      rawElectron: typeof Reflect.get(window, "electron"),
      bridgeKeys: Object.keys(window.cake).sort()
    }));
    expect(rendererCapabilities).toEqual({
      require: "undefined",
      process: "undefined",
      rawElectron: "undefined",
      bridgeKeys: ["request", "subscribe"]
    });

    await page.getByRole("button", { name: "Test Pi session" }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Pi extension confirmation");
    await confirmation.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("status")).toContainText("Pi session boundary is alive.");

    await application.evaluate(() => {
      const terminate = Reflect.get(globalThis, "cakeSmokeTerminateAgent");
      if (typeof terminate !== "function") throw new Error("Smoke termination hook is unavailable");
      terminate();
    });

    await expect(page.getByText(/Agent (stopped|failed)/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cake" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Test Pi session" })).toBeDisabled();
    expect(page.isClosed()).toBe(false);
  } finally {
    await application.close();
  }
});
