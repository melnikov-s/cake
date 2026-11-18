import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const railSelector = '[data-slot="depth-rails"] > span';
const avatarSelector = '[data-slot="session-leading"] [data-slot="avatar"]';

async function centerX(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.x + box!.width / 2;
}

for (const theme of ["light", "dark"] as const) {
  test(`Sessions guides align with ancestor icons without interfering with the rows (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-tree-connectors-"));
    const paths = {
      userData: join(root, "user-data"),
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
    };
    const scenario = findVisualCaptureScenario("chat-first-navigation")!;
    const cleanup = await scenario.seed(paths, theme);
    try {
      const app = await electron.launch({
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
        const page = await app.firstWindow();
        await scenario.prepare(page, "panel-sessions", app);
        const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
        const row = (id: string) =>
          workspace.locator(`[data-slot="conversation-navigator-row"][data-session-id="${id}"]`);
        const parent = row("visual-navigation-layout");
        const child = row("visual-navigation-keyboard");
        const grandchild = row("10000000-0000-4000-8000-000000000103");
        const resize = page.getByRole("separator", { name: "Resize Workspace", exact: true });

        async function assertGuides(row: Locator, ancestors: Locator[]) {
          const guides = row.locator(railSelector);
          await expect(guides).toHaveCount(ancestors.length);
          for (const [index, ancestor] of ancestors.entries()) {
            const guide = guides.nth(index);
            await expect(guide).toHaveCSS("border-left-width", "1px");
            const box = await guide.boundingBox();
            expect(box).not.toBeNull();
            expect(
              Math.abs(box!.x + 0.5 - (await centerX(ancestor.locator(avatarSelector)))),
            ).toBeLessThanOrEqual(1);
          }
        }

        for (const key of ["Home", "End"]) {
          await resize.focus();
          await page.keyboard.press(key);
          await assertGuides(parent, []);
          await assertGuides(row("visual-navigation-icons"), []);
          await assertGuides(child, [parent]);
          await assertGuides(grandchild, [parent, child]);
        }

        const title = child.locator(".session-title");
        const initialTitle = await title.boundingBox();
        expect(initialTitle!.width).toBeGreaterThan(60);
        const initialFill = await child.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await title.hover();
        await expect(child).not.toHaveCSS("background-color", initialFill);
        expect(await title.boundingBox()).toEqual(initialTitle);
        await child.locator(".session-row > button").click();
        await expect(child).toHaveAttribute("data-navigation-active", "true");

        await child.getByRole("button", { name: /^Change session labels/ }).click();
        await expect(page.getByRole("group", { name: "Session labels" })).toBeVisible();
        await page.keyboard.press("Escape");
        await parent.getByRole("button", { name: "Collapse UI Layout Refactor" }).click();
        await expect(child).toBeHidden();
        await expect(grandchild).toBeHidden();
        await parent.getByRole("button", { name: "Expand UI Layout Refactor" }).click();
        await assertGuides(child, [parent]);
        await assertGuides(grandchild, [parent, child]);
      } finally {
        await app.close();
      }
    } finally {
      if (typeof cleanup === "function") await cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
}
