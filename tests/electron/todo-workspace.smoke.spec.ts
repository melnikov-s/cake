import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";

const repository = resolve(import.meta.dirname, "../..");

for (const mode of ["Browser Mode", "VS Code"] as const) {
  test(`${mode} shows chat instead of the active to-do pane and preserves selection`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-workspace-"));
    const project = join(directory, "project");
    const cakeHome = join(directory, "cake");
    const title = "Review the browser layout";
    const id = "00000000-0000-4000-8000-000000000011";
    const statePath = join(cakeHome, "state", "application.json");
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await mkdir(project);
      await mkdir(join(cakeHome, "state"), { recursive: true });
      await mkdir(join(directory, "home"));
      const timestamp = "2026-01-01T00:00:00.000Z";
      await writeFile(
        statePath,
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
                browserDefaultUrl: "http://127.0.0.1:9/",
                todos: {
                  ...emptyProjectTodos(),
                  items: [
                    {
                      id,
                      title,
                      description: "Keep this item selected while viewing the workspace.",
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
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await page
        .locator('[data-slot="project-header"] [data-slot="project-label"]')
        .first()
        .click();
      await page.getByRole("button", { name: "To-do", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "To-do", exact: true });
      const selected = panel.getByRole("button", { name: title, exact: true });
      await selected.click();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      const readTodos = async () =>
        JSON.parse(await readFile(statePath, "utf8")).data.projects[0].todos;
      await expect.poll(async () => (await readTodos()).selectedId).toBe(id);
      await page.getByRole("button", { name: `Open ${mode}`, exact: true }).click();
      await expect(
        page.getByRole("region", {
          name: mode === "VS Code" ? "VS Code workspace" : "Browser workspace",
          exact: true,
        }),
      ).toBeVisible();
      await expect(panel).toHaveCount(0);
      const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.pressSequentially("Continue reviewing");
      await expect(composer).toHaveValue("Continue reviewing");
      await expect(composer).toBeFocused();
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Back to agent", exact: true }).first().click();
      await expect(panel).toBeVisible();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      expect(await readTodos()).toMatchObject({
        selectedId: id,
        items: [{ id, state: "open", revision: 0 }],
      });
      // Opening a workspace without an accessory still shows the normal chat.
      await page.getByRole("button", { name: "Close To-do", exact: true }).click();
      await page.getByRole("button", { name: `Open ${mode}`, exact: true }).click();
      await expect(composer).toBeVisible();
      await expect(composer).toHaveValue("Continue reviewing");
      if (mode === "Browser Mode") {
        await page.getByRole("button", { name: "Close chat", exact: true }).click();
        await expect(composer).toBeHidden();
        await page.getByRole("button", { name: "Open chat", exact: true }).click();
        await expect(composer).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Browser address" })).toBeVisible();
      }
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
