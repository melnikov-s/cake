import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { TaskAttributionDoc } from "../../src/services/pi-durable/durable-task-attribution";

const repository = resolve(import.meta.dirname, "../..");
const titleA = "Investigate slow project startup and repeated configuration reads";
const todoA = "00000000-0000-4000-8000-000000000011";
const latest = "Latest task A update";

for (const entry of ["pane", "message"] as const) {
  test(`explicit ${entry} task focus reveals the latest virtualized message`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-todo-navigation-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-task-rails")!;
    const theme = entry === "pane" ? "dark" : "light";
    await scenario.seed(paths, theme);
    const hash = createHash("sha256").update(paths.project).digest("hex");
    const storage = await openNodeSqliteStorage(
      join(paths.cakeHome, "pi", "project-chats", hash, "coordinator.sqlite"),
    );
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const chat = await harness.root(BACKGROUND_CONTEXT);
      await chat.commit(async (tx) => {
        for (const [text, todoId] of [
          [
            Array.from({ length: 100 }, (_, i) => `Earlier unrelated paragraph ${i}.`).join("\n\n"),
            null,
          ],
          [latest, todoA],
          [
            Array.from({ length: 100 }, (_, i) => `Later unrelated paragraph ${i}.`).join("\n\n"),
            null,
          ],
        ] as const) {
          const message = await tx.appendEntry(UserEntry, chat.id, {
            model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
          });
          (await tx.doc(TaskAttributionDoc, chat.id)).inputs[String(message.id)] = {
            pending: false,
            todoId,
          };
        }
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
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
      await scenario.prepare(page, "wide");
      await page.setViewportSize({ width: 1400, height: 700 });
      const pane = page.locator('[data-slot="session-pane"]');
      const transcript = pane.locator(".transcript").last();
      const target = transcript.getByText(latest, { exact: true });
      const panel = page.getByRole("complementary", { name: "To-do" });
      if (entry === "pane") {
        await pane.getByRole("button", { name: "To-do", exact: true }).click();
        await expect(panel).toBeVisible();
      } else {
        await transcript.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expect(
          transcript.getByRole("button", { name: `Focus to-do: ${titleA}`, exact: true }).first(),
        ).toBeVisible();
      }
      // This is a genuine virtualized reveal, not scrollIntoView on a mounted node.
      await expect(target).toHaveCount(0);
      if (entry === "pane") await panel.getByRole("button", { name: titleA, exact: true }).click();
      else
        await transcript
          .getByRole("button", { name: `Focus to-do: ${titleA}`, exact: true })
          .first()
          .click();
      await expect(target).toBeVisible();
      await expect(
        target.locator('xpath=ancestor::*[@data-slot="transcript-item"]'),
      ).toHaveAttribute("aria-current", "true");
      await expect(panel.getByRole("button", { name: titleA, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const toolbar = pane.getByRole("button", { name: "To-do", exact: true });
      const focusedRow = panel.locator(`[data-todo-id="${todoA}"] [data-view-focused="true"]`);
      await expect(focusedRow).toHaveCount(1);
      await expect(toolbar).toHaveAttribute("data-view-focused", "true");
      const ring = await focusedRow.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(ring).toContain("2px");
      const badge = toolbar.locator("span.font-mono");
      await expect(badge).toHaveText(/\d+/);
      // Closing the accessory keeps filtering active and moves the same recognizable
      // cue to the complete toolbar button, not just its icon or number.
      await toolbar.click();
      await expect(panel).toHaveCount(0);
      await expect(toolbar).toHaveAttribute("aria-pressed", "false");
      await expect(toolbar).toHaveAttribute("data-view-focused", "true");
      await expect(toolbar).toHaveCSS("box-shadow", ring);
      await expect(pane.getByRole("button", { name: "Clear to-do focus" })).toBeVisible();
      await toolbar.click();
      await expect(focusedRow).toHaveCount(1);
      const nestedActions = [
        `Attach to-do as context: ${titleA}`,
        `Mark done: ${titleA}`,
        `Unfocus to-do: ${titleA}`,
      ];
      for (const name of nestedActions) {
        const action = panel.getByRole("button", { name, exact: true });
        await action.hover();
        await expect(page.getByRole("tooltip")).toHaveCount(1);
        await expect(page.getByRole("tooltip", { name, exact: true })).toBeVisible();
        // Native title tooltips aren't exposed as role=tooltip. Inspect inheritance
        // as well as the custom tooltip so the original double-tooltip cannot hide.
        expect(await action.evaluate((element) => element.closest("[title]"))).toBeNull();
      }
      await page.keyboard.press("Tab");
      for (const name of nestedActions) {
        const action = panel.getByRole("button", { name, exact: true });
        await action.focus();
        await expect(action).toBeFocused();
        await expect(page.getByRole("tooltip")).toHaveCount(1);
        await expect(page.getByRole("tooltip", { name, exact: true })).toBeVisible();
      }
      await pane.getByRole("button", { name: "Clear to-do focus" }).click();
      await expect(toolbar).not.toHaveAttribute("data-view-focused");
      await expect(focusedRow).toHaveCount(0);
      // Focusing and typing in the composer is not task navigation or a send.
      const composer = page.getByRole("combobox", { name: "Message Project Chat" });
      const top = await transcript.evaluate((element) => element.scrollTop);
      await composer.click();
      await composer.pressSequentially("Keep reading here");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep reading here");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollTop))
        .toBeCloseTo(top, 0);
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
