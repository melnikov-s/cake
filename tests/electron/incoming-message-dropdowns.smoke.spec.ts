import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
for (const theme of ["dark", "light"] as const)
  test(`incoming dropdowns share one layout and keep to-dos visible (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-incoming-dropdowns-"));
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
      const reportToggle = report.locator('[data-slot="incoming-body-disclosure"]');
      const sourceToggle = source.locator('[data-slot="response-disclosure"]');
      const batchToggle = batch.locator('[data-slot="response-disclosure"]');
      const skin = await sourceToggle.getAttribute("class");
      for (const toggle of [reportToggle, sourceToggle, batchToggle]) {
        await expect(toggle).toHaveAttribute("class", skin!);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
      }
      for (const card of [report, source, batch]) {
        const association = card.getByRole("group", { name: "Linked to-dos" });
        await expect(association).toBeVisible();
        expect(
          await association.evaluate(
            (node) => node.closest('[data-slot="message-disclosure"]') === null,
          ),
        ).toBe(true);
      }
      // Keyboard expansion and the exact lazy source retain real Markdown/code rendering.
      await sourceToggle.focus();
      await sourceToggle.press("Enter");
      await expect(source.getByRole("heading", { name: "Build fixed" })).toBeVisible();
      await expect(source.locator('[data-streamdown="code-block-body"]')).toContainText(
        "const ready = true;",
      );
      await sourceToggle.press("Enter");
      await expect(
        source.getByRole("checkbox", { name: "Done: Fix the flaky build" }),
      ).toBeVisible();
      await source.getByRole("checkbox", { name: "Done: Fix the flaky build" }).click();
      await expect(
        source.getByRole("checkbox", { name: "Done: Fix the flaky build" }),
      ).toHaveAttribute("aria-checked", "true");
      await batchToggle.click();
      await expect(batch.getByText(/Draft ready for review/)).toBeVisible();
      await batchToggle.click();
      await expect(
        batch.getByRole("checkbox", { name: "Done: Draft the release notes" }),
      ).toBeVisible();
      await reportToggle.click();
      const assignment = report.getByRole("button", { name: "Assignment details" });
      await expect(assignment).toHaveAttribute("class", skin!);
      await reportToggle.click();
      await expect(
        report.getByRole("checkbox", { name: "Done: Research the publication check" }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
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
