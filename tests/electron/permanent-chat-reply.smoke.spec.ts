import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, UserEntry, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-durable-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["dark", "light"] as const)
  test(`permanent chat replies preserve drafts, focus the new line and send readable references (${theme})`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-permanent-chat-reply-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk({ role: "assistant", content: "Reply received." }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await findVisualCaptureScenario("assistant-markdown-code")!.seed(paths, theme);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      await writeFile(
        join(paths.cakeHome, "pi", "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              apiKey: "fixture",
              models: [
                {
                  id: "fixture",
                  name: "Fixture",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 200_000,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
      );
      const applicationPath = join(paths.cakeHome, "state", "application.json");
      const state = JSON.parse(await readFile(applicationPath, "utf8"));
      const presetId = "00000000-0000-4000-8000-000000000001";
      state.data.modelPresets = [
        {
          id: presetId,
          name: "Fixture",
          provider: "fixture",
          modelId: "fixture",
          thinkingLevel: "off",
          fastMode: false,
        },
      ];
      state.data.defaultModelPresetId = presetId;
      await writeFile(applicationPath, JSON.stringify(state));

      const hash = createHash("sha256").update(paths.project).digest("hex");
      const entryIds = new Map<string, string>();
      for (const [surface, directory] of [
        ["Cake Chat", join(paths.cakeHome, "pi", "global-chat")],
        ["Project Chat", join(paths.cakeHome, "pi", "project-chats", hash)],
      ]) {
        await mkdir(directory!, { recursive: true });
        const storage = await openNodeSqliteStorage(join(directory!, "coordinator.sqlite"));
        const harness = await Harness.open(
          storage,
          { models: createModels(), registry: createRegistry() },
          BACKGROUND_CONTEXT,
        );
        try {
          const conversation = await harness.root(BACKGROUND_CONTEXT);
          await conversation.commit(async (tx) => {
            await tx.appendEntry(UserEntry, conversation.id, {
              model: [{ role: "user", content: "Original question", timestamp: 1 }],
            });
            const entry = await tx.appendEntry(AssistantEntry, conversation.id, {
              model: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: `Earlier ${surface} answer` }],
                  timestamp: 2,
                  api: "anthropic-messages",
                  provider: "anthropic",
                  model: "fixture",
                  stopReason: "stop",
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                },
              ],
            });
            entryIds.set(surface!, String(entry.id));
            for (let index = 0; index < 10; index++) {
              await tx.appendEntry(UserEntry, conversation.id, {
                model: [{ role: "user", content: `Later question ${index}`, timestamp: 3 + index }],
              });
              await tx.appendEntry(AssistantEntry, conversation.id, {
                model: [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: `Later answer ${index}. ${"More context. ".repeat(30)}`,
                      },
                    ],
                    timestamp: 3 + index,
                    api: "anthropic-messages",
                    provider: "anthropic",
                    model: "fixture",
                    stopReason: "stop",
                    usage: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 0,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                  },
                ],
              });
            }
          }, BACKGROUND_CONTEXT);
        } finally {
          await harness.close(BACKGROUND_CONTEXT);
          await storage.close(BACKGROUND_CONTEXT);
        }
      }
      app = await electron.launch({
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
      const page = await app.firstWindow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(
        page.getByRole("heading", { name: "Repository-owned visual checks" }),
      ).toBeVisible();
      // The same shared transcript in a regular Project Session must not opt in.
      await expect(
        page.getByRole("button", { name: "Copy response", exact: true }).first(),
      ).toBeAttached();
      await expect(page.getByRole("button", { name: "Reply to message", exact: true })).toHaveCount(
        0,
      );

      for (const surface of ["Cake Chat", "Project Chat"]) {
        if (surface === "Cake Chat")
          await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
        else
          await page
            .getByRole("button", { name: "Open Project Chat for project", exact: true })
            .click();
        const input = page.getByRole("combobox", { name: `Message ${surface}`, exact: true });
        await expect(input).toBeVisible();
        // Initial positioning is at the newest answer, where the ordinary
        // composer already provides the response action.
        const newest = page.locator("[data-part-id]").filter({
          has: page.getByText(/^Later answer 9\./),
        });
        await expect(newest).toBeVisible();
        await expect(
          newest.getByRole("button", { name: "Reply to message", exact: true }),
        ).toHaveCount(0);
        const id = entryIds.get(surface)!;
        const original = page.locator(`[data-part-id="entry-${id}-text-0"] article`).first();
        const reply = original.getByRole("button", { name: "Reply to message", exact: true });
        // Scroll to an old message using the transcript, not the composer.
        const scroller = page.locator(".transcript");
        await expect(async () => {
          await scroller.evaluate((element) => {
            element.scrollTop = 0;
            element.dispatchEvent(new Event("scroll"));
          });
          await expect(reply).toBeAttached();
        }).toPass();
        const question = page.locator("[data-part-id]").filter({
          has: page.getByText("Original question", { exact: true }),
        });
        await expect(question).toBeVisible();
        await question.hover();
        await expect(
          question.getByRole("button", { name: "Reply to message", exact: true }),
        ).toHaveCount(0);
        await original.hover();
        await expect(reply).toBeVisible();
        const copy = original.getByRole("button", { name: "Copy response", exact: true });
        expect(
          await copy.evaluate((button) => button.nextElementSibling?.getAttribute("aria-label")),
        ).toBe("Reply to message");
        const reference = `> replying to message: ${id}\n\n`;
        for (const draft of ["", "Keep my draft", "Keep my draft\n", "Keep my draft\n\n"]) {
          await input.fill(draft);
          await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
          await original.hover();
          await reply.click();
          const expected = draft ? `${draft.replace(/\n*$/, "")}\n\n${reference}` : reference;
          await expect(input).toHaveValue(expected);
          await expect(input).toBeFocused();
          expect(
            await input.evaluate((element: HTMLTextAreaElement) => [
              element.selectionStart,
              element.selectionEnd,
            ]),
          ).toEqual([expected.length, expected.length]);
          await input.pressSequentially("My reply");
          await expect(input).toHaveValue(`${expected}My reply`);
          await expect(
            input
              .locator("xpath=ancestor::form")
              .getByRole("button", { name: "Send", exact: true }),
          ).toBeEnabled();
        }
        // Native keyboard activation also returns focus/caret to a fresh unquoted line.
        await original.hover();
        await reply.focus();
        await reply.press("Enter");
        await expect(input).toBeFocused();
        await input.pressSequentially("Keyboard reply");
        const sent = `Keep my draft\n\n${reference}My reply\n\n${reference}Keyboard reply`;
        await expect(input).toHaveValue(sent);
        await input.press("Enter");
        await expect(input).toHaveValue("");
        await expect
          .poll(() => requests.some((body) => body.includes(JSON.stringify(sent).slice(1, -1))))
          .toBe(true);
        const sentMessage = page
          .locator('[data-slot="message-content"]')
          .filter({ hasText: "Keyboard reply" });
        await expect(sentMessage).toBeVisible();
        await expect(sentMessage.locator("blockquote")).toHaveText([
          `replying to message: ${id}`,
          `replying to message: ${id}`,
        ]);
        await expect(sentMessage.getByText("Keyboard reply", { exact: true })).toBeVisible();
        const received = page.locator("[data-part-id]").filter({
          has: page.getByText("Reply received.", { exact: true }),
        });
        await expect(received).toBeVisible();
        await expect(
          received.getByRole("button", { name: "Reply to message", exact: true }),
        ).toHaveCount(0);
        // Even after the response arrives, the user-authored prompt cannot be replied to.
        await expect(
          sentMessage.locator("xpath=ancestor::article").getByRole("button", {
            name: "Reply to message",
            exact: true,
          }),
        ).toHaveCount(0);
      }
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
