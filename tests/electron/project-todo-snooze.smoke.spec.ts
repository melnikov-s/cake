import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { localSnoozeDateTime } from "../../src/renderer/lib/project-todo-snooze";

const repository = resolve(import.meta.dirname, "../..");

test("to-do context submenu, custom local deadline, renderer reload, rescheduling and early unsnooze", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-todo-snooze-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake");
  const title = "Review the release";
  const id = "00000000-0000-4000-8000-000000000011";
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(project);
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await mkdir(join(directory, "home"));
    const timestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 9,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Project",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
              todos: {
                ...emptyProjectTodos(),
                items: [
                  {
                    id,
                    title,
                    description: "Check packaging and first launch.",
                    status: "",
                    state: "open",
                    revision: 0,
                    associations: [
                      {
                        kind: "source",
                        ref: "https://example.com/release",
                        title: "Release details",
                      },
                    ],
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
    const toggle = page.getByRole("button", { name: "To-do", exact: true });
    const openProjectTodos = async () => {
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await page
        .getByRole("button", { name: "Open Project Chat for project", exact: true })
        .click();
      await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
      if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    };
    await openProjectTodos();
    const panel = page.getByRole("complementary", { name: "To-do", exact: true });
    const row = panel.locator(`[data-todo-id="${id}"]`);
    const action = row.getByRole("button", { name: title, exact: true });
    const openCustom = async (change = false) => {
      await row.click({ button: "right" });
      await page
        .getByRole("menuitem", { name: change ? "Change snooze" : "Snooze", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Custom…", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: change ? "Change snooze" : "Snooze to-do",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    await action.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Snooze", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await action.click();
    await expect(action).toHaveAttribute("aria-pressed", "true");
    const dialog = await openCustom();
    const input = dialog.getByLabel(/^Until \(/);
    await expect(input).toBeFocused();
    await input.fill("2000-01-01T10:00");
    await expect(input).toHaveValue("2000-01-01T10:00");
    await dialog.getByRole("button", { name: "Snooze", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose a future date and time.");
    const future = localSnoozeDateTime(new Date(Date.now() + 2 * 86400_000).toISOString());
    await input.fill(future);
    await expect(input).toHaveValue(future);
    await dialog.getByRole("button", { name: "Snooze", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      panel.getByRole("list", { name: "Snoozed to-dos" }).locator(`[data-todo-id="${id}"]`),
    ).toHaveCount(1);
    await expect(panel.getByRole("list", { name: "Active to-dos" })).toHaveCount(0);
    await expect(action).toHaveAttribute("aria-pressed", "false");
    await expect(action).toHaveAttribute("aria-disabled", "true");
    await expect(row.locator("time")).toHaveAttribute("datetime", new Date(future).toISOString());
    await expect(row.getByRole("link", { name: "Release details" })).toBeVisible();
    await expect(toggle).toHaveText("0");
    // Deadlines belong to the backend, not the pane or renderer's lifetime.
    await page.reload();
    await openProjectTodos();
    await expect(row.locator("time")).toHaveAttribute("datetime", new Date(future).toISOString());
    await expect(panel.locator(`[data-todo-id="${id}"]`)).toHaveCount(1);
    await expect(toggle).toHaveText("0");
    const changing = await openCustom(true);
    await expect(changing.getByLabel(/^Until \(/)).toHaveValue(future);
    const later = localSnoozeDateTime(new Date(Date.now() + 3 * 86400_000).toISOString());
    await changing.getByLabel(/^Until \(/).fill(later);
    await changing.getByRole("button", { name: "Save", exact: true }).click();
    await expect(changing).toBeHidden();
    await expect(row.locator("time")).toHaveAttribute("datetime", new Date(later).toISOString());
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unsnooze", exact: true }).click();
    await expect(
      panel.getByRole("list", { name: "Active to-dos" }).locator(`[data-todo-id="${id}"]`),
    ).toHaveCount(1);
    await expect(toggle).toHaveText("1");
    await expect(action).toHaveAttribute("aria-disabled", "false");
    // Keyboard context actions and submenu navigation use the same preset mutation.
    await action.focus();
    await action.press("Shift+F10");
    const snooze = page.getByRole("menuitem", { name: "Snooze", exact: true });
    await expect(snooze).toBeFocused();
    await snooze.press("ArrowRight");
    await snooze.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "15 minutes", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row.locator("time")).toHaveCount(1);
    await row.getByRole("button", { name: `Mark done: ${title}` }).click();
    await panel.getByRole("button", { name: "Done (1)" }).click();
    await expect(
      panel.getByRole("list", { name: "Done to-dos" }).locator(`[data-todo-id="${id}"]`),
    ).toHaveCount(1);
    await action.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Snooze", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: `Reopen: ${title}` }).click();
    await expect(
      panel.getByRole("list", { name: "Active to-dos" }).locator(`[data-todo-id="${id}"]`),
    ).toHaveCount(1);
    await expect(row.locator("time")).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
