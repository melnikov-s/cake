import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
const titleA = "Investigate slow project startup and repeated configuration reads";
const titleB = "Improve project navigation";

for (const global of [false, true])
  test(`to-do disclosures, independent focus and reply context (${global ? "Cake Chat" : "Project Chat"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-todo-focus-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-task-rails")!;
    await scenario.seed(paths, "dark");
    if (global) {
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      application.data.cakeChatTodos = application.data.projects[0].todos;
      await writeFile(file, JSON.stringify(application));
      const hash = createHash("sha256").update(paths.project).digest("hex");
      await cp(
        join(paths.cakeHome, "pi", "project-chats", hash),
        join(paths.cakeHome, "pi", "global-chat"),
        { recursive: true },
      );
    }
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
      if (global) {
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
        await expect(page.getByRole("combobox", { name: "Message Cake Chat" })).toBeVisible();
      } else await scenario.prepare(page, "wide");
      await page.setViewportSize({ width: 1800, height: 3000 });
      const pane = page.locator('[data-slot="session-pane"]');
      const transcript = pane.locator(".transcript").last();
      const panel = page.getByRole("complementary", { name: "To-do" });
      const firstLabel = transcript.locator('[data-slot="task-section-label"]').first();
      const title = firstLabel.getByText(titleA, { exact: true });
      const toggle = firstLabel.getByRole("button", { name: titleA, exact: true });
      // The actual title, not a trailing icon, reveals the existing pane without folding.
      await title.click();
      await expect(panel).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(panel.getByRole("button", { name: titleA, exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      const navigation = firstLabel.getByRole("button", {
        name: `Show in To-do: ${titleA}`,
        exact: true,
      });
      await expect(navigation).toHaveText(titleA);
      expect(await firstLabel.locator("button button, button a, a button").count()).toBe(0);
      const chevron = toggle.locator("svg");
      await expect(chevron).not.toHaveClass(/-rotate-90/);
      // Blank space belongs to the sibling disclosure, not the title's hit area.
      const labelBounds = (await firstLabel.boundingBox())!;
      const titleBounds = (await navigation.boundingBox())!;
      const toggleBounds = (await toggle.boundingBox())!;
      const iconBounds = (await chevron.boundingBox())!;
      const focusBounds = (await firstLabel
        .getByRole("button", { name: `Focus to-do: ${titleA}`, exact: true })
        .boundingBox())!;
      expect(focusBounds.x).toBeGreaterThanOrEqual(titleBounds.x + titleBounds.width);
      expect(toggleBounds.x - focusBounds.x - focusBounds.width).toBeLessThanOrEqual(8);
      expect(toggleBounds.x + toggleBounds.width).toBeCloseTo(labelBounds.x + labelBounds.width, 0);
      expect(iconBounds.x + iconBounds.width).toBeGreaterThan(
        labelBounds.x + labelBounds.width - 12,
      );
      expect(toggleBounds.width).toBeGreaterThan(40);
      await toggle.click({ position: { x: 8, y: toggleBounds.height / 2 } });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(chevron).toHaveClass(/-rotate-90/);
      await expect(
        transcript.getByText("Investigate slow project startup.", { exact: true }),
      ).toHaveCount(0);
      // Navigation is independent even while folded and with the pane closed.
      await pane.getByRole("button", { name: "To-do", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await navigation.press("Enter");
      await expect(panel).toBeVisible();
      // The old pane-close restoration must not steal focus from keyboard navigation.
      await expect(navigation).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await navigation.press("Space");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await chevron.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(chevron).not.toHaveClass(/-rotate-90/);
      const selectA = panel.getByRole("button", { name: titleA, exact: true });
      const selectB = panel.getByRole("button", { name: titleB, exact: true });
      const headingsA = transcript.getByRole("button", { name: titleA, exact: true });
      const headingB = transcript.getByRole("button", { name: titleB, exact: true });
      const bar = pane.locator('[data-slot="selection-bar"]');
      const clear = bar.getByRole("button", { name: "Clear to-do focus" });
      await expect(bar).toHaveCount(0);
      await selectA.click();
      await expect(selectA).toHaveAttribute("aria-pressed", "true");
      await expect(bar).toContainText(`Focused to-do:${titleA}`);
      await expect(headingsA).toHaveCount(2);
      await expect(headingsA.nth(0)).toHaveAttribute("aria-expanded", "true");
      await expect(headingsA.nth(1)).toHaveAttribute("aria-expanded", "true");
      await expect(headingB).toHaveCount(0);
      const casual = transcript.getByText("Thanks. What does ⌘K open?", { exact: true });
      await expect(casual).toHaveCount(0);
      await expect(transcript.getByText("The command menu.", { exact: true })).toHaveCount(0);
      await expect(
        transcript.getByText("I’ll trace project loading and compare the slow steps.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        transcript.getByText("Investigate slow project startup.", { exact: true }),
      ).toBeVisible();
      // Headings are native keyboard disclosures; folding one repeat leaves the other alone.
      await headingsA.nth(1).press("Enter");
      await expect(headingsA.nth(1)).toHaveAttribute("aria-expanded", "false");
      await expect(headingsA.nth(0)).toHaveAttribute("aria-expanded", "true");
      await expect(headingB).toHaveCount(0);
      await selectB.click();
      // A different row switches focus; clicking it again clears like the header.
      await expect(selectA).toHaveAttribute("aria-pressed", "false");
      await expect(headingsA).toHaveCount(0);
      await expect(headingB).toHaveAttribute("aria-expanded", "true");
      await selectB.click();
      await expect(selectB).toHaveAttribute("aria-pressed", "false");
      await expect(bar).toHaveCount(0);
      await expect(headingsA.nth(0)).toHaveAttribute("aria-expanded", "true");
      await expect(headingsA.nth(1)).toHaveAttribute("aria-expanded", "true");
      await expect(headingB).toHaveAttribute("aria-expanded", "true");
      await selectA.click();
      await clear.press("Enter");
      await expect(selectA).toHaveAttribute("aria-pressed", "false");
      await expect(bar).toHaveCount(0);
      await expect(headingB).toHaveAttribute("aria-expanded", "true");
      // Clear has no replacement/send/wake, and the draft remains editable.
      const composer = page.getByRole("combobox", {
        name: global ? "Message Cake Chat" : "Message Project Chat",
      });
      await composer.click();
      await composer.pressSequentially("Keep this unsent draft.");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveText("Keep this unsent draft.");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await selectA.click();
      const attachB = panel.getByRole("button", {
        name: `Attach to-do as context: ${titleB}`,
        exact: true,
      });
      await attachB.hover();
      await expect(
        page.getByRole("tooltip", { name: `Attach to-do as context: ${titleB}` }),
      ).toBeVisible();
      await expect(selectA).toHaveAttribute("aria-pressed", "true");
      await attachB.click();
      await expect(selectA).toHaveAttribute("aria-pressed", "true");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep this unsent draft.");
      await composer.pressSequentially(" With context.");
      await expect(composer).toHaveValue("Keep this unsent draft. With context.");
      const removeContext = pane.getByRole("button", {
        name: `Remove To-do · ${titleB}`,
        exact: true,
      });
      await expect(removeContext).toBeVisible();
      // Both native keyboard activation keys attach context, never select or complete the row.
      for (const key of ["Enter", "Space"]) {
        await removeContext.click();
        await attachB.focus();
        await attachB.press(key);
        await expect(removeContext).toBeVisible();
        await expect(selectA).toHaveAttribute("aria-pressed", "true");
        await expect(selectB).toHaveAttribute("aria-pressed", "false");
        await expect(
          panel.getByRole("button", { name: `Mark done: ${titleB}`, exact: true }),
        ).toBeVisible();
        await expect(composer).toBeFocused();
        await expect(composer).toHaveValue("Keep this unsent draft. With context.");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      }
      for (const width of [1800, 900, 600, 1800]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect(clear).toBeVisible();
        await expect(async () => {
          const header = (await page.locator('[data-slot="workspace-header"]').boundingBox())!;
          const bounds = (await bar.boundingBox())!;
          const x = (await clear.boundingBox())!;
          expect(Math.abs(bounds.y - header.y - header.height)).toBeLessThanOrEqual(1);
          expect(x.x + x.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect(await pane.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
        }).toPass();
      }
      await transcript.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(casual).toHaveCount(0);
      await clear.click();
      await expect(bar).toHaveCount(0);
      await transcript.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(casual).toBeVisible();
      await expect(removeContext).toBeVisible();
      await expect(headingB).toHaveAttribute("aria-expanded", "true");
      // Lifecycle changes preserve local view focus and the attached snapshot.
      await selectA.click();
      await panel.getByRole("button", { name: `Mark done: ${titleA}`, exact: true }).click();
      await expect(
        panel.getByRole("button", { name: `Reopen: ${titleA}`, exact: true }),
      ).toBeVisible();
      await expect(selectA).toHaveAttribute("aria-pressed", "true");
      await expect(bar).toBeVisible();
      await expect(selectB).toHaveAttribute("aria-pressed", "false");
      await selectB.click();
      await expect(bar).toBeVisible();
      await panel
        .locator('[data-todo-id="00000000-0000-4000-8000-000000000012"]')
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
      await page.getByRole("menuitem", { name: "1 day", exact: true }).click();
      await expect(bar).toBeVisible();
      await expect(selectB).toHaveAttribute("aria-pressed", "true");
      await clear.click();
      await expect(bar).toHaveCount(0);
      await expect(selectB).toHaveAttribute("aria-pressed", "false");
      await expect(removeContext).toBeVisible();
      await removeContext.click();
      await expect(composer).toHaveValue("Keep this unsent draft. With context.");
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
