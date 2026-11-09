import { expect, type Page } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios.ts";

/** Exercise real theme application and the full source-list containers, not theme-card mockups. */
export function createSidebarSurfacesScenario(
  navigation: VisualCaptureScenario,
): VisualCaptureScenario {
  let initialTheme: "light" | "dark" = "light";
  const checkSurfaces = async (page: Page, expanded = false) => {
    const evidence = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('[data-slot="project-rail"]')!;
      const panel = document.querySelector<HTMLElement>('[data-slot="workspace-navigator"]')!;
      const workspace = document.querySelector<HTMLElement>('[data-slot="workspace"]')!;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const sample = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const rgba = Array.from(context.getImageData(0, 0, 1, 1).data);
        const linear = rgba.slice(0, 3).map((byte) => {
          const value = byte / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        const rect = element.getBoundingClientRect();
        return {
          color: style.backgroundColor,
          rgba,
          luminance: 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          // The source-list container must cover every vertical point at its outer edge.
          fullHeight: [rect.top + 3, (rect.top + rect.bottom) / 2, rect.bottom - 3].every((y) =>
            document.elementsFromPoint(rect.right - 3, y).includes(element),
          ),
        };
      };
      return {
        theme: document.documentElement.dataset.theme,
        rail: sample(rail),
        panel: sample(panel),
        chat: sample(workspace.parentElement!),
        workspaceTop: workspace.getBoundingClientRect().top,
        height: innerHeight,
      };
    });
    for (const surface of [evidence.rail, evidence.panel]) {
      expect(surface.color).toBe(evidence.rail.color);
      expect(surface.fullHeight).toBe(true);
      expect(surface.bottom).toBe(evidence.height);
      // The rail begins at the titlebar; Workspace includes its one-pixel bottom rule.
      expect(Math.abs(surface.top - evidence.workspaceTop)).toBeLessThanOrEqual(1);
      expect(surface.rgba[3]).toBe(255);
      if (evidence.theme === "light")
        expect(surface.luminance).toBeLessThan(evidence.chat.luminance);
      else expect(surface.luminance).toBeGreaterThan(evidence.chat.luminance);
    }
    expect(evidence.rail.width).toBe(expanded ? 240 : 54);
    console.log("SIDEBAR_SURFACE_EVIDENCE", JSON.stringify(evidence));
  };
  const chooseTheme = async (page: Page, mode: "light" | "dark", name: string) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const label = mode === "light" ? "Light" : "Dark";
    await page.getByRole("button", { name: label, exact: true }).click();
    const gallery = page.getByRole("button", { name: `${label} theme`, exact: true });
    if ((await gallery.getAttribute("aria-expanded")) === "false") await gallery.click();
    await page.getByRole("button", { name: `${name} theme`, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.mouse.move(500, 200);
    await expect
      .poll(async () => (await page.locator('[data-slot="project-rail"]').boundingBox())?.width)
      .toBe(54);
  };
  return {
    ...navigation,
    name: "sidebar-surfaces",
    description:
      "Full-height sidebar contrast in both appearances, expanded navigation and live theme changes",
    states: ["default", "expanded", "rose-pine", "theme-cycle"],
    seed(paths, theme) {
      initialTheme = theme;
      return navigation.seed(paths, theme);
    },
    async prepare(page, state, application) {
      await navigation.prepare(page, "project-todos", application);
      if (state === "rose-pine")
        await chooseTheme(
          page,
          initialTheme,
          initialTheme === "light" ? "Rosé Pine Dawn" : "Rosé Pine",
        );
      if (state === "theme-cycle") {
        for (const [mode, name] of [
          ["light", "Rosé Pine Dawn"],
          ["dark", "Rosé Pine"],
          ["dark", "Hearth"],
          ["dark", "Solarized Dark"],
          ["dark", "Tokyo Night"],
          ["light", "Cake Light"],
          ["dark", "Cake Dark"],
        ] as const) {
          await chooseTheme(page, mode, name);
          await checkSurfaces(page);
        }
        await chooseTheme(
          page,
          initialTheme,
          initialTheme === "light" ? "Cake Light" : "Cake Dark",
        );
      }
      if (state === "expanded") {
        const rail = page.locator('[data-slot="project-rail"]');
        await rail.hover();
        const bounds = (await rail.boundingBox())!;
        await page.mouse.move(bounds.x + 1, bounds.y + 3);
        await expect.poll(async () => (await rail.boundingBox())?.width).toBe(240);
      }
      await checkSurfaces(page, state === "expanded");
      const panel = page.getByRole("complementary", { name: "Workspace", exact: true });
      await panel.getByRole("button", { name: /^Sessions / }).click();
      await expect(panel.getByRole("button", { name: "cake", exact: true })).toBeVisible();
      await page.mouse.move(500, 200);
      await expect
        .poll(async () => (await page.locator('[data-slot="project-rail"]').boundingBox())?.width)
        .toBe(54);
      // Both accessory modes inherit the same full-height surface.
      await checkSurfaces(page, false);
      await panel.getByRole("button", { name: /^To-dos / }).click();
      if (state === "expanded") {
        const rail = page.locator('[data-slot="project-rail"]');
        await rail.hover();
        const bounds = (await rail.boundingBox())!;
        await page.mouse.move(bounds.x + 1, bounds.y + 3);
        await expect.poll(async () => (await rail.boundingBox())?.width).toBe(240);
      } else await page.mouse.move(1, 1);
      await expect(panel.getByRole("button", { name: /^To-dos / })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await checkSurfaces(page, state === "expanded");
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
    },
  };
}
