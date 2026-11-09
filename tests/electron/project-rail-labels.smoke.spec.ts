import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { windowState } from "../fixtures/window-state";

for (const theme of ["light", "dark"] as const) {
  test(`expanded rail labels and tooltip disclosure in ${theme}`, async () => {
    test.setTimeout(120_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-rail-labels-"));
    const paths = {
      cakeHome: join(temporary, "cake-home"),
      project: join(temporary, "project"),
      userData: join(temporary, "user-data"),
    };
    await Promise.all([
      mkdir(paths.project, { recursive: true }),
      mkdir(paths.userData, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowState({ project: paths.project, theme }),
    );
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 10,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: paths.project, name: "cake", addedAt: timestamp, lastOpenedAt: timestamp },
            {
              path: join(temporary, "docs-site"),
              name: "docs-site",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
            },
          ],
        },
      }),
    );
    const repositoryRoot = resolve(import.meta.dirname, "../..");
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

      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      const project = rail.getByRole("button", { name: "Open Project Chat for cake", exact: true });
      const automations = rail.getByRole("button", { name: "Automations", exact: true });
      const labels = rail.locator('[data-slot="icon-button-label"]');
      await expect(project).toBeVisible({ timeout: 20_000 });
      await project.click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      await rail.hover();
      await expect(rail).toHaveAttribute("data-labels-visible", "true");
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
      for (const name of [
        "Open Cake Chat",
        "Add project",
        "Open Project Chat for cake",
        "New session",
        "Search sessions",
        "Browser sharing: Offline — go online",
        "Artifacts",
        "Automations",
        "Settings",
      ]) {
        const button = rail.getByRole("button", { name, exact: true });
        await expect(button.locator('[data-slot="icon-button-label"]')).toHaveCSS(
          "font-weight",
          "600",
        );
        await expect(button).toHaveCSS("height", "36px");
        await button.hover();
        await page.waitForTimeout(180);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
      }
      await expect(project).toHaveAttribute("aria-current", "page");
      const status = rail.getByText(": Offline", { exact: true });
      await expect(status).toHaveCSS("font-weight", "400");
      const evidence = await labels.first().evaluate((label) => {
        const nav = label.closest("nav")!;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const luminance = (color: string) => {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data)
            .slice(0, 3)
            .map((byte) => {
              const c = byte / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
        };
        const color = getComputedStyle(label).color;
        const background = getComputedStyle(nav).backgroundColor;
        const a = luminance(color),
          b = luminance(background);
        return {
          color,
          background,
          contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          size: getComputedStyle(label).fontSize,
        };
      });
      expect(evidence.contrast).toBeGreaterThanOrEqual(4.5);
      console.log("RAIL_LABEL_EVIDENCE", JSON.stringify({ theme, ...evidence }));
      await page.mouse.move(1, 48);
      await mkdir(resolve(repositoryRoot, ".visual-captures"), { recursive: true });
      await page.screenshot({
        path: resolve(repositoryRoot, `.visual-captures/after-expanded-${theme}.png`),
      });

      // Keyboard focus expands too: never replace a visible label with a duplicate focus bubble.
      await page.mouse.move(500, 200);
      await page.keyboard.press("Tab");
      await automations.focus();
      expect(await automations.evaluate((button) => button.matches(":focus-visible"))).toBe(true);
      await page.waitForTimeout(180);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await automations.press("Enter");
      await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await rail
        .getByRole("button", { name: "Browser sharing: Offline — go online", exact: true })
        .click();
      const sharing = page.getByRole("dialog", { name: "Browser sharing", exact: true });
      await expect(sharing).toBeVisible();
      await expect(sharing.getByRole("button", { name: "Go online", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      // A non-hover device can keep the rail collapsed while an icon is hovered.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
      await page.getByRole("combobox", { name: "Message Project Chat", exact: true }).focus();
      await page.mouse.move(500, 200);
      await automations.hover();
      await expect(rail).toHaveAttribute("data-labels-visible", "false");
      await expect(page.getByRole("tooltip")).toHaveText("Automations");
      await page.screenshot({
        path: resolve(repositoryRoot, `.visual-captures/collapsed-tooltip-${theme}.png`),
      });
      await project.hover();
      await expect(page.getByRole("tooltip")).toHaveText("cake");
      await expect(project).toHaveAccessibleName("Open Project Chat for cake");
      // Re-enable hover while the project tooltip is open; labels appear and stale bubble closes.
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await expect(rail).toHaveAttribute("data-labels-visible", "true");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await page.waitForTimeout(180);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await cdp.detach();

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
