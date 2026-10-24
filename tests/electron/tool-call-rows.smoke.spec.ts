import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { toolCallRowsScenario } from "../../scripts/visual-capture/tool-call-rows";

async function dragText(page: Page, target: Locator) {
  const points = await target.evaluate((element) => {
    const node = element.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, end: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(points.x, points.y);
  await page.mouse.down();
  await page.mouse.move(points.end, points.y, { steps: 12 });
  await page.mouse.up();
}

for (const { theme, width } of [
  { theme: "light", width: 1280 },
  { theme: "dark", width: 1280 },
  { theme: "light", width: 1000 },
  { theme: "dark", width: 1000 },
] as const) {
  test(`tool rows preserve spacing, truncation, selection and activation in ${theme} at ${width}px`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-tool-call-rows-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const repository = resolve(import.meta.dirname, "../..");
    await toolCallRowsScenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width, height: 900 });
      await toolCallRowsScenario.prepare(page);
      const row = (id: string) => page.locator(`[data-part-id="tool-${id}"]`);
      const home = row("home");
      const disclosure = home.locator("[aria-expanded]");
      const path = home.getByRole("button", { name: "~/.pi/agent/example.md", exact: true });
      const prefix = row("prefix").getByRole("button", {
        name: `${homedir()}-other/example.md`,
        exact: true,
      });
      await expect(prefix).toBeVisible();
      await expect(home.getByLabel("elapsed time")).toHaveCount(0);
      await expect(row("prefix").getByLabel("elapsed time")).toHaveCount(0);
      await expect(row("project").getByLabel("elapsed time")).toHaveCount(0);
      await expect(row("bash").getByLabel("elapsed time")).toHaveText("1s");

      const dotLabelSpacing = (target: Locator) =>
        target.evaluate((element) => {
          const dot = element.querySelector('[aria-hidden="true"]')!;
          const label = dot.nextElementSibling!;
          return label.getBoundingClientRect().left - dot.getBoundingClientRect().right;
        });
      const referenceSpacing = await page
        .getByText("Reasoning details not exposed", { exact: true })
        .evaluate(
          (label) =>
            label.getBoundingClientRect().left -
            label.previousElementSibling!.getBoundingClientRect().right,
        );
      expect(referenceSpacing).toBe(8);
      for (const id of [
        "home",
        "long-home",
        "prefix",
        "project",
        "bash",
        "custom",
        "todos.create",
        "todos.update",
      ]) {
        const trigger = row(id).locator("[aria-expanded]");
        await trigger.scrollIntoViewIfNeeded();
        expect(await dotLabelSpacing(trigger), id).toBe(referenceSpacing);
        const title = trigger.locator("span.truncate");
        expect(await title.evaluate((element) => element.clientWidth), id).toBeGreaterThan(0);
      }
      const subagent = row("subagents.start");
      await expect(subagent.locator('[data-slot="subagent-call"]')).toHaveAttribute(
        "data-status",
        "failed-to-start",
      );
      expect(await dotLabelSpacing(subagent)).toBe(referenceSpacing);
      expect(await dotLabelSpacing(subagent.locator('[data-slot="subagent-call"]'))).toBe(
        referenceSpacing,
      );
      expect(await dotLabelSpacing(page.locator('[data-slot="activity-group"] > summary'))).toBe(
        referenceSpacing,
      );

      // A long home path must shrink before the disclosure: otherwise its text
      // disappears and the path crowds/overlaps the non-shrinking status dot.
      const longHome = row("long-home");
      await longHome.scrollIntoViewIfNeeded();
      const longTrigger = longHome.locator("[aria-expanded]");
      const longPath = longHome.getByRole("button", { name: /^~\/\.pi\/agent\/cake-docs\// });
      const longTriggerBounds = await longTrigger.boundingBox();
      const longPathBounds = await longPath.boundingBox();
      expect(longPathBounds!.x - (longTriggerBounds!.x + longTriggerBounds!.width)).toBe(
        referenceSpacing,
      );
      expect(
        await longTrigger
          .locator("span.truncate")
          .evaluate((element) => element.clientWidth >= element.scrollWidth),
      ).toBe(true);
      expect(
        await longPath
          .locator("span")
          .evaluate((element) => element.clientWidth < element.scrollWidth),
      ).toBe(true);
      await home.scrollIntoViewIfNeeded();
      const disclosureBounds = await disclosure.boundingBox();
      const pathBounds = await path.boundingBox();
      expect(pathBounds!.x - (disclosureBounds!.x + disclosureBounds!.width)).toBe(
        referenceSpacing,
      );

      await dragText(page, path.locator("span"));
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toBe("~/.pi/agent/example.md");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("button", { name: "Back to agent", exact: true })).toHaveCount(0);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        "~/.pi/agent/example.md",
      );

      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      const command = row("bash").locator("[aria-expanded]");
      await command.scrollIntoViewIfNeeded();
      await dragText(page, command.locator("span.truncate"));
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toContain("tool calls are selectable");
      await expect(command).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
        "tool calls are selectable",
      );

      // Keyboard activation remains available even while text is selected.
      await command.focus();
      await page.keyboard.press("Enter");
      await expect(command).toHaveAttribute("aria-expanded", "true");
      await expect(row("bash").locator('[data-slot="tool-details"]')).toBeVisible();
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await command.click();
      await expect(command).toHaveAttribute("aria-expanded", "false");
      await home.scrollIntoViewIfNeeded();
      await home.hover();
      await home
        .getByRole("button", {
          name: `Copy ${join(homedir(), ".pi/agent/example.md")}`,
          exact: true,
        })
        .click();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(join(homedir(), ".pi/agent/example.md"));
      const projectLink = row("project").getByRole("button", { name: "example.ts", exact: true });
      await projectLink.click();
      await expect(page.getByRole("button", { name: "Back to agent", exact: true })).toBeVisible();
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard);
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
