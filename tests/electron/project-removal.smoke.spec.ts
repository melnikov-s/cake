import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { seedCakeChatHistory, seedPermanentChatHistory } from "./durable-chat-fixture";

const repository = resolve(import.meta.dirname, "../..");

test("Remove only releases the active Project Chat dialog and leaves Cake interactive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-project-removal-"));
  const cakeHome = join(directory, "cake");
  const project = join(directory, "project");
  const hash = createHash("sha256").update(project).digest("hex");
  const projectHistory = join(cakeHome, "pi", "project-chats", hash);
  const applicationPath = join(cakeHome, "state", "application.json");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(project, { recursive: true });
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await seedPermanentChatHistory(projectHistory, "PRESERVED_PROJECT_HISTORY");
    await seedCakeChatHistory(cakeHome, "GLOBAL_HISTORY");
    await writeFile(
      applicationPath,
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: project,
              name: "Removal fixture",
              addedAt: new Date(0).toISOString(),
              lastOpenedAt: new Date(0).toISOString(),
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
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
    await expect(page.getByText("GLOBAL_HISTORY", { exact: true })).toBeVisible();
    const projectButton = page.getByRole("button", {
      name: "Open Project Chat for Removal fixture",
      exact: true,
    });
    await projectButton.click();
    await expect(page.getByText("PRESERVED_PROJECT_HISTORY", { exact: true })).toBeVisible();
    // Select the real native menu action without showing an OS popup.
    await app.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (template) => {
        const menu = build(template);
        const remove = menu.items.find((item) => item.label === "Remove Project…");
        if (remove) {
          Menu.buildFromTemplate = build;
          menu.popup = (options) => {
            remove.click(remove, options!.window!, { triggeredByAccelerator: false });
            options?.callback?.();
          };
        }
        return menu;
      };
    });
    await projectButton.click({ button: "right" });
    const dialog = page.getByRole("alertdialog", { name: "Remove Removal fixture?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove only", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(projectButton).toHaveCount(0);
    await expect(page.getByText("GLOBAL_HISTORY", { exact: true })).toBeVisible();
    const input = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("Still interactive after removal");
    await expect(input).toHaveValue("Still interactive after removal");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect((await stat(join(projectHistory, "coordinator.sqlite"))).size).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(applicationPath, "utf8")).data.projects).toEqual([]);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
