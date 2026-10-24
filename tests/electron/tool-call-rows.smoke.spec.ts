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

for (const theme of ["light", "dark"] as const) {
  test(`tool rows support native text selection, copy and activation in ${theme}`, async () => {
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
      await expect(row("project").getByLabel("elapsed time")).toHaveText("0.1s");
      await expect(row("bash").getByLabel("elapsed time")).toHaveText("1.2s");

      const spacing = await disclosure.evaluate((element) => {
        const dot = element.querySelector('[aria-hidden="true"]')!;
        const title = element.querySelector("span.truncate")!;
        return title.getBoundingClientRect().left - dot.getBoundingClientRect().right;
      });
      const referenceSpacing = await page
        .getByText("Reasoning details not exposed", { exact: true })
        .evaluate(
          (label) =>
            label.getBoundingClientRect().left -
            label.previousElementSibling!.getBoundingClientRect().right,
        );
      expect(spacing).toBe(referenceSpacing);
      expect(spacing).toBeGreaterThan(0);
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
