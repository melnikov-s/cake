import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import {
  defaultApplicationState,
  defaultProjectWorkflow,
} from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

test("label picker never completes or selects the row, and right actions remain independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-todo-labels-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake");
  const title = "Bug: investigate startup";
  const customLabel = "Renamed regression";
  const localId = "10000000-0000-4000-8000-000000000001";
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
              workflow: {
                ...defaultProjectWorkflow(),
                labels: [{ id: localId, name: customLabel, color: "pink" }],
              },
              todos: {
                ...emptyProjectTodos(),
                items: [
                  {
                    id: "00000000-0000-4000-8000-000000000011",
                    title,
                    description: "Check cold startup.",
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
    await page.setViewportSize({ width: 1200, height: 850 });
    const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
    const openTodos = async () => {
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
      if (!(await workspace.isVisible()))
        await page.locator('[data-slot="shell-workspace-toggle"]').click();
      const tab = workspace.getByRole("button", { name: /^To-dos / });
      if (!(await workspace.getByRole("searchbox", { name: "Search to-dos" }).isVisible()))
        await tab.click();
    };
    await openTodos();
    const row = workspace.getByRole("button", { name: title, exact: true }).locator("..");
    const label = (name: string) =>
      row.getByRole("button", {
        name: `Change label for ${title}. Current label: ${name}`,
        exact: true,
      });
    const done = row.getByRole("button", { name: `Mark done: ${title}`, exact: true });
    await expect(done).toHaveCSS("opacity", "0");
    // Shift+Tab reaches row controls without invoking Cake's plain-Tab composer shortcut.
    await row.getByRole("button", { name: `Attach to-do as context: ${title}` }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(done).toBeFocused();
    await expect(done).toHaveCSS("opacity", "1");
    await page.keyboard.press("Shift+Tab");
    await expect(label("Unlabelled")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu", { name: "Choose label" })).toBeVisible();
    await page.getByRole("menuitemradio", { name: customLabel, exact: true }).click();
    await expect(label(customLabel)).toBeFocused();
    await expect(row.getByRole("button", { name: title, exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(done).toHaveCount(1);
    await page.mouse.move(1, 1);
    await label(customLabel).hover();
    await expect(page.getByRole("tooltip", { name: customLabel, exact: true })).toBeVisible();
    await expect(label(customLabel).locator("[data-session-label-color]")).toHaveCount(1);

    // Reload returns to Cake Chat. The aggregate still uses the Project's label catalog.
    await page.reload();
    await label(customLabel).click();
    await page.getByRole("menuitemradio", { name: "Feature", exact: true }).click();
    await expect(label("Feature")).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await label("Feature").click();
    await page.getByRole("menuitem", { name: "Clear label" }).click();
    await expect(label("Unlabelled")).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(label("Unlabelled")).toBeVisible();

    await done.press("Enter");
    await workspace.getByRole("button", { name: "Done (1)", exact: true }).click();
    await row.getByRole("button", { name: `Reopen: ${title}`, exact: true }).press("Enter");
    await expect(done).toBeVisible();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
