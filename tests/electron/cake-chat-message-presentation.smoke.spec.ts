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
import { projectSessionEntries } from "../../src/services/pi/runtime/session-projection";
import { encodeCrossSessionMessage } from "../../src/contracts/conversations/cross-session-message";
import { appendMessageReferences } from "../../src/contracts/conversations/message-reference-forwarding";
import { protectedResponseNotice } from "../../src/contracts/conversations/reference-notification";

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
  test(`All three chats share title-only ${delivery} links after reload (${theme})`, async () => {
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
      const viewer = SessionManager.create(
        paths.project,
        cakeWorkspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
      );
      viewer.appendSessionInfo("Shared response viewer");
      const links = `[Review findings](${metadata.ref}) and [same original](${metadata.ref}).\n\n[Producer session](cake://session/${source.getSessionId()})`;
      const records: {
        kind: "linked" | "notification" | "receipt" | "missing" | "running-only";
        message: Parameters<typeof source.appendMessage>[0];
      }[] = [
        {
          kind: "linked",
          message:
            delivery === "assistant"
              ? {
                  role: "assistant",
                  content: [{ type: "text", text: links }],
                  api: "anthropic-messages",
                  provider: "anthropic",
                  model: "fixture",
                  stopReason: "stop",
                  timestamp: 2,
                  usage,
                }
              : {
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
        },
        {
          kind: "running-only",
          message: {
            role: "user",
            timestamp: 3,
            content:
              "<system-reminder>\nCake session updates\n2 sessions you launched are still running.\n</system-reminder>",
          },
        },
        {
          kind: "notification",
          message: {
            role: "user",
            timestamp: 3,
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
              interruptedReport: false,
            })!.replace(
              "\n</system-reminder>",
              "\n1 session you launched is still running.\n</system-reminder>",
            )}\n\nDiscuss the summary here`,
          },
        },
        {
          kind: "receipt",
          message: {
            role: "user",
            timestamp: 4,
            content: encodeCrossSessionMessage(
              appendMessageReferences(protectedResponseNotice, [metadata.ref]),
              {
                version: 1,
                messageId: randomUUID(),
                threadId: randomUUID(),
                replyToMessageId: randomUUID(),
                sequence: 1,
                expectsResponse: false,
                sender: {
                  sessionId: source.getSessionId(),
                  title: "Detailed delegated review",
                  kind: "project-session",
                },
              },
            ),
          },
        },
        {
          kind: "missing",
          message: {
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
            timestamp: 5,
          },
        },
      ];
      const partIds = new Map<string, Map<string, string>>();
      const ordinaryIds = new Map<string, string>();
      partIds.set(viewer.getSessionId(), ordinaryIds);
      for (const { kind, message } of records) {
        // Pi Project Sessions store ordinary assistant links, not Durable input envelopes.
        const ordinary =
          kind === "linked"
            ? {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: links }],
                api: "anthropic-messages" as const,
                provider: "anthropic",
                model: "fixture",
                stopReason: "stop" as const,
                timestamp: 2,
                usage,
              }
            : message;
        const id = viewer.appendMessage(ordinary);
        if (kind === "running-only") continue;
        const part = projectSessionEntries(viewer.getEntries()).find((part) =>
          kind === "notification"
            ? part.id === `entry-${id}-context-0`
            : kind === "missing"
              ? part.kind === "tool" && part.messageReference
              : part.kind === "text" && part.entryId === id,
        );
        if (!part) throw new Error(`Missing projected ${kind} source`);
        ordinaryIds.set(kind, part.id);
      }
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
        const ids = new Map<string, string>();
        partIds.set(sessionId, ids);
        try {
          const conversation = await harness.root(BACKGROUND_CONTEXT);
          await conversation.commit(async (tx) => {
            for (const { kind, message } of records) {
              const entry = await tx.appendEntry(
                message.role === "assistant"
                  ? AssistantEntry
                  : message.role === "toolResult"
                    ? ToolResultEntry
                    : UserEntry,
                conversation.id,
                { model: [message] },
              );
              ids.set(
                kind,
                `entry-${entry.id}-${kind === "notification" ? "context-0" : message.role === "assistant" ? "text-0" : message.role === "toolResult" ? "tool" : "text"}`,
              );
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
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 1100),
        theme === "light" ? 900 : 1280,
      );
      // Finish the seeded Project Session's startup selection before navigating away.
      await expect(
        page.getByRole("heading", { name: "Repository-owned visual checks" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      const verify = async (inputName: string, sessionId: string) => {
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
        await stubClipboard();
        await expect(page.getByRole("status", { name: "Session results" })).toHaveCount(1);
        await expect(page.getByRole("button", { name: "Cake · session updates" })).toHaveCount(0);
        await expect(
          page.getByText(/\d+ sessions? you launched (?:is|are) still running\./),
        ).toHaveCount(0);
        const surfaces = page.locator('[data-slot="message-source"]');
        await expect(surfaces).toHaveCount(4);
        const first = page.locator(
          `[data-part-id="${partIds.get(sessionId)!.get("linked")}"] [data-slot="message-source"]`,
        );
        const notification = page.locator(
          `[data-part-id="${partIds.get(sessionId)!.get("notification")}"] [data-slot="message-source"]`,
        );
        const receipt = page.locator(
          `[data-part-id="${partIds.get(sessionId)!.get("receipt")}"] [data-slot="message-source"]`,
        );
        for (const source of [first, notification, receipt]) {
          const header = source.locator('[data-slot="response-disclosure"]');
          await expect(header).toHaveText("Detailed delegated review");
          await expect(header).toHaveAttribute("aria-expanded", "false");
          await expect(source).toHaveText("Detailed delegated review");
          expect(await header.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(
            true,
          );
        }
        const verifyHeadingAlignment = async () => {
          const edges = async (source: typeof first) =>
            source.locator('[data-slot="response-disclosure"]').evaluate(async (button) => {
              await Promise.all(
                button.getAnimations({ subtree: true }).map((animation) => animation.finished),
              );
              return {
                title: button.querySelector("span")!.getBoundingClientRect().left,
                chevron: button.querySelector("svg")!.getBoundingClientRect().right,
              };
            });
          const standalone = await edges(first);
          const batched = await edges(notification);
          expect(batched.title).toBeCloseTo(standalone.title, 0);
          expect(batched.chevron).toBeCloseTo(standalone.chevron, 0);
          // Attributed responses remain deliberately inset inside their session card.
          const nested = await edges(receipt);
          expect(nested.title).toBeGreaterThan(standalone.title);
          expect(nested.chevron).toBeLessThan(standalone.chevron);
        };
        await verifyHeadingAlignment();
        const missing = page.locator(
          '[data-message-reference="cake://session/deleted-producer?message=deleted-entry"]',
        );
        await expect(
          first.getByRole("button", { name: "Detailed delegated review", exact: true }),
        ).toHaveAttribute("aria-expanded", "false");
        await first.getByRole("button", { name: "Detailed delegated review", exact: true }).click();
        await expect
          .poll(() =>
            first
              .getByRole("button", { name: "Detailed delegated review", exact: true })
              .evaluate((button) => {
                const viewport = button.closest(".transcript")!.getBoundingClientRect();
                return button.getBoundingClientRect().top - viewport.top;
              }),
          )
          .toBeGreaterThanOrEqual(0);
        await expect(
          first.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeVisible();
        await verifyHeadingAlignment();
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
        const expandedId = await first
          .locator('[data-slot="response-disclosure"]')
          .getAttribute("aria-controls");
        const expanded = page.locator(`[id="${expandedId}"]`);
        expect(
          await expanded.evaluate((body) => ({
            header: body.firstElementChild?.textContent,
            contentStart:
              body.firstElementChild?.nextElementSibling?.querySelector("h2")?.textContent,
          })),
        ).toEqual({
          header: "Detailed delegated review",
          contentStart: "Original detailed findings",
        });
        await expect(
          expanded.getByRole("button", { name: "Copy message", exact: true }),
        ).toBeVisible();
        await expect(
          first.getByRole("link", { name: "Detailed delegated review", exact: true }),
        ).toHaveAttribute("href", metadata.ref);
        await page.waitForFunction(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-slot="message-source"] [data-streamdown="code-block-body"] code span span',
            ),
          ).some((token) => token.style.getPropertyValue("--sdm-c") !== "inherit"),
        );
        // Real Chromium selection remains native in both Markdown prose and highlighted code.
        for (const [target, word] of [
          [first.getByText("Substance stays in Pi."), "Substance"],
          [first.locator('[data-streamdown="code-block-body"] code'), "evidence"],
        ] as const) {
          const point = await target.evaluate((element, word) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
              const start = node.textContent!.indexOf(word);
              if (start < 0) continue;
              const range = document.createRange();
              range.setStart(node, start);
              range.setEnd(node, start + word.length);
              const rect = range.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
            throw new Error("Selection word missing");
          }, word);
          await page.mouse.dblclick(point.x, point.y);
          await expect
            .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
            .toBe(word);
        }
        // Collapse unmounts image reads; reopening must resolve in the same source context.
        await first.getByRole("button", { name: "Detailed delegated review", exact: true }).click();
        await expect(first.getByRole("img")).toHaveCount(0);
        await first.getByRole("button", { name: "Detailed delegated review", exact: true }).click();
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
        await first.getByRole("button", { name: "Detailed delegated review", exact: true }).click();
        await notification.getByRole("button", { name: "Detailed delegated review" }).click();
        await expect(
          notification.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeVisible();
        await notification.getByRole("button", { name: "Detailed delegated review" }).click();
        const receiptHeader = receipt.getByRole("button", {
          name: "Detailed delegated review",
          exact: true,
        });
        await receiptHeader.click();
        await expect(
          receipt.getByRole("heading", { name: "Original detailed findings" }),
        ).toBeInViewport();
        await expect(
          receipt.getByRole("link", { name: "Detailed delegated review", exact: true }),
        ).toHaveAttribute("href", metadata.ref);
        await expect(receipt.getByText("Substance stays in Pi.")).toHaveCount(1);
        await receiptHeader.click();
        await expect(receipt).toHaveText("Detailed delegated review");
        await missing.getByRole("button", { name: "Source session", exact: true }).click();
        await expect(missing.getByText("Original response unavailable")).toBeVisible();
        await expect(missing.getByRole("button", { name: "Retry source" })).toBeVisible();
        await expect(page.getByRole("combobox", { name: inputName })).toBeVisible();
      };
      await page.locator(`.session-item[data-session-id="${viewer.getSessionId()}"]`).click();
      await verify("Message", viewer.getSessionId());
      await page.reload();
      await verify("Message", viewer.getSessionId());
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
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
      const notification = page.locator(
        `[data-part-id="${partIds.get(projectId)!.get("notification")}"] [data-slot="message-source"]`,
      );
      await notification
        .getByRole("button", { name: "Detailed delegated review", exact: true })
        .click();
      await notification
        .getByRole("link", { name: "Detailed delegated review", exact: true })
        .click();
      await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText(
        "Detailed delegated review",
      );
      await expect(page.getByRole("heading", { name: "Original detailed findings" })).toBeVisible();
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
