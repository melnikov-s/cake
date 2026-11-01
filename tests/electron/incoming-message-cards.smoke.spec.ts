import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { parseVisualCaptureArguments } from "../../scripts/visual-capture/arguments";
import { captureVisual } from "../../scripts/visual-capture/capture";

for (const [scenario, state] of [
  ["incoming-report-recap", "fullscreen"],
  ["session-messages", "default"],
  ["session-messages", "project"],
] as const) {
  test(`${scenario} retains its ${state} visual workflow`, async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "cake-message-scenario-"));
    try {
      await captureVisual(
        parseVisualCaptureArguments([
          scenario,
          "--state",
          state,
          "--output",
          join(outputRoot, "message.png"),
          "--no-build",
        ]),
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
}

const repository = resolve(import.meta.dirname, "../..");
for (const theme of ["dark", "light"] as const)
  test(`incoming cards share one summary row with live task sections (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-incoming-cards-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("incoming-task-sections");
    if (!scenario) throw new Error("Missing incoming task fixture");
    await scenario.seed(paths, theme);
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
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setContentSize(1800, 1100),
      );
      await scenario.prepare(page, "dropdowns");
      const report = page.getByRole("article", { name: "Subagent complete", exact: true });
      const source = page
        .locator('[data-slot="session-message"]')
        .filter({ has: page.getByRole("button", { name: "Fix the flaky build", exact: true }) });
      const batch = page.locator('[data-slot="session-message"]').filter({
        has: page.getByRole("button", { name: "Draft the release notes", exact: true }),
      });
      const toggle = (card: typeof source) => card.locator('[data-slot="response-disclosure"]');
      const sourceToggle = toggle(source);
      const skin = await sourceToggle.getAttribute("class");
      for (const [card, title] of [
        [report, "Planner workflow update"],
        [source, "Fix the flaky build"],
        [batch, "Draft the release notes"],
      ] as const) {
        await expect(toggle(card)).toHaveCount(1);
        await expect(toggle(card)).toHaveAttribute("class", skin ?? "");
        await expect(toggle(card)).toHaveAttribute("aria-expanded", "false");
        await expect(toggle(card)).toHaveAttribute("aria-label", title);
      }
      await sourceToggle.focus();
      await sourceToggle.press("Enter");
      await expect(source.getByRole("heading", { name: "Build fixed" })).toBeVisible();
      await expect(source.locator('[data-streamdown="code-block-body"]')).toContainText(
        "const ready = true;",
      );
      const titleLink = source.getByRole("link", { name: "Fix the flaky build", exact: true });
      await expect(titleLink).toHaveAttribute(
        "href",
        "cake://session/3d4e5f6a-7b8c-4d9e-8f01-2a3b4c5d6e71?message=build-result",
      );
      const actions = source.locator('[data-slot="message-actions"]');
      const copy = actions.getByRole("button", { name: "Copy message", exact: true });
      const fullscreen = source.getByRole("button", { name: /^View message fullscreen:/ });
      await expect(actions.getByRole("button")).toHaveCount(2);
      await expect(
        actions.getByRole("button", { name: "Reply to message", exact: true }),
      ).toBeAttached();
      const geometry = await source.evaluate((element) => {
        const box = (selector: string) =>
          element.querySelector(selector)!.getBoundingClientRect().toJSON();
        return {
          card: box('[data-slot="session-message-card"]'),
          actions: box('[data-slot="message-actions"]'),
          fullscreen: box(".fullscreen-trigger"),
          header: box('[data-slot="response-disclosure"]'),
        };
      });
      expect(geometry.actions.y).toBeGreaterThanOrEqual(geometry.card.bottom);
      expect(Math.abs(geometry.fullscreen.y - geometry.card.y)).toBeLessThan(10);
      expect(Math.abs(geometry.card.right - geometry.fullscreen.right)).toBeLessThan(10);
      expect(geometry.header.right).toBeLessThan(geometry.fullscreen.x);
      await sourceToggle.evaluate((button) => button.blur());
      await page.mouse.move(1, 1);
      await expect(actions).toHaveCSS("opacity", "0");
      await expect(fullscreen).toHaveCSS("opacity", "0");
      await source.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      await expect(fullscreen).toHaveCSS("opacity", "1");
      await page.mouse.move(1, 1);
      await expect(actions).toHaveCSS("opacity", "0");
      await expect(fullscreen).toHaveCSS("opacity", "0");
      await copy.focus();
      await expect(copy).toBeFocused();
      await expect(actions).toHaveCSS("opacity", "1");
      await copy.press("Enter");
      await expect(
        actions.getByRole("button", { name: "Copied message", exact: true }),
      ).toBeVisible();
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
        "const ready = true;",
      );
      await fullscreen.focus();
      await expect(fullscreen).toHaveCSS("opacity", "1");
      await fullscreen.press("Enter");
      const reader = page.getByRole("dialog", { name: "Fix the flaky build", exact: true });
      await expect(reader.getByRole("heading", { name: "Build fixed" })).toBeVisible();
      await reader.getByRole("button", { name: /^Exit fullscreen/ }).press("Escape");
      await expect(reader).toHaveCount(0);
      await expect(fullscreen).toBeFocused();
      await expect(sourceToggle).toHaveAttribute("aria-expanded", "true");
      // Both the arrow and empty header area toggle; title navigation is separate.
      await sourceToggle.click({ position: { x: 12, y: 16 } });
      await expect(sourceToggle).toHaveAttribute("aria-expanded", "false");
      const headerBox = (await sourceToggle.boundingBox())!;
      await sourceToggle.click({ position: { x: headerBox.width - 8, y: 16 } });
      await expect(sourceToggle).toHaveAttribute("aria-expanded", "true");
      await sourceToggle.focus();
      await sourceToggle.press("Tab");
      await expect(titleLink).toBeFocused();
      await sourceToggle.focus();
      await sourceToggle.press("Enter");
      const rail = page.getByTitle("Show in To-do: Fix the flaky build").last();
      const doneStatus = rail.locator("..").getByRole("img", { name: "Done", exact: true });
      await rail.click();
      const panel = page.getByRole("complementary", { name: "To-do" });
      await expect(
        panel.getByRole("button", { name: "Fix the flaky build", exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      await panel.getByRole("button", { name: "Mark done: Fix the flaky build" }).click();
      await page.getByRole("button", { name: "Close To-do" }).click();
      await expect(doneStatus).toBeVisible();
      await toggle(batch).click();
      await expect(batch.getByText(/Draft ready for review/).last()).toBeVisible();
      await toggle(batch).click();
      await toggle(report).click();
      await expect(report.getByRole("button", { name: "Assignment details" })).toBeVisible();
      await toggle(report).click();
      await page.reload();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      await expect(report).toBeVisible();
      await expect(sourceToggle).toHaveAttribute("aria-expanded", "false");
      await expect(doneStatus).toBeVisible();
      const titleLinkAfterReload = source.getByRole("link", {
        name: "Fix the flaky build",
        exact: true,
      });
      await titleLinkAfterReload.focus();
      await titleLinkAfterReload.press("Enter");
      await expect(page.getByRole("heading", { name: "Build fixed" })).toBeVisible();
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
