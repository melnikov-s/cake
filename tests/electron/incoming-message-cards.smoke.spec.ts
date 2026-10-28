import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
for (const theme of ["dark", "light"] as const)
  test(`incoming cards share one summary row and keep to-dos visible (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-incoming-cards-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("result-todo-done")!;
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
        BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 1100),
      );
      await scenario.prepare(page, "dropdowns");
      const report = page.getByRole("article", { name: "Subagent complete", exact: true });
      const source = page
        .locator('[data-slot="session-message"]')
        .filter({ has: page.getByRole("checkbox", { name: "Done: Fix the flaky build" }) });
      const batch = page
        .locator('[data-slot="session-message"]')
        .filter({ has: page.getByRole("checkbox", { name: "Done: Draft the release notes" }) });
      const toggle = (card: typeof source) => card.locator('[data-slot="response-disclosure"]');
      const reportToggle = toggle(report);
      const sourceToggle = toggle(source);
      const batchToggle = toggle(batch);
      // Every incoming card is one summary row with one title, not a title plus a dropdown.
      const skin = await sourceToggle.getAttribute("class");
      for (const [card, title] of [
        [report, "Planner workflow update"],
        [source, "Fix the flaky build"],
        [batch, "Draft the release notes"],
      ] as const) {
        await expect(toggle(card)).toHaveCount(1);
        await expect(toggle(card)).toHaveAttribute("class", skin!);
        await expect(toggle(card)).toHaveAttribute("aria-expanded", "false");
        await expect(toggle(card)).toHaveAttribute("aria-label", title);
        const association = card.getByRole("group", { name: "Linked to-dos" });
        await expect(association).toBeVisible();
        expect(await association.evaluate((node) => node.closest("button") === null)).toBe(true);
      }
      // The icon-only Done control names the to-do it resolves.
      const sourceDone = source.getByRole("checkbox", { name: "Done: Fix the flaky build" });
      await sourceDone.hover();
      await expect(page.getByRole("tooltip")).toHaveText("Mark done: Fix the flaky build");
      await page.mouse.move(1, 1);
      // Keyboard expansion and the exact lazy source retain real Markdown/code rendering.
      await sourceToggle.focus();
      await sourceToggle.press("Enter");
      await expect(source.getByRole("heading", { name: "Build fixed" })).toBeVisible();
      await expect(source.locator('[data-streamdown="code-block-body"]')).toContainText(
        "const ready = true;",
      );
      await expect(source.getByText("To-do · Fix the flaky build")).toBeVisible();
      await expect(source.getByRole("link", { name: "Full response", exact: true })).toBeVisible();
      await sourceToggle.press("Enter");
      await expect(sourceDone).toBeVisible();
      await sourceDone.click();
      await expect(sourceDone).toHaveAttribute("aria-checked", "true");
      await sourceDone.hover();
      await expect(page.getByRole("tooltip")).toHaveText("Reopen: Fix the flaky build");
      await page.mouse.move(1, 1);
      await batchToggle.click();
      await expect(batch.getByText(/Draft ready for review/).last()).toBeVisible();
      await batchToggle.click();
      await expect(
        batch.getByRole("checkbox", { name: "Done: Draft the release notes" }),
      ).toBeVisible();
      await reportToggle.click();
      await expect(report.getByRole("button", { name: "Assignment details" })).toBeVisible();
      await reportToggle.click();
      await expect(
        report.getByRole("checkbox", { name: "Done: Research the publication check" }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      await expect(report).toBeVisible();
      await expect(sourceToggle).toHaveAttribute("aria-expanded", "false");
      await expect(
        source.getByRole("checkbox", { name: "Done: Fix the flaky build" }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(page.locator('[data-slot="result-todo-done"]')).toHaveCount(3);
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
