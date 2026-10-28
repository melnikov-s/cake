import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

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
      await expect(source.getByRole("link", { name: "Full response", exact: true })).toBeVisible();
      await sourceToggle.press("Enter");
      const rail = page.getByTitle("Show in To-do: Fix the flaky build").last();
      await rail.click();
      const panel = page.getByRole("complementary", { name: "To-do" });
      await expect(
        panel.getByRole("button", { name: "Fix the flaky build", exact: true }),
      ).toHaveAttribute("aria-pressed", "false");
      await panel.getByRole("button", { name: "Mark done: Fix the flaky build" }).click();
      await page.getByRole("button", { name: "Close To-do" }).click();
      await expect(rail.locator("..").getByText("Done", { exact: true })).toBeVisible();
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
      await expect(rail.locator("..").getByText("Done", { exact: true })).toBeVisible();
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
