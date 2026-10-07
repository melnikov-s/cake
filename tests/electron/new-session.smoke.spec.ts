import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("new session dialog supports filtering, keyboard, mouse and cancellation", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-new-session-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const alpha = join(temporaryRoot, "alpha");
  const beta = join(temporaryRoot, "beta");
  await Promise.all(
    [userData, join(cakeHome, "state"), alpha, beta].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ projectPath: alpha, recentProjectPaths: [alpha, beta], draft: "" }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [alpha, beta].map((path) => ({
        path,
        name: path === alpha ? "Alpha" : "Beta",
        addedAt: new Date(0).toISOString(),
        lastOpenedAt: new Date(0).toISOString(),
      })),
      trustedProjectPaths: [alpha, beta],
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
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    const dialog = page.getByRole("dialog", { name: "New session", exact: true });
    const filter = dialog.getByRole("combobox", { name: "Filter projects" });
    const selected = dialog.getByRole("option", { selected: true });
    await expect(message).toBeVisible({ timeout: 20_000 });
    await expect(message).toBeFocused();
    await page.keyboard.press(`${modifier}+N`);
    await expect(dialog).toBeVisible();
    await expect(filter).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveCount(3);
    // Async work behind the modal must not move keyboard input back to the composer.
    await message.evaluate((element: HTMLElement) => element.focus());
    await expect(filter).toBeFocused();
    await expect(selected).toContainText("Cake Chat");
    await page.keyboard.press("ArrowUp");
    await expect(filter).toBeFocused();
    await expect(selected).toContainText("Beta");
    await page.keyboard.press("ArrowDown");
    await expect(filter).toBeFocused();
    await expect(selected).toContainText("Cake Chat");
    await page.keyboard.press("ArrowDown");
    await expect(filter).toBeFocused();
    await expect(selected).toContainText("Alpha");
    await page.keyboard.type("BETA");
    await expect(filter).toHaveValue("BETA");
    await expect(filter).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(selected).toContainText("Beta");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(message).toBeFocused();

    // The global shortcut works with the sidebar hidden, too.
    await page.keyboard.press(`${modifier}+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
    await page.keyboard.press(`${modifier}+N`);
    await expect(filter).toHaveValue("");
    await expect(filter).toBeFocused();
    await page.keyboard.type("missing");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toHaveText("No matching destinations.");
    await expect(dialog).toBeVisible();
    await filter.fill("");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(filter).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    const cakeMessage = page.getByRole("combobox", { name: "Message Cake Chat" });
    await expect(cakeMessage).toBeFocused();
    await page.keyboard.type("A Cake Chat draft");
    await expect(cakeMessage).toHaveValue("A Cake Chat draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await page.keyboard.press(`${modifier}+B`);
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await expect(filter).toBeFocused();
    await dialog.getByRole("option", { name: /Beta/ }).click();
    await expect(dialog).toBeHidden();
    await expect(message).toBeFocused();
    await page.keyboard.type("A Beta project draft");
    await expect(message).toHaveValue("A Beta project draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.keyboard.press(`${modifier}+N`);
    await expect(filter).toBeFocused();
    await expect(selected).toContainText("Beta");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(message).toBeFocused();
    await expect(message).toHaveValue("A Beta project draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.keyboard.press(`${modifier}+N`);
    await page.keyboard.type("alpha");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(message).toBeVisible();
    await expect(message).toBeFocused();
    await page.keyboard.press(`${modifier}+N`);
    await expect(selected).toContainText("Alpha");
    // Browsing another destination without creating there must not change the default.
    await page.keyboard.press("ArrowDown");
    await expect(selected).toContainText("Beta");
    await page.keyboard.press("Escape");
    await expect(message).toBeFocused();
    await expect(async () => {
      const snapshot: unknown = JSON.parse(
        await readFile(join(userData, "window-state.json"), "utf8"),
      );
      expect(snapshot).toMatchObject({
        data: { children: { newSessionStore: { state: { lastProjectPath: alpha } } } },
      });
    }).toPass({ timeout: 10_000 });
    await page.reload();
    await expect(message).toBeVisible();
    await expect(message).toBeFocused();
    await page.keyboard.press(`${modifier}+N`);
    await expect(filter).toBeFocused();
    await expect(selected).toContainText("Alpha");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
