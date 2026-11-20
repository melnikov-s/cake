import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["dark", "light"] as const)
  test(`adjacent collapsed transcript to-dos stay compact and operable (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-collapsed-tasks-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-adjacent-task-headings")!;
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
      await scenario.prepare(page, "default");
      const transcript = page.locator(".transcript").last();
      const labels = transcript.locator('[data-slot="task-section-label"]');
      const disclosures = transcript.locator('[data-slot="task-section-disclosure"]');
      for (const width of [1280, 1800, 900]) {
        await app.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]?.setContentSize(width, 900),
          width,
        );
        await expect(async () => {
          const first = (await labels.nth(0).boundingBox())!;
          const second = (await labels.nth(1).boundingBox())!;
          // Only a small list gap, not expanded-conversation section padding.
          expect(second.y - first.y - first.height).toBeGreaterThanOrEqual(0);
          expect(second.y - first.y - first.height).toBeLessThanOrEqual(8);
          const followingRow = (await transcript
            .getByText("Thanks. What does ⌘K open?", { exact: true })
            .locator('xpath=ancestor::*[@data-slot="transcript-item"]')
            .boundingBox())!;
          expect(followingRow.y - second.y - second.height).toBeLessThanOrEqual(8);
          for (const label of await labels.all()) {
            const bounds = (await label.boundingBox())!;
            const row = (await label
              .locator('xpath=ancestor::*[@data-slot="task-section-header"]')
              .boundingBox())!;
            expect(row.height - bounds.height).toBeLessThanOrEqual(8);
            for (const button of await label.getByRole("button").all()) {
              const target = (await button.boundingBox())!;
              // The to-do label picker (81947630) is a standard 24px compact icon control.
              if ((await button.getAttribute("aria-label"))?.startsWith("Change label for ")) {
                expect(target).toMatchObject({ width: 24, height: 24 });
                continue;
              }
              // Preserve the existing title target (~27px) and 28px disclosure.
              expect(target.height).toBeGreaterThanOrEqual(27);
              expect(target.width).toBeGreaterThanOrEqual(28);
            }
          }
          expect(
            await transcript.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
        }).toPass();
      }
      // Expansion reveals the conversation and restores its rule; the clicked disclosure keeps
      // focus, so Enter collapses it again from the keyboard.
      const firstDisclosure = disclosures.first();
      const message = transcript.getByText("Normalize the default-branch worktree labels.", {
        exact: true,
      });
      await firstDisclosure.click();
      await expect(firstDisclosure).toHaveAttribute("aria-expanded", "true");
      await expect(message).toBeVisible();
      await expect(transcript.locator('[data-slot="margin-rail"]').first()).toBeVisible();
      await expect(firstDisclosure).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(firstDisclosure).toHaveAttribute("aria-expanded", "false");
      await expect(firstDisclosure).toBeFocused();
      await expect(message).toBeHidden();
      await page.keyboard.press("Enter");
      await expect(firstDisclosure).toHaveAttribute("aria-expanded", "true");
      await expect(message).toBeVisible();
      await firstDisclosure.click();
      await expect(message).toBeHidden();
      await transcript
        .getByRole("button", {
          name: "Show in To-do: Normalize default-branch worktree labels",
          exact: true,
        })
        .click();
      const pane = page.getByRole("complementary", { name: "Workspace" });
      await expect(pane).toBeVisible();
      // Show in To-do reveals the collapsed to-do row without focusing it (to-do redesign).
      const row = pane.getByRole("button", {
        name: "Normalize default-branch worktree labels",
        exact: true,
      });
      await expect(row).toBeInViewport();
      await expect(row).toHaveAttribute("aria-expanded", "false");
      await expect(
        pane.getByRole("button", {
          name: "Focus to-do: Normalize default-branch worktree labels",
          exact: true,
        }),
      ).toHaveAttribute("aria-pressed", "false");
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
