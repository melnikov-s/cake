import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const titleB = "Improve project navigation";
const pixels =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

for (const global of [false, true]) {
  test(`transcript images fold with their task and remain keyboard expandable (${global ? "Cake Chat, light" : "Project Chat, dark"})`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "cake-image-disclosure-"));
    const paths = {
      cakeHome: join(temporary, "cake"),
      project: join(temporary, "project"),
      userData: join(temporary, "user-data"),
    };
    await findVisualCaptureScenario("project-chat-task-rails")!.seed(
      paths,
      global ? "light" : "dark",
    );
    const hash = createHash("sha256").update(paths.project).digest("hex");
    const directory = join(paths.cakeHome, "pi", "project-chats", hash);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const storage = await openNodeSqliteStorage(join(directory, "coordinator.sqlite"));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit(async (tx) => {
        for (const [index, todoId] of [
          "00000000-0000-4000-8000-000000000011",
          "00000000-0000-4000-8000-000000000012",
          null,
        ].entries()) {
          const entry = await tx.appendEntry(UserEntry, root.id, {
            model: [
              {
                role: "user",
                timestamp: index,
                content: [
                  { type: "text", text: `Screenshot turn ${index}` },
                  { type: "image", mimeType: "image/png", data: pixels },
                ],
              },
            ],
          });
          (await tx.doc(TaskAttributionDoc, root.id)).inputs[String(entry.id)] = {
            pending: false,
            todoId,
          };
        }
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
    // The global surface uses the same to-do identities and history fixture.
    if (global) {
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      application.data.cakeChatTodos = application.data.projects[0].todos;
      await writeFile(file, JSON.stringify(application));
      await cp(directory, join(paths.cakeHome, "pi", "global-chat"), { recursive: true });
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
      await page.setViewportSize({ width: 1400, height: 2200 });
      if (global) await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      else
        await page
          .getByRole("button", { name: /^Open Project Chat for / })
          .first()
          .click();
      const transcript = page.locator('[data-slot="session-pane"] .transcript').last();
      await expect(transcript.locator("figure img")).toHaveCount(3);
      const key = await transcript
        .locator("figure")
        .first()
        .locator('xpath=ancestor::*[@data-slot="transcript-item"]')
        .getAttribute("data-transcript-item-key");
      const shot = transcript.locator(`[data-transcript-item-key='${key}'] figure`);
      const collapse = shot.getByRole("button", { name: /^Collapse image:/ });
      await expect(collapse).toHaveAttribute("aria-expanded", "true");
      const bodyId = await collapse.getAttribute("aria-controls");
      await collapse.focus();
      await collapse.press("Enter");
      const expand = shot.getByRole("button", { name: /^Expand image:/ });
      await expect(expand).toBeFocused();
      await expect(page.locator(`[id='${bodyId}']`)).toBeHidden();
      expect((await shot.boundingBox())!.height).toBeLessThan(40);
      await expand.press("Space");
      await expect(shot.getByRole("img")).toBeVisible();
      await collapse.press("Enter");

      await transcript
        .getByRole("button", { name: `Show in To-do: ${titleB}`, exact: true })
        .click();
      const panel = page.getByRole("complementary", { name: "To-do" });
      const selectB = panel.getByRole("button", { name: titleB, exact: true });
      await selectB.click();
      await expect(shot).toHaveCount(0);
      // The non-focused task disappears; the focused task and unattributed turn stay visible.
      await expect(transcript.locator("figure img")).toHaveCount(2);
      await transcript.getByRole("button", { name: titleA, exact: true }).press("Enter");
      await expect(expand).toBeVisible();
      await expect(expand).toHaveAttribute("aria-expanded", "false");
      await expand.press("Space");
      await expect(shot.getByRole("img")).toBeVisible();
      await expect(selectB).toHaveAttribute("aria-pressed", "true");
      await transcript.getByRole("button", { name: titleA, exact: true }).press("Space");
      await expect(shot).toHaveCount(0);
      await page.getByRole("button", { name: "Clear to-do focus" }).click();
      await expect(shot.getByRole("img")).toBeVisible();
      await expect(transcript.locator("figure img")).toHaveCount(3);

      // Focus never folds the unsent composer attachment or blocks real typing.
      const composer = page.getByRole("combobox", {
        name: global ? "Message Cake Chat" : "Message Project Chat",
      });
      await composer.evaluate((element, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "draft.png", {
            type: "image/png",
          }),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
        );
      }, pixels);
      await selectB.click();
      await expect(page.getByRole("button", { name: "View draft.png enlarged" })).toBeVisible();
      await composer.click();
      await composer.pressSequentially("Keep this screenshot unsent.");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Keep this screenshot unsent.");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    } finally {
      await app.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
