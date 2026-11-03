import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

test("action-first attention: keyboard reason editor, dismiss/restore, snooze, completion and durable reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-todo-attention-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake");
  const file = join(cakeHome, "state", "application.json");
  const id = "00000000-0000-4000-8000-000000000011";
  const title = "Startup investigation";
  const reason = "Review the startup findings";
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(project);
    await mkdir(join(directory, "home"));
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 10,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Project",
              addedAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-01T00:00:00.000Z",
              todos: {
                ...emptyProjectTodos(),
                items: [
                  {
                    id,
                    title,
                    description: "Findings are ready for review.",
                    status: "",
                    state: "open",
                    needsAttention: true,
                    attentionReason: reason,
                    revision: 0,
                    associations: [
                      {
                        kind: "source",
                        ref: "https://example.com/findings",
                        title: "Startup findings",
                      },
                    ],
                  },
                  {
                    id: "00000000-0000-4000-8000-000000000012",
                    title: "Choose navigation",
                    description: "Compare layouts.",
                    status: "",
                    state: "open",
                    revision: 0,
                    associations: [],
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        HOME: join(directory, "home"),
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 900 });
    const open = async () => {
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await page
        .getByRole("button", { name: "Open Project Chat for project", exact: true })
        .click();
      const input = page.getByRole("combobox", { name: "Message Project Chat" });
      await expect(input).toBeVisible();
      const toggle = page.getByRole("button", { name: "To-do", exact: true });
      if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    };
    await open();
    const panel = page.getByRole("complementary", { name: "To-do", exact: true });
    const row = panel.locator(`[data-todo-id="${id}"]`);
    const action = row.getByRole("button", { name: title, exact: true });
    const category = (name: string) =>
      panel.getByRole("list", { name: `${name} to-dos`, exact: true });
    const editor = async (label: string, target = action) => {
      await target.focus();
      await target.press("Shift+F10");
      await expect(page.getByRole("menuitem", { name: /^(Snooze|Change snooze)$/ })).toBeFocused();
      const menuitem = page.getByRole("menuitem", { name: label, exact: true });
      await menuitem.focus();
      await menuitem.press("ArrowRight");
      const dialog = page.getByRole("dialog", { name: label, exact: true });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    await expect(category("Needs attention").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await expect(action).toHaveText(reason);
    await expect(row.getByRole("link", { name: "Startup findings", exact: true })).toBeVisible();
    await action.click();
    await expect(action).toHaveAttribute("aria-pressed", "true");
    await row.getByRole("button", { name: `Dismiss attention: ${title}` }).click();
    await expect(category("Focus").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await expect(action).toHaveText(title);
    await expect(action).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("region", { name: "Needs attention", exact: true })).toHaveCount(
      0,
    );
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Restore needs attention", exact: true }).click();
    await expect(action).toHaveText(reason);
    const dialog = await editor("Edit attention reason…");
    const input = dialog.getByRole("textbox", { name: "What needs your attention?" });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(reason);
    await input.fill("");
    await input.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("Enter what needs your attention.");
    await input.pressSequentially("Review the change before merging");
    await expect(input).toHaveValue("Review the change before merging");
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(action).toHaveText("Review the change before merging");
    // Editing and dismissing never send the existing Project Chat draft.
    const composer = page.getByRole("combobox", { name: "Message Project Chat" });
    await composer.fill("Discuss these findings");
    await row.getByRole("button", { name: `Dismiss attention: ${title}` }).click();
    await expect(composer).toHaveValue("Discuss these findings");
    await expect(category("Focus").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await expect(action).toHaveText(title);
    // Restore reuses the retained reason without a model. Reload persistence is checked below.
    await action.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Restore needs attention", exact: true }).click();
    await expect(action).toHaveText("Review the change before merging");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
    await page.getByRole("menuitem", { name: "1 day", exact: true }).click();
    await expect(category("Focus").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await row.getByRole("button", { name: `Unfocus to-do: ${title}` }).click();
    await expect(category("Snoozed").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await expect(action).toHaveText(title);
    const snoozedDeadline = await row.locator("time").getAttribute("datetime");
    const snoozedDialog = await editor("Edit attention reason…");
    const snoozedInput = snoozedDialog.getByRole("textbox", { name: "What needs your attention?" });
    await snoozedInput.fill("Approve the revised scope");
    await snoozedInput.press("Enter");
    await expect(row.locator("time")).toHaveAttribute("datetime", snoozedDeadline!);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unsnooze", exact: true }).click();
    await expect(category("Needs attention").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await expect(action).toHaveText("Approve the revised scope");
    await row.getByRole("button", { name: `Mark done: ${title}` }).click();
    await panel.getByRole("button", { name: "Done (1)" }).click();
    await expect(category("Done").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await row.getByRole("button", { name: `Reopen: ${title}` }).click();
    await expect(category("Active").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    // No retained reason: small native menu content input with Add/Cancel.
    const other = panel.getByRole("button", { name: "Choose navigation", exact: true });
    const cancelled = await editor("Mark needs attention…", other);
    await cancelled
      .getByRole("textbox", { name: "What needs your attention?" })
      .pressSequentially("Discard this draft");
    await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(cancelled).toBeHidden();
    const manual = await editor("Mark needs attention…", other);
    const manualInput = manual.getByRole("textbox", { name: "What needs your attention?" });
    await expect(manualInput).toBeFocused();
    await expect(manualInput).toHaveValue("");
    await manualInput.pressSequentially("Choose sidebar or tabs");
    await expect(manualInput).toHaveValue("Choose sidebar or tabs");
    await expect(manual.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
    await manualInput.press("Enter");
    await expect(
      category("Needs attention").getByRole("button", { name: "Choose navigation", exact: true }),
    ).toHaveText("Choose sidebar or tabs");
    await expect
      .poll(async () => {
        const saved = JSON.parse(await readFile(file, "utf8"));
        return saved.data.projects[0].todos.items[1].attentionReason;
      })
      .toBe("Choose sidebar or tabs");
    await page.reload();
    await open();
    await expect(
      category("Needs attention").getByRole("button", { name: "Choose navigation", exact: true }),
    ).toHaveText("Choose sidebar or tabs");
    await expect(category("Active").locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
