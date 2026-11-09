import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { createSessionOutcomesScenario } from "../../scripts/visual-capture/session-outcomes";

const repository = resolve(import.meta.dirname, "../..");
for (const theme of ["light", "dark"] as const) {
  test(`session outcomes keep success quiet and failures visible (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-outcomes-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = createSessionOutcomesScenario();
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
        BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 1000),
      );
      await scenario.prepare(page, "default");
      const batch = page.getByRole("status", { name: "Session results" });
      const rows = batch.locator('[data-slot="session-system-update"]');
      await expect(rows).toHaveCount(4);
      const report = batch.locator('[data-slot="session-message"]');
      await expect(report).toHaveCount(1);
      await expect(report.locator('[data-slot="response-header"] a')).toHaveCount(0);
      const reportToggle = report.getByRole("button", {
        name: "Worker findings stay readable",
        exact: true,
      });
      await reportToggle.focus();
      await reportToggle.press("Enter");
      await expect(report.getByRole("heading", { name: "Original findings" })).toBeVisible();
      await expect(report.getByRole("link", { name: "Open source" })).toHaveAttribute(
        "href",
        "cake://session/success-source?message=report",
      );
      await expect(batch.getByText("Merged and resolved", { exact: true })).toHaveCount(1);
      await expect(batch.getByText("Merged · resolution failed", { exact: true })).toBeVisible();
      await expect(batch.getByText("Merge blocked", { exact: true })).toBeVisible();
      await expect(batch.getByText(/Stop the child before resolving/)).toBeVisible();
      await expect(batch.getByText(/Resolve the conflict in the worktree/)).toBeVisible();
      await expect(batch).not.toContainText("merged=true");
      await expect(batch).not.toContainText("acb3bb91264b");
      await expect(batch.getByRole("link", { name: "Open session" })).toHaveCount(4);
      const details = rows.first().getByRole("button", { name: "System details" });
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await details.focus();
      await details.press("Enter");
      await expect(details).toHaveAttribute("aria-expanded", "true");
      const raw = page.locator(`[id="${await details.getAttribute("aria-controls")}"]`);
      await expect(raw).toContainText("merged=true; resolutionSucceeded=true");
      // Exact context is inert text, not another inline session-link badge.
      await expect(raw.getByRole("link")).toHaveCount(0);
      await details.press("Enter");
      await expect(raw).toHaveCount(0);
      await expect(details).toBeFocused();
      for (const width of [600, 1100]) {
        await app.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]?.setContentSize(width, 1000),
          width,
        );
        await expect
          .poll(() =>
            rows.evaluateAll((elements) =>
              elements.every((el) => el.scrollWidth <= el.clientWidth),
            ),
          )
          .toBe(true);
      }
      await mkdir(join(repository, ".visual-captures"), { recursive: true });
      await batch.screenshot({
        path: join(repository, `.visual-captures/outcomes-after-${theme}.png`),
      });
      await details.press("Enter");
      await batch.screenshot({
        path: join(repository, `.visual-captures/outcomes-details-${theme}.png`),
      });
      await details.press("Enter");
      await reportToggle.press("Enter");
      await report.getByRole("link", { name: "Open source" }).press("Enter");
      await expect(page.getByRole("heading", { name: "Original findings" })).toBeVisible();
      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).first().click();
      await rows.nth(1).getByRole("link", { name: "Open session" }).press("Enter");
      await expect(page.locator('[data-slot="workspace-title"] [aria-current="page"]')).toHaveText(
        "Successful report source",
      );
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
}
