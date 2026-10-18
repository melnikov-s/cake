import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-durable-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { createMessageOperations } from "../../src/domain/conversations/cake-message-operations";
import { CakeOperationRegistry } from "../../src/services/pi/runtime/cake-operation-registry";
import { readMessageReference } from "../../src/services/pi/runtime/message-references";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { formatSessionDigestReminder } from "../../src/contracts/cake-chats/session-digest-reminder";

const repository = resolve(import.meta.dirname, "../..");
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

for (const theme of ["dark", "light"] as const)
  test(`Project and global Chat retain exact full responses after reload (${theme})`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-message-presentation-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await findVisualCaptureScenario("assistant-markdown-code")!.seed(paths, theme);
      const source = SessionManager.create(
        paths.project,
        cakeWorkspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
      );
      source.appendSessionInfo("Detailed delegated review");
      source.appendMessage({ role: "user", content: "Review the subsystem", timestamp: 1 });
      const entryId = source.appendMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "## Original detailed findings\n\n**Substance stays in Pi.**\n\n```ts\nconst evidence = 'original';\n```\n\n" +
              "Detailed review. ".repeat(1400) +
              "\n\nLast original finding.",
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        stopReason: "stop",
        timestamp: 2,
        usage,
      });
      const metadata = readMessageReference(source, { entryId }).message;
      const sourceFile = source.getSessionFile()!;
      const originalFile = await readFile(sourceFile, "utf8");
      const operations = new CakeOperationRegistry(
        createMessageOperations({
          read: async () => readMessageReference(source, { entryId, maxChars: 1 }),
          list: async () => null,
          open: async () => {
            throw new Error("No navigation");
          },
        }),
      );
      const result = await operations.invoke(
        { command: "messages.present", input: { ref: metadata.ref } },
        {
          runtime: { sessionId: CAKE_CHAT_SESSION_ID },
          signal: new AbortController().signal,
          toolCallId: "present",
        },
      );
      const hash = createHash("sha256").update(paths.project).digest("hex");
      const projectId = `project-chat:${hash}`;
      for (const sessionId of [CAKE_CHAT_SESSION_ID, projectId]) {
        const directory =
          sessionId === CAKE_CHAT_SESSION_ID
            ? join(paths.cakeHome, "pi", "global-chat")
            : join(paths.cakeHome, "pi", "project-chats", hash);
        await mkdir(directory, { recursive: true });
        const storage = await openNodeSqliteStorage(join(directory, "coordinator.sqlite"));
        const harness = await Harness.open(
          storage,
          { models: createModels(), registry: createRegistry() },
          BACKGROUND_CONTEXT,
        );
        try {
          const conversation = await harness.root(BACKGROUND_CONTEXT);
          await conversation.commit(async (tx) => {
            await tx.appendEntry(ToolResultEntry, conversation.id, {
              model: [
                {
                  role: "toolResult",
                  toolName: "cake",
                  toolCallId: "present",
                  content: result.content,
                  details: result.details,
                  isError: false,
                  timestamp: 2,
                },
              ],
            });
            await tx.appendEntry(UserEntry, conversation.id, {
              model: [
                {
                  role: "user",
                  content: `${formatSessionDigestReminder({
                    lines: [
                      {
                        reference: "worker",
                        sessionId: source.getSessionId(),
                        title: "Detailed delegated review",
                        summary: "Review ready",
                        status: "completed",
                        resultMessageRef: metadata.ref,
                      },
                    ],
                    running: 0,
                    interruptedReport: false,
                  })}\n\nDiscuss the summary here`,
                  timestamp: 3,
                },
              ],
            });
            // This historical successful presentation now points at an unavailable original.
            await tx.appendEntry(ToolResultEntry, conversation.id, {
              model: [
                {
                  role: "toolResult",
                  toolName: "cake",
                  toolCallId: "missing",
                  content: [],
                  details: {
                    command: "messages.present",
                    result: {
                      ...metadata,
                      sessionId: "deleted-producer",
                      ref: "cake://session/deleted-producer?message=deleted-entry",
                      link: "cake://session/deleted-producer?message=deleted-entry",
                      entryId: "deleted-entry",
                    },
                  },
                  isError: false,
                  timestamp: 4,
                },
              ],
            });
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
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1100),
      );
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      const verify = async (inputName: string) => {
        const surfaces = page.locator('[data-slot="message-source"]');
        await expect(surfaces).toHaveCount(3);
        const first = page.locator('[data-part-id="tool-present"] [data-slot="message-source"]');
        const notification = page
          .locator('[data-part-id]:not([data-part-id="tool-present"]) [data-slot="message-source"]')
          .filter({
            has: page.getByRole("button", {
              name: "Full agent response Detailed delegated review",
              exact: true,
            }),
          });
        const missing = page.locator(
          '[data-message-reference="cake://session/deleted-producer?message=deleted-entry"]',
        );
        await expect(first.getByRole("button", { name: /Full agent response/ })).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await first.getByRole("button", { name: /Full agent response/ }).click();
        await expect(
          first.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeVisible();
        await expect(first.locator('[data-streamdown="code-block-body"]')).toContainText(
          "const evidence",
        );
        await expect(first).toHaveAttribute("data-message-reference", metadata.ref);
        await first.getByRole("button", { name: "Next", exact: true }).click();
        await expect(first.getByText(/Last original finding/)).toBeVisible();
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
        // Notification-mode source is available without any model-authored relay.
        await first.getByRole("button", { name: /Full agent response/ }).click();
        await notification.getByRole("button", { name: /Full agent response/ }).click();
        await expect(
          notification.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeVisible();
        await notification.getByRole("button", { name: /Full agent response/ }).click();
        await missing.getByRole("button", { name: /Full agent response/ }).click();
        await expect(missing.getByText("Original response unavailable")).toBeVisible();
        await expect(missing.getByRole("button", { name: "Retry source" })).toBeVisible();
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
      };
      await verify("Message Cake Chat");
      await page.reload();
      await verify("Message Cake Chat");
      await page
        .locator(
          `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
        )
        .click();
      await verify("Message Project Chat");
      await page.reload();
      await verify("Message Project Chat");
      expect(await readFile(sourceFile, "utf8")).toBe(originalFile);
      await page.getByRole("combobox", { name: "Message Project Chat" }).click();
      await page.keyboard.type("Follow-up stays here");
      await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toHaveValue(
        "Follow-up stays here",
      );
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await mkdir(join(repository, ".visual-captures"), { recursive: true });
      const shown = page.locator('[data-part-id="tool-present"] [data-slot="message-source"]');
      await shown.getByRole("button", { name: /Full agent response/ }).click();
      await shown.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(
        shown.getByRole("heading", { name: "Original detailed findings" }),
      ).toBeVisible();
      await shown.getByRole("button", { name: /Full agent response/ }).click();
      await page.screenshot({
        path: join(repository, ".visual-captures", `inline-full-agent-response-${theme}.png`),
      });
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
