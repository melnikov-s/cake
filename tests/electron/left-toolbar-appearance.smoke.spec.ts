import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`left toolbar five modes, accessible disclosure and stable workspace (${theme})`, async () => {
    test.setTimeout(240_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-toolbar-"));
    const userData = join(temporary, "user-data");
    const cakeHome = join(temporary, "cake-home");
    const project = join(temporary, "project");
    await Promise.all(
      [userData, project, join(cakeHome, "state"), resolve(".visual-captures")].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await writeFile(join(userData, "window-state.json"), windowState({ project, theme }));
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 11,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Toolbar fixture",
              addedAt: new Date(0).toISOString(),
              lastOpenedAt: new Date(0).toISOString(),
            },
          ],
        },
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
        PI_CODING_AGENT_DIR: join(temporary, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      const workspace = page.locator('[data-slot="workspace"]');
      const composer = page.getByRole("combobox", { name: /^Message/ }).first();
      await expect(composer).toBeVisible({ timeout: 20_000 });
      const width = async () => (await rail.boundingBox())?.width ?? 0;
      const screenshot = async (name: string) =>
        page.screenshot({
          path: resolve(`.visual-captures/left-toolbar-rebased-${theme}-${name}.png`),
          animations: "disabled",
        });
      const settings = async () => {
        if (!(await rail.isVisible()))
          await page.getByRole("button", { name: "Show left toolbar", exact: true }).click();
        await rail.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: /^Appearance/ }).click();
        await expect(page.getByLabel("Layout", { exact: true })).toBeVisible();
      };
      const back = async () => {
        await page.getByRole("button", { name: "Back to chat", exact: true }).click();
        await composer.focus();
        await page.mouse.move(600, 200);
      };
      await expect.poll(width).toBe(54);
      await expect(rail).toHaveAttribute("data-expanded", "false");
      const initialBounds = await workspace.boundingBox();
      await rail.hover();
      await expect.poll(width).toBe(240);
      expect(await workspace.boundingBox()).toEqual(initialBounds);
      await expect(rail).toHaveAttribute("data-expanded", "true");
      await screenshot("off-dynamic");
      await settings();
      await screenshot("settings");

      for (const layout of ["full", "slim"] as const) {
        await page.getByLabel("Layout", { exact: true }).selectOption(layout);
        await back();
        await expect.poll(width).toBe(layout === "full" ? 240 : 54);
        const before = await workspace.boundingBox();
        await rail.getByRole("button", { name: "Add project", exact: true }).hover();
        await expect.poll(width).toBe(layout === "full" ? 240 : 54);
        await expect(rail).toHaveAttribute("data-expanded", String(layout === "full"));
        if (layout === "full") {
          await expect(page.getByRole("tooltip")).toHaveCount(0);
          await expect(
            rail
              .getByRole("button", { name: "Add project", exact: true })
              .locator('[data-slot="icon-button-label"]'),
          ).toHaveCSS("font-weight", "600");
        } else
          await expect(page.getByRole("tooltip").filter({ hasText: "Add project" })).toBeVisible();
        expect(await workspace.boundingBox()).toEqual(before);
        await screenshot(`off-${layout}`);
        await settings();
      }
      // Remember Dynamic, independently of the auto-hidden Full/Slim choice.
      await page.getByLabel("Layout", { exact: true }).selectOption("dynamic");
      await page.getByRole("switch", { name: "Auto-hide", exact: true }).click();
      await expect(page.getByLabel("Layout", { exact: true })).toHaveValue("full");
      await expect(page.getByRole("option", { name: "Dynamic", exact: true })).toBeDisabled();
      await screenshot("settings-auto-hide");
      for (const layout of ["full", "slim"] as const) {
        await page.getByLabel("Layout", { exact: true }).selectOption(layout);
        await back();
        await expect.poll(width).toBe(0);
        const before = await workspace.boundingBox();
        expect(before?.x).toBe(0);
        const scroll = await workspace.evaluate((element) =>
          [...element.querySelectorAll("*")].map((node) => node.scrollTop),
        );
        const edgeBounds = (await page.locator('[data-slot="project-rail-edge"]').boundingBox())!;
        await page.mouse.move(1, edgeBounds.y + 100);
        await expect.poll(width).toBe(layout === "full" ? 240 : 54);
        await screenshot(`on-${layout}`);
        expect(await workspace.boundingBox()).toEqual(before);
        expect(
          await workspace.evaluate((element) =>
            [...element.querySelectorAll("*")].map((node) => node.scrollTop),
          ),
        ).toEqual(scroll);
        await page.mouse.move(600, 200);
        await expect.poll(width).toBe(0);
        // Keyboard reveal, focus retention, and safe Escape return to the affordance.
        const reveal = page.getByRole("button", { name: "Show left toolbar", exact: true });
        await reveal.focus();
        await page.keyboard.press("Enter");
        await expect(
          rail.getByRole("button", { name: "Open Cake Chat", exact: true }),
        ).toBeFocused();
        await page.mouse.move(600, 200);
        await expect.poll(width).toBe(layout === "full" ? 240 : 54);
        await page.keyboard.press("Escape");
        await expect(reveal).toBeFocused();
        await expect.poll(width).toBe(0);
        // Coarse/touch activation uses the same explicit button, not hover.
        await reveal.dispatchEvent("pointerenter", { pointerType: "touch" });
        await expect.poll(width).toBe(0);
        await reveal.click();
        const sharing = rail.getByRole("button", { name: /^Browser sharing:/ });
        await sharing.click();
        const popup = page.getByRole("dialog", { name: "Browser sharing", exact: true });
        await expect(popup).toBeVisible();
        await popup.hover();
        await expect.poll(width).toBe(layout === "full" ? 240 : 54);
        await page.keyboard.press("Escape");
        await expect(popup).toHaveCount(0);
        await expect(sharing).toBeFocused();
        await expect.poll(width).toBe(layout === "full" ? 240 : 54);
        await page.keyboard.press("Escape");
        await expect.poll(width).toBe(0);
        await settings();
      }
      await page.reload();
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await settings();
      await expect(page.getByRole("switch", { name: "Auto-hide", exact: true })).toBeChecked();
      await expect(page.getByLabel("Layout", { exact: true })).toHaveValue("slim");
      await page.getByRole("switch", { name: "Auto-hide", exact: true }).click();
      await expect(page.getByLabel("Layout", { exact: true })).toHaveValue("dynamic");
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(join(cakeHome, "state", "application.json"), "utf8")).data
              .leftToolbar,
        )
        .toEqual({ autoHide: false, layout: "dynamic" });
      const windows = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      );
      expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
    } finally {
      await application.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
