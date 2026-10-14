import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["dark", "light"] as const) {
  test(`new session keeps hover separate from keyboard choice with readable rows (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-new-session-hover-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("new-session")!;
    await scenario.seed(paths, theme);
    const application = await electron.launch({
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
    try {
      const page = await application.firstWindow();
      await page.emulateMedia({ colorScheme: theme });
      await scenario.prepare(page, "default", application);
      const dialog = page.getByRole("dialog", { name: "New session", exact: true });
      const filter = dialog.getByRole("combobox", { name: "Filter projects" });
      const selected = dialog.getByRole("option", { selected: true });
      const cakeChat = dialog.getByRole("option", {
        name: "Cake Chat Chat with Cake",
        exact: true,
      });
      const cakeProject = dialog.getByRole("option").filter({ hasText: paths.project });
      const research = dialog.getByRole("option", { name: /^Research/ });
      await expect(selected).toContainText("Cake Chat");

      // Sample actual rendered colors, including translucent backgrounds and hover overrides.
      const assertReadable = async (row: typeof selected) => {
        const contrasts = await row.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const card = element.closest('[role="dialog"]')!.firstElementChild!;
          const luminance = () => {
            const rgb = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
            const linear = rgb.map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
          };
          return Array.from(element.querySelectorAll("span.truncate")).map((text) => {
            context.fillStyle = getComputedStyle(card).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            context.fillStyle = getComputedStyle(element).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            const background = luminance();
            context.fillStyle = getComputedStyle(text).color;
            context.fillRect(0, 0, 1, 1);
            const foreground = luminance();
            return (
              (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
            );
          });
        });
        expect(contrasts).toHaveLength(2);
        for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
      };
      await assertReadable(cakeChat);
      await cakeChat.hover();
      await assertReadable(cakeChat);
      await research.hover();
      await expect(selected).toContainText("Cake Chat");
      await assertReadable(research);
      await assertReadable(cakeChat);
      await expect(filter).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(cakeProject).toHaveAttribute("aria-selected", "true");
      await assertReadable(cakeProject);
      await cakeProject.hover();
      await assertReadable(cakeProject);
      await research.hover();
      await expect(cakeProject).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowDown");
      await expect(selected).toContainText("Website");
      await page.keyboard.press("ArrowUp");
      await expect(cakeProject).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      const message = page.getByRole("combobox", { name: "Message", exact: true });
      await expect(message).toBeFocused();
      await page.keyboard.type("Draft in the keyboard-selected project");
      await expect(message).toHaveValue("Draft in the keyboard-selected project");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

      await page.keyboard.press(process.platform === "darwin" ? "Meta+N" : "Control+N");
      await expect(cakeProject).toHaveAttribute("aria-selected", "true");
      await research.click();
      await expect(dialog).toBeHidden();
      await expect(message).toBeFocused();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+N" : "Control+N");
      await expect(research).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(message).toBeFocused();
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
    windowState({ project: alpha, projects: [alpha, beta] }),
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
    // Hover is feedback only; Enter must keep targeting the keyboard-active option.
    await dialog.getByRole("option", { name: /Beta/ }).hover();
    await expect(selected).toContainText("Alpha");
    await expect(filter).toBeFocused();
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
