import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-durable-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { _electron as electron, expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { readMessageReference } from "../../src/services/pi/runtime/message-references";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { formatSessionDigestReminder } from "../../src/contracts/cake-chats/session-digest-reminder";
import { durableInputText } from "../../src/services/pi-durable/durable-input-presentation";
import { researchOrigin } from "../fixtures/subagent-report";

const repository = resolve(import.meta.dirname, "../..");
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

for (const [delivery, theme] of [
  ["assistant", "dark"],
  ["assistant", "light"],
  ["subagent", "dark"],
  ["subagent", "light"],
] as const)
  test(`Project and global Chat automatically present ${delivery} links after reload (${theme})`, async () => {
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
      // The producer is not the viewer's active project/workspace.
      const producer = join(root, "producer-workspace");
      await mkdir(join(producer, ".visual-captures"), { recursive: true });
      const applicationPath = join(paths.cakeHome, "state", "application.json");
      const state = JSON.parse(await readFile(applicationPath, "utf8"));
      state.projects.push({ ...state.projects[0], path: producer, name: "Producer" });
      state.trustedProjectPaths.push(producer);
      await writeFile(applicationPath, JSON.stringify(state));
      const pixels =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const screenshot = join(producer, ".visual-captures", "report.png");
      await writeFile(screenshot, Buffer.from(pixels, "base64"));
      const source = SessionManager.create(
        producer,
        cakeWorkspaceSessionDirectory(producer, join(paths.cakeHome, "pi", "sessions")),
      );
      const imageId = randomUUID();
      const vault = join(paths.cakeHome, "state", "task-inputs", "inputs");
      await mkdir(join(vault, imageId), { recursive: true });
      const reference = {
        kind: "input",
        id: imageId,
        name: "Attached report.png",
        mimeType: "image/png",
        byteLength: Buffer.from(pixels, "base64").length,
      };
      await writeFile(
        join(vault, `${imageId}.json`),
        JSON.stringify({ ownerSessionId: source.getSessionId(), reference }),
      );
      await writeFile(
        join(vault, imageId, "payload.json"),
        JSON.stringify({
          kind: "image",
          name: reference.name,
          mimeType: "image/png",
          data: pixels,
          inputReference: reference,
        }),
      );
      source.appendSessionInfo("Detailed delegated review");
      source.appendMessage({ role: "user", content: "Review the subsystem", timestamp: 1 });
      const originalText =
        "## Original detailed findings\n\n**Substance stays in Pi.**\n\n```ts\nconst evidence = 'original';\n```\n\n" +
        `![Relative screenshot](.visual-captures/report.png)\n\n![Absolute screenshot](${screenshot})\n\n![Attachment pixels](cake://session/${source.getSessionId()}?attachment=${imageId})\n\n![Missing screenshot](missing.png)\n\n` +
        "Detailed review. ".repeat(1400) +
        "\n\nLast original finding.";
      const entryId = source.appendMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: originalText,
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
      const hash = createHash("sha256").update(paths.project).digest("hex");
      const projectId = `project-chat:${hash}`;
      const firstPartIds = new Map<string, string>();
      const notificationPartIds = new Map<string, string>();
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
            const links = `[Review findings](${metadata.ref}) and [same original](${metadata.ref}).\n\n[Producer session](cake://session/${source.getSessionId()})`;
            if (delivery === "assistant") {
              const entry = await tx.appendEntry(AssistantEntry, conversation.id, {
                model: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: links }],
                    api: "anthropic-messages",
                    provider: "anthropic",
                    model: "fixture",
                    stopReason: "stop",
                    timestamp: 2,
                    usage,
                  },
                ],
              });
              firstPartIds.set(sessionId, `entry-${entry.id}-text-0`);
            } else {
              const entry = await tx.appendEntry(UserEntry, conversation.id, {
                model: [
                  {
                    role: "user",
                    content: durableInputText(
                      `Background subagent complete: ${researchOrigin.task}\n\n${links}`,
                      [],
                      true,
                      false,
                      researchOrigin,
                    ),
                    timestamp: 2,
                  },
                ],
              });
              firstPartIds.set(sessionId, `entry-${entry.id}-text`);
            }
            const notificationEntry = await tx.appendEntry(UserEntry, conversation.id, {
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
            notificationPartIds.set(sessionId, `entry-${notificationEntry.id}-context-0`);
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
      await page.emulateMedia({ reducedMotion: "reduce" });
      // Keep native clipboard contents untouched while exercising the actual UI.
      const stubClipboard = () =>
        page.evaluate(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                Reflect.set(window, "copiedMessage", text);
              },
            },
          });
        });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1100),
      );
      // Finish the seeded Project Session's startup selection before navigating away.
      await expect(
        page.getByRole("heading", { name: "Repository-owned visual checks" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      const verify = async (inputName: string, sessionId: string) => {
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
        await stubClipboard();
        const surfaces = page.locator('[data-slot="message-source"]');
        await expect(surfaces).toHaveCount(3);
        const first = page.locator(
          `[data-part-id="${firstPartIds.get(sessionId)}"] [data-slot="message-source"]`,
        );
        const notification = page.locator(
          `[data-part-id="${notificationPartIds.get(sessionId)}"] [data-slot="message-source"]`,
        );
        const missing = page.locator(
          '[data-message-reference="cake://session/deleted-producer?message=deleted-entry"]',
        );
        await expect(
          first.getByRole("button", { name: /(?:Expand|Collapse) response/ }),
        ).toHaveAttribute("aria-expanded", "false");
        await first.getByRole("button", { name: /(?:Expand|Collapse) response/ }).click();
        await expect(
          first.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeVisible();
        await expect(first.locator('[data-streamdown="code-block-body"]')).toContainText(
          "const evidence",
        );
        await expect(first).toHaveAttribute("data-message-reference", metadata.ref);
        const verifyImages = async () => {
          for (const name of ["Relative screenshot", "Absolute screenshot", "Attachment pixels"]) {
            const image = first.getByRole("img", { name, exact: true });
            await expect(image).toHaveAttribute("src", `data:image/png;base64,${pixels}`);
            await expect
              .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
              .toBe(1);
          }
          await expect(first.getByText("Image not available: Missing screenshot")).toBeVisible();
        };
        await verifyImages();
        // Collapse unmounts image reads; reopening must resolve in the same source context.
        await first.getByRole("button", { name: /Full agent response/ }).click();
        await expect(first.getByRole("img")).toHaveCount(0);
        await first.getByRole("button", { name: /Full agent response/ }).click();
        await verifyImages();
        await first.getByRole("button", { name: "Next", exact: true }).click();
        await expect(first.getByText(/Last original finding/)).toBeVisible();
        await first.getByRole("button", { name: "Copy message", exact: true }).click();
        await expect(
          first.getByRole("button", { name: "Copied message", exact: true }),
        ).toBeVisible();
        expect(await page.evaluate(() => Reflect.get(window, "copiedMessage"))).toBe(originalText);
        await expect(first.getByText(/Last original finding/)).toBeVisible();
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
        // Notification-mode source is available without any model-authored relay.
        await first.getByRole("button", { name: /(?:Expand|Collapse) response/ }).click();
        await notification.getByRole("button", { name: /(?:Expand|Collapse) response/ }).click();
        await expect(
          notification.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeVisible();
        await notification.getByRole("button", { name: /(?:Expand|Collapse) response/ }).click();
        await missing.getByRole("button", { name: /(?:Expand|Collapse) response/ }).click();
        await expect(missing.getByText("Original response unavailable")).toBeVisible();
        await expect(missing.getByRole("button", { name: "Retry source" })).toBeVisible();
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
      };
      await verify("Message Cake Chat", CAKE_CHAT_SESSION_ID);
      await page.reload();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await verify("Message Cake Chat", CAKE_CHAT_SESSION_ID);
      await page
        .locator(
          `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
        )
        .click();
      await verify("Message Project Chat", projectId);
      await page.reload();
      await page
        .locator(
          `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
        )
        .click();
      await verify("Message Project Chat", projectId);
      expect(await readFile(sourceFile, "utf8")).toBe(originalFile);
      await page.getByRole("combobox", { name: "Message Project Chat" }).click();
      await page.keyboard.type("Follow-up stays here");
      await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toHaveValue(
        "Follow-up stays here",
      );
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
