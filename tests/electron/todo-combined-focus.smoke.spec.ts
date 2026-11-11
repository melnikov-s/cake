import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { TaskAttributionDoc } from "../../src/services/pi-durable/durable-task-attribution";
import { durableAnswer } from "../fixtures/durable-chat";

const repository = resolve(import.meta.dirname, "../..");
const title = "Investigate slow project startup and repeated configuration reads";
const todoId = "00000000-0000-4000-8000-000000000011";
const original = [
  "Investigate slow project startup.",
  "I’ll trace project loading and compare the slow steps.",
  "Check repeated config reads too.",
  "I’m comparing the trace without changing code.",
  "Back to startup—compare a cold launch too.",
  "I’ll add a cold-launch comparison to the same investigation.",
];

for (const mode of ["project", "global", "history"] as const) {
  test(`combines every repeated to-do section without folding (${mode})`, async ({}, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "cake-combined-focus-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const theme = mode === "global" ? "light" : "dark";
    await findVisualCaptureScenario("project-chat-task-rails")!.seed(paths, theme);
    const hash = createHash("sha256").update(paths.project).digest("hex");
    const directory = join(paths.cakeHome, "pi", "project-chats", hash);
    if (mode === "global") {
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      application.data.cakeChatTodos = application.data.projects[0].todos;
      await writeFile(file, JSON.stringify(application));
      await cp(directory, join(paths.cakeHome, "pi", "global-chat"), { recursive: true });
    }
    if (mode === "history") {
      const storage = await openNodeSqliteStorage(join(directory, "coordinator.sqlite"));
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      try {
        const chat = await harness.root(BACKGROUND_CONTEXT);
        await chat.commit(async (tx) => {
          const append = async (text: string, task: string | null, answer?: string) => {
            const message = await tx.appendEntry(UserEntry, chat.id, {
              model: [{ role: "user", content: text, timestamp: 1 }],
            });
            (await tx.doc(TaskAttributionDoc, chat.id)).inputs[String(message.id)] = {
              pending: false,
              todoId: task,
            };
            if (answer)
              await tx.appendEntry(AssistantEntry, chat.id, { model: [durableAnswer(answer)] });
          };
          for (let i = 0; i < 410; i += 1) {
            await append(`Unrelated history ${i}`, "00000000-0000-4000-8000-000000000012");
            if (i === 199) await append("Middle task update", todoId, "Middle task answer");
          }
          await append("Latest task update", todoId, "Latest task answer");
        }, BACKGROUND_CONTEXT);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
        await storage.close(BACKGROUND_CONTEXT);
      }
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
      await page.setViewportSize({ width: 1400, height: 1800 });
      if (mode === "global")
        await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      else
        await page
          .getByRole("button", { name: /^Open Project Chat for / })
          .first()
          .click();
      await expect(
        page.getByRole("combobox", {
          name: mode === "global" ? "Message Cake Chat" : "Message Project Chat",
        }),
      ).toBeVisible();
      const pane = page.locator('[data-slot="session-pane"]');
      const transcript = pane.locator(".transcript").last();
      const originalDisclosure = async () => {
        const row = transcript
          .getByText(original[0]!, { exact: true })
          .locator('xpath=ancestor::*[@data-slot="transcript-item"]');
        await expect(row).toBeVisible();
        const index = await row.getAttribute("data-transcript-item-index");
        // Virtual rows mount independently; DOM .first() need not be chronological.
        return transcript
          .locator(`[data-slot="task-section-header"][data-transcript-item-index="${index}"]`)
          .getByRole("button", { name: title, exact: true });
      };
      if (mode !== "history") {
        await transcript.evaluate((element) => {
          element.scrollTop = 0;
        });
        const disclosure = await originalDisclosure();
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await expect(transcript.getByText(original[0]!, { exact: true })).toHaveCount(0);
      }
      await transcript
        .getByRole("button", { name: `Focus to-do: ${title}`, exact: true })
        .last()
        .click();
      await expect(pane.getByRole("button", { name: "Clear to-do focus" })).toBeVisible();
      if (mode === "history") {
        const more = transcript.getByRole("button", { name: "Show more", exact: true });
        await expect(transcript.getByText("Latest task answer", { exact: true })).toBeVisible();
        await expect(transcript.getByText(original[0]!, { exact: true })).toHaveCount(0);
        await more.click();
        await expect(transcript.getByText("Middle task answer", { exact: true })).toBeVisible();
        await expect(transcript.getByText(original[0]!, { exact: true })).toHaveCount(0);
        await more.click();
        await expect(more).toHaveCount(0);
      }
      await transcript.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(transcript.locator('[data-slot="task-section-label"]')).toHaveCount(1);
      await expect(transcript.locator('[data-slot="task-section-disclosure"]')).toHaveCount(0);
      await expect(
        transcript.getByRole("button", { name: `Focus to-do: ${title}`, exact: true }),
      ).toHaveCount(0);
      await expect(transcript.getByText("The command menu.", { exact: true })).toHaveCount(0);
      await expect(
        transcript.getByText("Separately, improve project navigation.", { exact: true }),
      ).toHaveCount(0);
      await expect(transcript.getByText(/^Unrelated history /)).toHaveCount(0);
      const expected =
        mode === "history"
          ? [
              ...original,
              "Middle task update",
              "Middle task answer",
              "Latest task update",
              "Latest task answer",
            ]
          : original;
      for (const text of expected)
        await expect(transcript.getByText(text, { exact: true })).toHaveCount(1);
      const messages = await transcript
        .locator('[data-slot="transcript-item"]')
        .evaluateAll((rows) =>
          rows
            .sort(
              (a, b) =>
                Number(a.getAttribute("data-transcript-item-index")) -
                Number(b.getAttribute("data-transcript-item-index")),
            )
            .map((row) => row.querySelector('[data-slot="message-content"]')?.textContent),
        );
      expect(messages).toHaveLength(expected.length);
      for (const [index, text] of expected.entries()) expect(messages[index]).toContain(text);
      await page.mouse.move(1, 1);
      await pane.screenshot({ path: testInfo.outputPath(`combined-focus-${mode}-${theme}.png`) });
      await pane.getByRole("button", { name: "Clear to-do focus" }).click();
      await transcript.evaluate((element) => {
        element.scrollTop = 0;
      });
      const disclosure = await originalDisclosure();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(transcript.getByText(original[0]!, { exact: true })).toHaveCount(0);
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
