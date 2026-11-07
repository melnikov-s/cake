import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { windowState } from "../../tests/fixtures/window-state.ts";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../src/contracts/application/application-data.ts";
import {
  emptyProjectTodos,
  type ProjectTodos,
} from "../../src/contracts/projects/project-todos.ts";
import type { ReviewThreadRecord } from "../../src/contracts/reviews/review-contract.ts";
import type { SubagentHistory } from "../../src/services/storage/SubagentStorage.ts";
import { SubagentHandleId } from "../../src/contracts/subagents/subagent-data.ts";
import type { VisualCaptureScenario } from "./scenarios.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sessionDirectory = (root: string, cwd: string) =>
  join(root, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
const sessions = [
  ["visual-navigation-layout", "UI Layout Refactor"],
  ["visual-navigation-keyboard", "Keyboard Editing & Navigation"],
  ["10000000-0000-4000-8000-000000000103", "Focus restoration"],
  ["visual-navigation-icons", "Icon Placement Exploration"],
] as const;
const todoId = "10000000-0000-4000-8000-000000000011";
const reviewTrigger = "Start controlled navigation reviews";
const nestedReviewTrigger = "Start a controlled nested review";
const nestedCloseTrigger = "Close the controlled nested review";
const nestedTask = "Nested discussion review";
const discussionSidecarId = "visual-navigation-selection-sidecar";
const reviewWorkerInstruction = "Native navigation visual review worker: keep the review running.";
interface FixtureMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type: string; readonly text?: string }[] | null;
}
const messageText = (message: FixtureMessage) =>
  typeof message.content === "string"
    ? message.content
    : (message.content
        ?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
        .join("\n") ?? "");
const completionChunk = (delta: object, finishReason: string | null = null) =>
  `data: ${JSON.stringify({ id: "navigation-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Uses the existing Pi/Durable fixture writers; only fixture data is synthetic, not the UI or tools. */
export function createChatFirstNavigationScenario(
  seedBase: VisualCaptureScenario["seed"],
  seedChat: (directory: string, texts: readonly string[]) => Promise<void>,
): VisualCaptureScenario {
  let project = "";
  let previewUrl = "";
  let runningStarted = false;
  let fixtureHome = "";
  let nestedHandleId: string | undefined;
  let nestedResponse: ServerResponse | undefined;
  const nestedRecord = async (history = false) => {
    const directory = join(
      fixtureHome,
      "state",
      history ? "private-worker-history" : "private-workers",
    );
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const record: {
        data: Pick<SubagentHistory, "handleId" | "parentSessionId" | "task" | "status">;
      } = JSON.parse(await readFile(join(directory, file), "utf8"));
      if (record.data.task === nestedTask) return record.data;
    }
    return undefined;
  };
  return {
    name: "chat-first-navigation",
    description:
      "Real conversation homes, recursive Sessions, shared To-dos and native workspace tools",
    states: [
      "project-todos",
      "sessions",
      "sessions-collapsed",
      "search",
      "deep-worker",
      "side-chat",
      "side-chats-menu",
      "subagent",
      "nested-subagent",
      "discussion-worker",
      "browser",
      "browser-compact",
      "vscode",
      "closed",
      "settings-icon",
      "rail-hover",
      "rail-keyboard",
      "rail-activity",
      "application-settings",
      "application-automations",
      "browser-rail",
      "vscode-rail",
    ],
    async seed(paths, theme) {
      const baseCleanup = await seedBase(paths, theme);
      project = paths.project;
      fixtureHome = paths.cakeHome;
      runningStarted = false;
      nestedHandleId = undefined;
      nestedResponse = undefined;
      const timestamp = new Date(Date.now() - 180_000).toISOString();
      const sessionRoot = join(paths.cakeHome, "pi", "sessions");
      const directory = sessionDirectory(sessionRoot, project);
      // Native fixtures use the registered, authorized CWD. Different managed-worktree
      // CWDs are covered by renderer workflow tests, not fabricated admission records.
      const workerDirectory = project;
      const writeSession = async (
        sessionId: string,
        title: string,
        answer: string,
        target = directory,
        workingDirectory = project,
      ) => {
        await mkdir(target, { recursive: true });
        const file = join(target, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
        await writeFile(
          file,
          [
            { type: "session", version: 3, id: sessionId, timestamp, cwd: workingDirectory },
            { type: "session_info", id: "title", parentId: null, timestamp, name: title },
            {
              type: "model_change",
              id: "model",
              parentId: "title",
              timestamp,
              provider: "navigation-visual",
              modelId: "fixture",
            },
            {
              type: "message",
              id: "question",
              parentId: "model",
              timestamp,
              message: {
                role: "user",
                content: [{ type: "text", text: "What is ready to review?" }],
                timestamp: 0,
              },
            },
            {
              type: "message",
              id: "answer",
              parentId: "question",
              timestamp,
              message: {
                role: "assistant",
                content: [{ type: "text", text: answer }],
                api: "openai-completions",
                provider: "navigation-visual",
                model: "fixture",
                usage,
                stopReason: "stop",
                timestamp: 1,
              },
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );
        return file;
      };
      await writeFile(
        join(paths.userData, "window-state.json"),
        windowState({ project, sessionId: sessions[0][0], theme }),
      );
      await rm(join(directory, "1970-01-01T00-00-00-000Z_visual-assistant-markdown-code.jsonl"));
      for (const [id, title] of sessions)
        await writeSession(
          id,
          title,
          `The ${title.toLowerCase()} work is ready for review.\n\nThe conversation, source files and to-do associations stay together when changing workspace modes.\n\nReturn to any ancestor through the breadcrumb without losing your draft.\n\nInspect [navigation.ts](navigation.ts#L1-L5).`,
          id === sessions[2][0] ? sessionDirectory(sessionRoot, workerDirectory) : directory,
          id === sessions[2][0] ? workerDirectory : project,
        );
      const chatHash = digest(project);
      const chatId = `project-chat:${chatHash}`;
      await seedChat(join(paths.cakeHome, "pi", "project-chats", chatHash), [
        "Keep the navigation work together. What is ready to review?",
        "The layout is ready for review. Icon placement needs your choice.\n\nThe header menu keeps side chats and subagents with their conversation; Sessions keeps actual Project Sessions.",
      ]);
      await seedChat(join(paths.cakeHome, "pi", "global-chat"), [
        "What is happening across my projects?",
        "Navigation work is active. Each project keeps its own Project Chat home.",
      ]);
      const otherProjects = [
        "docs-site",
        "orchard",
        ...Array.from(
          { length: 28 },
          (_, index) => `project-${String(index + 1).padStart(2, "0")}`,
        ),
      ].map((name) => ({
        path: join(project, "..", name),
        name,
        addedAt: timestamp,
        lastOpenedAt: timestamp,
        settings: defaultProjectSettings(),
        todos: emptyProjectTodos(),
      }));
      for (const other of otherProjects) {
        await mkdir(other.path, { recursive: true });
        await seedChat(join(paths.cakeHome, "pi", "project-chats", digest(other.path)), [
          `Review the ${other.name} work.`,
          "Project Chat remains the project home.",
        ]);
      }
      await writeFile(
        join(paths.cakeHome, "state", "session-families.json"),
        JSON.stringify({
          version: 10,
          data: {
            families: [
              {
                familyId: "visual-navigation-family",
                parentSessionId: sessions[0][0],
                projectPath: project,
                workingDirectory: project,
                createdAt: timestamp,
                children: sessions.slice(1, 3).map(([sessionId], index) => ({
                  sessionId,
                  parentSessionId: sessions[index]![0],
                  requestId: `navigation-child-${index}`,
                  workingDirectory: index === 1 ? workerDirectory : project,
                  createdAt: timestamp,
                })),
              },
            ],
            turns: [],
            spawnedSessions: [sessions[0], sessions[3]].map(([sessionId, title]) => ({
              sessionId,
              title,
              projectPath: project,
              workingDirectory: project,
              requester: { kind: "cake-chat", sessionId: chatId, title: "Project Chat" },
              reportDelivered: false,
              handoffSettled: true,
              launchedAt: timestamp,
            })),
          },
        }),
      );
      // Reviews retain their own Pi sidecars; these are real discussion records, not renderer projections.
      const sidecars: string[] = [];
      for (const [owner, title, id] of [
        [sessions[0][0], "Pane widths", "visual-navigation-widths"],
        [sessions[2][0], "Selection-path audit", "visual-navigation-selection"],
      ] as const) {
        const workingDirectory = owner === sessions[2][0] ? workerDirectory : project;
        const sidecarId = `${id}-sidecar`;
        sidecars.push(sidecarId);
        const agentSessionFile = await writeSession(
          sidecarId,
          title,
          `The ${title.toLowerCase()} discussion stays focused here, with its original parent in the breadcrumb.`,
          join(
            paths.cakeHome,
            "pi",
            "review-sessions",
            digest(workingDirectory),
            digest(owner),
            digest(id),
          ),
          workingDirectory,
        );
        const record: ReviewThreadRecord = {
          id,
          workspacePath: workingDirectory,
          sessionId: owner,
          agentSessionId: sidecarId,
          agentSessionFile,
          anchor: {
            view: "session",
            path: `session:${owner}`,
            start: { diffLine: 0 },
            end: { diffLine: 0 },
            selectedText: title,
            contextBefore: "",
            contextAfter: "",
            diff: "",
          },
          pendingComments: [],
          status: "open",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const reviewDirectory = join(
          paths.cakeHome,
          "state",
          "reviews",
          digest(workingDirectory),
          digest(owner),
        );
        await mkdir(reviewDirectory, { recursive: true });
        await writeFile(join(reviewDirectory, `${digest(id)}.json`), JSON.stringify(record));
      }
      const privateRoot = join(paths.cakeHome, "pi", "subagent-sessions");

      const historyDirectory = join(paths.cakeHome, "state", "private-worker-history");
      await mkdir(historyDirectory, { recursive: true });
      for (const [index, task] of [
        "Breadcrumb audit",
        "Icon and tooltip audit",
        "Dense tree review",
        "Nested selection review",
      ].entries()) {
        const handleId = SubagentHandleId.make(`10000000-0000-4000-8000-00000000000${index + 1}`);
        const privateSessionId = `visual-navigation-agent-${index}`;
        const parentSessionId = index === 3 ? sidecars[1]! : sessions[0][0];
        const workingDirectory = index === 3 ? workerDirectory : project;
        await writeSession(
          privateSessionId,
          task,
          `## ${task}\n\nThe review is complete. Parent lineage, conversation identity and associated to-dos remain intact.`,
          sessionDirectory(privateRoot, workingDirectory),
          workingDirectory,
        );
        const history: SubagentHistory = {
          handleId,
          privateSessionId,
          parentSessionId,
          parentWorkingDirectory: workingDirectory,
          anchorPartId: `navigation-agent-${index}`,
          workingDirectory,
          projectPath: project,
          sessionDirectory: privateRoot,
          task,
          status: "complete",
          fastMode: false,
          resolvedModel: {
            requested: "current",
            source: "current",
            provider: "anthropic",
            modelId: "visual-fixture",
            thinkingLevel: "off",
            fallbacks: [],
          },
        };
        await writeFile(
          join(historyDirectory, `${digest(handleId)}.json`),
          JSON.stringify({ version: 1, data: history }),
        );
      }
      await writeFile(
        join(project, "README.md"),
        "# Conversation-first navigation\n\nProject Chat is home. Workspace tools keep the focused conversation.\n",
      );
      await writeFile(
        join(project, "navigation.ts"),
        "export const workspaceModes = ['Chat', 'VS Code', 'Browser'] as const;\n\nexport function projectHome(project: string) {\n  return `${project} / Project Chat`;\n}\n",
      );
      await writeFile(
        join(project, "index.html"),
        "<!doctype html><html><head><title>Navigation review</title></head><body><main><h1>Conversation navigation</h1><p>Project Chat is the project home.</p><h2>Ready for review</h2><ul><li>Full parent lineage</li><li>One focused conversation</li><li>Shared To-dos and Sessions</li></ul><p>This local project page is rendered by the real native Chromium Browser workspace.</p></main></body></html>",
      );
      const server = createServer(async (request, response) => {
        if (request.url?.startsWith("/v1/")) {
          let body = "";
          for await (const part of request) body += part;
          const input: { readonly messages: readonly FixtureMessage[] } = JSON.parse(body);
          const inputText = input.messages
            .filter((message) => message.role === "system" || message.role === "user")
            .map(messageText)
            .join("\n");
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (inputText.includes(reviewWorkerInstruction)) {
            // Actual Pi subagents remain running against controlled provider HTTP.
            if (inputText.includes(nestedTask)) nestedResponse = response;
            response.write(completionChunk({ content: "Reviewing the conversation lineage…" }));
            return;
          }
          const last = input.messages.at(-1);
          if (last?.role === "user" && messageText(last).includes(nestedCloseTrigger)) {
            if (!nestedHandleId) throw new Error("Nested public handle was not observed");
            response.end(
              completionChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "close-nested-review",
                    type: "function",
                    function: {
                      name: "cake",
                      arguments: JSON.stringify({
                        command: "subagents.close",
                        input: { handleId: nestedHandleId },
                      }),
                    },
                  },
                ],
              }) +
                completionChunk({}, "tool_calls") +
                "data: [DONE]\n\n",
            );
            return;
          }
          if (
            (inputText.includes(reviewTrigger) || inputText.includes(nestedReviewTrigger)) &&
            !input.messages.some((message) => message.role === "tool")
          ) {
            response.end(
              completionChunk({
                tool_calls: (inputText.includes(nestedReviewTrigger)
                  ? [nestedTask]
                  : ["Breadcrumb audit", "Icon and tooltip audit", "Dense tree review"]
                ).map((task, index) => ({
                  index,
                  id: `navigation-review-${index}`,
                  type: "function",
                  function: {
                    name: "cake",
                    arguments: JSON.stringify({
                      command: "subagents.start",
                      input: {
                        task,
                        instructions: reviewWorkerInstruction,
                        continuation: "none",
                      },
                    }),
                  },
                })),
              }) +
                completionChunk({}, "tool_calls") +
                "data: [DONE]\n\n",
            );
          } else
            response.end(
              completionChunk({
                content: inputText.includes(nestedCloseTrigger)
                  ? "Nested review closed."
                  : "Reviews are running.",
              }) +
                completionChunk({}, "stop") +
                "data: [DONE]\n\n",
            );
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(await readFile(join(project, "index.html")));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Navigation preview server has no TCP address");
      previewUrl = `http://127.0.0.1:${address.port}/`;
      await writeFile(join(paths.cakeHome, "pi", "auth.json"), "{}");
      await writeFile(
        join(paths.cakeHome, "pi", "settings.json"),
        JSON.stringify({ defaultProvider: "navigation-visual", defaultModel: "fixture" }),
      );
      await writeFile(
        join(paths.cakeHome, "pi", "models.json"),
        JSON.stringify({
          providers: {
            "navigation-visual": {
              name: "Navigation visual fixture",
              baseUrl: `${previewUrl}v1`,
              apiKey: "fixture-only",
              api: "openai-completions",
              models: [
                {
                  id: "fixture",
                  name: "Navigation visual fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        }),
      );
      const todos: ProjectTodos = {
        ...emptyProjectTodos(),
        items: [
          {
            id: todoId,
            title: "Review conversation navigation",
            description: "Review full parent lineage and the same-conversation workspace tools.",
            status: "Ready for review",
            state: "open",
            revision: 0,
            createdAt: timestamp,
            associations: [{ kind: "session", sessionId: sessions[2][0], title: sessions[2][1] }],
          },
          {
            id: "10000000-0000-4000-8000-000000000012",
            title: "Agree on project icon placement",
            description: "Choose recognizable artwork in Project settings.",
            status: "Waiting for your choice",
            state: "open",
            revision: 0,
            createdAt: timestamp,
            needsAttention: true,
            attentionReason: "Choose the project artwork",
            associations: [{ kind: "session", sessionId: sessions[3][0], title: sessions[3][1] }],
          },
          {
            id: "10000000-0000-4000-8000-000000000013",
            title: "Preserve conversation capabilities",
            description: "Keep original transcripts and session associations.",
            status: "Reviewed",
            state: "done",
            revision: 0,
            createdAt: timestamp,
            associations: [],
          },
        ],
      };
      await writeFile(
        join(paths.cakeHome, "state", "application.json"),
        JSON.stringify({
          version: 10,
          data: {
            ...defaultApplicationState(),
            projects: [
              {
                path: project,
                name: "cake",
                addedAt: timestamp,
                lastOpenedAt: timestamp,
                settings: {
                  ...defaultProjectSettings(),
                  browserDefaultUrl: previewUrl,
                  icon: {
                    mimeType: "image/png",
                    data: (
                      await readFile(join(import.meta.dirname, "../../src/assets/cake.png"))
                    ).toString("base64"),
                  },
                },
                todos,
              },
              ...otherProjects,
            ],
          },
        }),
      );
      return async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        if (typeof baseCleanup === "function") await baseCleanup();
      };
    },
    async prepare(page, state, application) {
      const browserState =
        state === "browser" || state === "browser-compact" || state === "browser-rail";
      const vscodeState = state === "vscode" || state === "vscode-rail";
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      const settle = () =>
        page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => undefined)),
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
      const hoverRail = async () => {
        await rail.hover();
        const bounds = (await rail.boundingBox())!;
        await page.mouse.move(bounds.x + 1, bounds.y + 3);
        await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
      };
      // The restored Project Session exposes the rail before the independent chat
      // catalog has hydrated. Global home activation waits for that catalog; its
      // seeded transcript proves readiness without sleeping or retrying a failed click.
      await rail.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      await expect(
        page.getByText("Navigation work is active. Each project keeps its own Project Chat home.", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 20_000 });
      await rail.getByRole("button", { name: "Open Project Chat for cake", exact: true }).click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      const homeAssistant = page.getByText(
        "The layout is ready for review. Icon placement needs your choice.",
        { exact: true },
      );
      await expect(homeAssistant).toBeVisible({ timeout: 20_000 });
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      await workspace.getByRole("button", { name: /^To-dos / }).click();
      await expect(
        workspace.getByRole("button", { name: "Review conversation navigation", exact: true }),
      ).toBeVisible();
      if (state === "rail-hover" || state === "rail-keyboard") {
        if (state === "rail-hover") await hoverRail();
        else {
          await page.mouse.move(500, 200);
          await rail
            .getByRole("button", { name: "Open Project Chat for project-28", exact: true })
            .focus();
        }
        await expect(
          rail
            .getByRole("button", { name: "Settings", exact: true })
            .locator("[data-slot=icon-button-label]"),
        ).toBeVisible();
        await settle();
        return;
      }
      if (state === "application-settings" || state === "application-automations") {
        const name = state === "application-settings" ? "Settings" : "Automations";
        await rail.getByRole("button", { name, exact: true }).click();
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        await settle();
        return;
      }
      if (state === "closed")
        await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
      else if (state === "settings-icon") {
        if (!application) throw new Error("Project settings capture requires Electron");
        // Only the native popup boundary is replaced, as in the maintained menu smoke tests.
        // Product menu construction and the Project Settings workflow remain real.
        await application.evaluate(({ Menu }) => {
          const build = Menu.buildFromTemplate.bind(Menu);
          Menu.buildFromTemplate = (template) => {
            const menu = build(template);
            const settings = menu.items.find((item) => item.label === "Project Settings…");
            if (settings) {
              Menu.buildFromTemplate = build;
              menu.popup = (options) => {
                settings.click(settings, options!.window!, { triggeredByAccelerator: false });
                options?.callback?.();
              };
            }
            return menu;
          };
        });
        await rail
          .getByRole("button", { name: "Open Project Chat for cake", exact: true })
          .click({ button: "right" });
        const dialog = page.getByRole("dialog", { name: "cake settings", exact: true });
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Choose icon…", exact: true }),
        ).toBeVisible();
      } else if (state !== "project-todos") {
        await workspace.getByRole("button", { name: /^Sessions / }).click();
        const tree = page.getByRole("region", { name: "Sessions", exact: true });
        if (!runningStarted) {
          if (!application) throw new Error("Controlled running workers require isolated Electron");
          await application.evaluate(() => {
            const original = globalThis.fetch;
            globalThis.fetch = async (input, init) => {
              const url = new URL(input instanceof Request ? input.url : String(input));
              if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
                throw new Error("External HTTP disabled in navigation visual fixture");
              return original(input, init);
            };
          });
          const expandHome = tree.getByRole("button", { name: "Expand cake", exact: true });
          if (await expandHome.count()) await expandHome.click();
          await tree
            .locator(`[data-session-id="${sessions[0][0]}"]`)
            .getByRole("button", { name: /^UI Layout Refactor(?: |$)/ })
            .click();
          const draft = page.getByRole("combobox", { name: "Message", exact: true });
          await draft.fill(reviewTrigger);
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await expect(page.getByText("Reviews are running.", { exact: true })).toBeVisible({
            timeout: 30_000,
          });
          await page.getByRole("button", { name: /^Side chats and subagents,/ }).click();
          await expect(
            page
              .getByRole("dialog", { name: "Open side chats" })
              .getByRole("img", { name: "Running", exact: true }),
          ).toHaveCount(3);
          await page.keyboard.press("Escape");
          runningStarted = true;
          if (state === "sessions" || state === "rail-activity") {
            await rail
              .getByRole("button", { name: "Open Project Chat for cake", exact: true })
              .click();
            await expect(homeAssistant).toBeVisible({ timeout: 20_000 });
          }
        }
        for (const title of [
          "cake",
          sessions[0][1],
          sessions[1][1],
          sessions[2][1],
          "Selection-path audit",
        ]) {
          const expand = tree.getByRole("button", { name: `Expand ${title}`, exact: true });
          if (await expand.count()) await expand.click();
        }
        if (state === "sessions-collapsed") {
          await tree
            .getByRole("button", { name: "Collapse UI Layout Refactor", exact: true })
            .click();
          await expect(
            tree.getByRole("button", { name: "Expand UI Layout Refactor", exact: true }),
          ).toBeVisible();
        } else if (state === "search") {
          await tree
            .getByRole("searchbox", { name: "Search sessions", exact: true })
            .fill("Focus restoration");
          await expect(
            tree.getByRole("button", { name: /^Focus restoration(?: |$)/ }),
          ).toBeVisible();
        } else if (state === "deep-worker" || browserState || vscodeState) {
          await tree
            .locator(`[data-session-id="${sessions[2][0]}"]`)
            .getByRole("button", { name: /^Focus restoration(?: |$)/ })
            .click();
          await expect(
            page.getByRole("navigation", { name: "Conversation breadcrumb" }),
          ).toContainText(sessions[1][1]);
          const focusedAssistant = page.getByText(
            "The focus restoration work is ready for review.",
            { exact: true },
          );
          await expect(focusedAssistant).toBeVisible({ timeout: 20_000 });
          if (state === "deep-worker") {
            await workspace.getByRole("button", { name: /^To-dos / }).click();
            await workspace
              .getByRole("button", { name: "Review conversation navigation", exact: true })
              .click();
          } else {
            await page
              .getByRole("button", {
                name: browserState ? "Open Browser Mode" : "Open VS Code",
                exact: true,
              })
              .click();
            await expect(
              page.getByRole("region", {
                name: browserState ? "Browser workspace" : "VS Code workspace",
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              page.getByRole("complementary", {
                name: "Current conversation companion",
                exact: true,
              }),
            ).toBeVisible();
            await expect(focusedAssistant).toBeVisible({ timeout: 20_000 });
            if (browserState) {
              if (!application) throw new Error("Native browser capture requires Electron");
              await expect
                .poll(
                  () =>
                    application.evaluate(
                      ({ webContents }, url) =>
                        webContents
                          .getAllWebContents()
                          .some(
                            (contents) =>
                              contents.getURL() === url &&
                              contents.getTitle() === "Navigation review",
                          ),
                      previewUrl,
                    ),
                  { timeout: 20_000 },
                )
                .toBe(true);
            }
            if (state === "browser-compact") {
              await page.getByRole("button", { name: "Close chat", exact: true }).click();
              await expect(
                page.getByRole("complementary", {
                  name: "Current conversation companion",
                  exact: true,
                }),
              ).toBeHidden();
              if (!application) throw new Error("Native browser capture requires Electron");
              const viewport = await page.locator('[aria-label="Browser viewport"]').boundingBox();
              if (!viewport) throw new Error("Browser viewport has no bounds");
              await expect
                .poll(
                  () =>
                    application.evaluate(
                      ({ BrowserWindow, WebContentsView }, expected) =>
                        BrowserWindow.getAllWindows()[0]?.contentView.children.some(
                          (view) =>
                            view instanceof WebContentsView &&
                            view.getVisible() &&
                            view.webContents.getURL() === expected.url &&
                            Math.abs(view.getBounds().width - expected.width) < 2,
                        ),
                      { url: previewUrl, width: viewport.width },
                    ),
                  { timeout: 10_000 },
                )
                .toBe(true);
            }
            if (vscodeState) {
              if (!application) throw new Error("VS Code capture requires Electron");
              await page.getByRole("link", { name: "navigation.ts", exact: true }).click();
              await expect
                .poll(
                  () =>
                    application.evaluate(async ({ webContents }) => {
                      for (const contents of webContents.getAllWebContents()) {
                        if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
                        if (
                          await contents.executeJavaScript(
                            'Boolean(document.querySelector(".monaco-editor .view-lines"))',
                          )
                        )
                          return true;
                      }
                      return false;
                    }),
                  { timeout: 60_000 },
                )
                .toBe(true);
            }
          }
        } else if (
          state === "side-chat" ||
          state === "discussion-worker" ||
          state === "nested-subagent"
        ) {
          await tree
            .locator(`[data-session-id="${sessions[2][0]}"]`)
            .getByRole("button", { name: /^Focus restoration(?: |$)/ })
            .click();
          await page.getByRole("button", { name: /^Side chats/ }).click();
          await page
            .getByRole("dialog", { name: "Open side chats" })
            .getByRole("button", { name: "Selection-path audit", exact: true })
            .click();
          await expect(
            page.getByRole("complementary", { name: "Side chat", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(
              "The selection-path audit discussion stays focused here, with its original parent in the breadcrumb.",
              { exact: true },
            ),
          ).toBeVisible({ timeout: 20_000 });
          if (state === "discussion-worker") {
            const draft = page.getByRole("combobox", { name: "Reply to side chat", exact: true });
            await draft.fill(nestedReviewTrigger);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await expect(page.getByText("Reviews are running.", { exact: true })).toBeVisible({
              timeout: 30_000,
            });
            await expect
              .poll(async () => (await nestedRecord())?.parentSessionId, { timeout: 20_000 })
              .toBe(discussionSidecarId);
            nestedHandleId = (await nestedRecord())!.handleId;
            await expect.poll(() => Boolean(nestedResponse), { timeout: 20_000 }).toBe(true);
            nestedResponse!.end(
              completionChunk({ content: "Nested review complete." }) +
                completionChunk({}, "stop") +
                "data: [DONE]\n\n",
            );
            await expect
              .poll(async () => (await nestedRecord())?.status, { timeout: 20_000 })
              .toBe("complete");
            await draft.fill(nestedCloseTrigger);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await expect(page.getByText("Nested review closed.", { exact: true })).toBeVisible({
              timeout: 30_000,
            });
            await expect
              .poll(async () => (await nestedRecord(true))?.parentSessionId, { timeout: 20_000 })
              .toBe(discussionSidecarId);
            await page
              .getByRole("complementary", { name: "Side chat", exact: true })
              .getByRole("button", { name: /^Side chats and subagents,/ })
              .click();
            await page
              .getByRole("dialog", { name: "Open side chats" })
              .getByRole("button", { name: nestedTask, exact: true })
              .click();
            await expect(page.getByText(/Nested review complete\./)).toBeVisible({
              timeout: 20_000,
            });
            await expect(
              page.getByRole("navigation", { name: "Conversation breadcrumb" }),
            ).toContainText("Selection-path audit");
          }
          if (state === "nested-subagent") {
            await page
              .getByRole("complementary", { name: "Side chat", exact: true })
              .getByRole("button", { name: /^Side chats and subagents,/ })
              .click();
            await page
              .getByRole("dialog", { name: "Open side chats" })
              .getByRole("button", { name: "Nested selection review", exact: true })
              .click();
            await expect(
              page.locator('[data-slot="focused-secondary-conversation"]'),
            ).toBeVisible();
          }
        } else if (state === "subagent" || state === "side-chats-menu") {
          await tree
            .locator(`[data-session-id="${sessions[0][0]}"]`)
            .getByRole("button", { name: /^UI Layout Refactor(?: |$)/ })
            .click();
          await page.getByRole("button", { name: /^Side chats and subagents,/ }).click();
          if (state === "side-chats-menu") {
            await settle();
            return;
          }
          await page
            .getByRole("dialog", { name: "Open side chats" })
            .getByRole("button", { name: "Breadcrumb audit", exact: true })
            .filter({ hasText: "Working…" })
            .click();
          await expect(
            page.getByText("Reviewing the conversation lineage…", { exact: true }),
          ).toBeVisible({ timeout: 20_000 });
        }
      }
      await page.waitForFunction(() => document.fonts.status === "loaded");
      if (state === "rail-activity") {
        await rail.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
        await expect(
          page.getByText(
            "Navigation work is active. Each project keeps its own Project Chat home.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          rail.getByRole("img", { name: "Work running in cake", exact: true }),
        ).toBeVisible();
        await hoverRail();
      } else if (state === "browser-rail" || state === "vscode-rail") {
        await hoverRail();
        if (application)
          await expect
            .poll(async () =>
              application.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]!.contentView.children.some((view) => {
                  const bounds = view.getBounds();
                  return bounds.x >= 240 && bounds.width > 0;
                }),
              ),
            )
            .toBe(true);
      } else await page.mouse.move(1, 1);
      await settle();
    },
    region: (page) => page.locator("body"),
  };
}
