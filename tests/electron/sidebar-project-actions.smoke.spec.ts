import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test as base, type Page } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { store, windowStateDocument } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const test = base.extend<{ sidebar: Page }>({
  sidebar: async ({ colorScheme }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-sidebar-project-actions-"));
    const userData = join(directory, "user-data");
    const cakeHome = join(directory, "cake-home");
    const projects = ["alpha", "beta"].map((name) => ({ path: join(directory, name), name }));
    const timestamp = new Date(0).toISOString();
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      ...projects.map(({ path }) => mkdir(path)),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowStateDocument({
        projectCatalogStore: store({ projectOrder: projects.map(({ path }) => path) }),
      }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: projects.map((project) => ({
            ...project,
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          })),
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
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('[data-slot="project-label"]')).toHaveText(["alpha", "beta"], {
        timeout: 20_000,
      });
      await use(page);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

for (const theme of ["light", "dark"] as const) {
  test(`project actions follow hover, not selection or mouse collapse (${theme})`, async ({
    sidebar: page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    for (const name of ["alpha", "beta"]) {
      const header = page.locator('[data-slot="project-header"]').filter({ hasText: name });
      const label = header.locator('[data-slot="project-label"]');
      const actions = header.locator('[data-slot="project-actions"]');
      const status = header.locator('[data-slot="project-chat-status"]');
      await label.click();
      await expect(label).toHaveAttribute("aria-current", "page");
      await page.mouse.move(1, 1);
      await expect(actions).toHaveCSS("opacity", "0");
      await expect(status).toHaveCSS("opacity", "1");

      const collapse = header.locator("button[aria-expanded]").first();
      await collapse.click();
      await expect(collapse).toHaveAttribute("aria-expanded", "false");
      await page.mouse.move(1, 1);
      await expect(collapse).toBeFocused();
      expect(await collapse.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
      expect(await header.evaluate((element) => element.matches(":hover"))).toBe(false);
      await expect(actions).toHaveCSS("opacity", "0");
      await expect(status).toHaveCSS("opacity", "1");
      await expect(label).toBeVisible();
      await expect(collapse).toBeVisible();

      await label.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      await expect(status).toHaveCSS("opacity", "0");
      await header.getByRole("button", { name: `Expand ${name}`, exact: true }).click();
      await page.mouse.move(1, 1);
      await expect(actions).toHaveCSS("opacity", "0");
      await expect(status).toHaveCSS("opacity", "1");
    }
  });
}

test("keyboard focus reveals project actions and keeps sort controls accessible", async ({
  sidebar: page,
}) => {
  const header = page.locator('[data-slot="project-header"]').first();
  const actions = header.locator('[data-slot="project-actions"]');
  await header.getByRole("button", { name: "Collapse alpha", exact: true }).click();
  await page.mouse.move(1, 1);
  await page.keyboard.press("Tab");
  const label = header.locator('[data-slot="project-label"]');
  await expect(label).toBeFocused();
  expect(await label.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  const trigger = header.getByRole("button", { name: "Project actions for alpha", exact: true });
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Project actions for alpha" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Focus on alpha" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Open settings for alpha" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "By date" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitemradio", { name: "By label" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    header.getByRole("button", { name: "New chat in alpha", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(actions).toHaveCSS("opacity", "0");
});

test("coarse pointers retain visible, usable project actions without hover", async ({
  sidebar: page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const header = page.locator('[data-slot="project-header"]').first();
  await page.mouse.move(1, 1);
  const actions = header.locator('[data-slot="project-actions"]');
  await expect(actions).toHaveCSS("opacity", "1");
  const sort = await header
    .getByRole("button", { name: "Project actions for alpha", exact: true })
    .boundingBox();
  expect(sort).not.toBeNull();
  // Electron's existing context cannot opt into Playwright hasTouch; dispatch real CDP touch input.
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: sort!.x + sort!.width / 2, y: sort!.y + sort!.height / 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByRole("menu", { name: "Project actions for alpha" })).toBeVisible();
});
