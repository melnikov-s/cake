import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import type { Annotation } from "../../src/contracts/conversations/session-contract";

const repository = resolve(import.meta.dirname, "../..");
const reply = [
  "Wait until the migration finishes.",
  "",
  "```ts",
  "interface SideChatPreferences {",
  "  provider: string;",
  "}",
  "```",
].join("\n");

for (const parent of ["Cake Chat", "Project Chat"] as const) {
  test(`${parent} side chats annotate their own prose and code without nesting chats`, async () => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-side-chat-annotations-"));
    const project = join(directory, "project");
    const cakeHome = join(directory, "cake");
    const userData = join(directory, "user-data");
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk({ role: "assistant", content: reply }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await Promise.all([
        mkdir(project),
        mkdir(join(cakeHome, "state"), { recursive: true }),
        mkdir(join(cakeHome, "pi"), { recursive: true }),
        mkdir(userData),
        mkdir(join(directory, "home")),
      ]);
      await writeFile(
        join(cakeHome, "pi", "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "fixture",
              api: "openai-completions",
              models: [{ id: "fixture", name: "Fixture", contextWindow: 200_000, maxTokens: 1024 }],
            },
          },
        }),
      );
      const presetId = "00000000-0000-4000-8000-000000000001";
      const timestamp = new Date(0).toISOString();
      await writeFile(
        join(cakeHome, "state", "application.json"),
        JSON.stringify({
          version: 7,
          data: {
            ...defaultApplicationState(),
            projects: [
              { path: project, name: "Project", addedAt: timestamp, lastOpenedAt: timestamp },
            ],
            modelPresets: [
              {
                id: presetId,
                name: "Fixture",
                provider: "fixture",
                modelId: "fixture",
                thinkingLevel: "off",
                fastMode: false,
              },
            ],
            defaultModelPresetId: presetId,
          },
        }),
      );
      const launch = () =>
        electron.launch({
          args: [repository],
          cwd: repository,
          env: {
            ...process.env,
            HOME: join(directory, "home"),
            CAKE_ELECTRON_SMOKE: "1",
            CAKE_HOME: cakeHome,
            CAKE_ELECTRON_USER_DATA: userData,
            PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
            PI_CODING_AGENT_SESSION_DIR: "",
          },
        });
      app = await launch();
      let page = await app.firstWindow();
      await page.setViewportSize({ width: 1400, height: 900 });
      if (parent === "Cake Chat") {
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      } else {
        const projectId = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
        await page
          .locator(
            `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
          )
          .click();
      }
      const parentInput = page.getByRole("combobox", { name: `Message ${parent}`, exact: true });
      await parentInput.click();
      await expect(parentInput).toBeFocused();
      await parentInput.pressSequentially("Explain the settings");
      await expect(parentInput).toHaveValue("Explain the settings");
      await parentInput.press("Enter");
      await expect(
        page.getByText("Wait until the migration finishes.", { exact: true }),
      ).toBeVisible();

      // Keep the real native menu construction, replacing only its OS popup.
      await app.evaluate(({ Menu }) => {
        const build = Menu.buildFromTemplate.bind(Menu);
        let calls = 0;
        Menu.buildFromTemplate = (template) => {
          const menu = build(template);
          menu.popup = (options) => {
            const selectionActions = menu.items
              .map((item) => item.label)
              .filter((label) => label === "Add annotation" || label === "Chat about this");
            const expected =
              calls === 0 ? ["Add annotation", "Chat about this"] : ["Add annotation"];
            if (JSON.stringify(selectionActions) !== JSON.stringify(expected))
              throw new Error(`Wrong selection actions: ${JSON.stringify(selectionActions)}`);
            const label = calls++ === 0 ? "Chat about this" : "Add annotation";
            const item = menu.items.find((item) => item.label === label)!;
            item.click(item, options.window!, { triggeredByAccelerator: false });
            options.callback?.();
          };
          return menu;
        };
      });
      const selectWord = async (content: ReturnType<typeof page.locator>, word: string) => {
        await content.scrollIntoViewIfNeeded();
        const target = await content.evaluate((element, word) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const start = node.textContent?.indexOf(word) ?? -1;
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + word.length);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
          throw new Error(`Missing selection text: ${word}`);
        }, word);
        await page.mouse.dblclick(target.x, target.y);
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
          .toBe(word);
        await page.mouse.click(target.x, target.y, { button: "right" });
      };
      await selectWord(
        page.getByText("Wait until the migration finishes.", { exact: true }),
        "migration",
      );
      let side = page.getByRole("complementary", { name: "Side chat" });
      const input = side.getByRole("combobox");
      await expect(input).toBeFocused();
      await input.pressSequentially("Explain this in the side chat");
      await expect(input).toHaveValue("Explain this in the side chat");
      await expect(side.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.press("Enter");
      await expect(
        side.getByText("Wait until the migration finishes.", { exact: true }),
      ).toBeVisible();
      const code = side.locator('[data-streamdown="code-block-body"] code');
      await expect(code).toContainText("SideChatPreferences");
      await expect.poll(() => code.locator("span span").count()).toBeGreaterThan(0);
      const messageId = await code.evaluate(
        (element) => element.closest<HTMLElement>("[data-part-id]")!.dataset.partId!,
      );
      const messageText = await code.evaluate(
        (element) => element.closest('[data-slot="message-content"]')!.textContent!,
      );
      for (const [content, word, comment] of [
        [
          side.getByText("Wait until the migration finishes.", { exact: true }),
          "migration",
          "Check the migration",
        ],
        [code, "SideChatPreferences", "Check the interface"],
      ] as const) {
        await selectWord(content, word);
        const annotationInput = page.getByRole("textbox", { name: "Annotation comment" });
        await expect(annotationInput).toBeFocused();
        await annotationInput.pressSequentially(comment);
        await expect(annotationInput).toHaveValue(comment);
        await expect(
          page
            .getByRole("dialog", { name: "Add annotation" })
            .getByRole("button", { name: "Add annotation" }),
        ).toBeEnabled();
        await annotationInput.press("Enter");
        await expect(page.getByRole("dialog", { name: "Add annotation" })).toHaveCount(0);
      }
      await expect(side.getByRole("button", { name: "View 2 annotations" })).toBeVisible();
      // Only the side-chat composer owns the draft, even with the parent visible.
      await expect(page.getByRole("button", { name: "View 2 annotations" })).toHaveCount(1);
      await expect(parentInput).toHaveValue("");
      await side.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => requests.length).toBe(3);
      const messages = JSON.parse(requests[2]!).messages as {
        content: string | { text?: string }[];
      }[];
      const context = messages
        .map(({ content }) =>
          typeof content === "string"
            ? content
            : content.map((block) => block.text ?? "").join("\n"),
        )
        .join("\n");
      const encoded = /<cake-annotations>(.*?)<\/cake-annotations>/s.exec(context)?.[1];
      expect(encoded).toBeDefined();
      const annotations = (JSON.parse(encoded!) as { annotations: Annotation[] }).annotations;
      expect(annotations).toEqual([
        expect.objectContaining({
          messageId,
          selectedText: "migration",
          comment: "Check the migration",
          entryId: expect.any(String),
          startOffset: messageText.indexOf("migration"),
          endOffset: messageText.indexOf("migration") + "migration".length,
        }),
        expect.objectContaining({
          messageId,
          selectedText: "SideChatPreferences",
          comment: "Check the interface",
          entryId: expect.any(String),
          startOffset: messageText.indexOf("SideChatPreferences"),
          endOffset: messageText.indexOf("SideChatPreferences") + "SideChatPreferences".length,
        }),
      ]);
      // Reload the persisted sidecar, not the optimistic sent annotation summary.
      await expect(side.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await page.getByRole("button", { name: "Side chats, 1 open" }).click();
      await page
        .getByRole("dialog", { name: "Open side chats" })
        .getByRole("button")
        .filter({ hasText: "migration" })
        .click();
      side = page.getByRole("complementary", { name: "Side chat" });
      await side.getByRole("button", { name: "View 2 annotations" }).click();
      await expect(page.getByText("Check the migration", { exact: true })).toBeVisible();
      await expect(page.getByText("Check the interface", { exact: true })).toBeVisible();
    } finally {
      await app?.close();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
}
