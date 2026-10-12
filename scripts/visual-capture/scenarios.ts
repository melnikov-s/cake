import {
  seedMessageBoardFixture,
  MESSAGE_BOARD_FIXTURE_ID,
} from "../../tests/fixtures/message-board.ts";
import { defaultApplicationState } from "../../src/contracts/application/application-data.ts";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-data.ts";
import { openRequestInspectorFixture } from "./request-inspector-fixture.ts";
import { drawMermaidArchitecture } from "../../tests/fixtures/draw-mermaid-architecture.ts";
import { addResponseModeReminder } from "../../src/contracts/conversations/response-mode-reminders.ts";
import { encodeCrossSessionMessage } from "../../src/contracts/conversations/cross-session-message.ts";
import { addPresentationModeReminder } from "../../src/contracts/conversations/presentation-mode-reminders.ts";
import { nestedAssistant, nestedEntries } from "../../tests/fixtures/nested-tool-activity.ts";
import { seedWorkflowCheckpoint } from "../../tests/fixtures/workflow-checkpoint.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry, AssistantEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-durable-ai";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { VisualCaptureTheme } from "./arguments.ts";
import type { CakeArtifactV1 } from "../../src/contracts/artifacts/artifact-contract.ts";
import type { CakeEvent } from "../../src/contracts/application/cake-rpc-contract.ts";
import {
  emitRendererEvent,
  installLocalModelHttpGuard,
  installSpeechHttpFixture,
} from "../../tests/electron/main-harness.ts";

interface ScenarioFixturePaths {
  readonly cakeHome: string;
  readonly project: string;
  readonly userData: string;
}

interface VisualCaptureScenario {
  readonly name: string;
  readonly description: string;
  readonly states: readonly string[];
  environment?(paths: ScenarioFixturePaths): Record<string, string>;
  seed(
    paths: ScenarioFixturePaths,
    theme: VisualCaptureTheme,
    artifact?: CakeArtifactV1,
  ): Promise<void | (() => Promise<void>)>;
  prepare(page: Page, state: string, application?: ElectronApplication): Promise<void>;
  region(page: Page, state: string): Locator;
}

const assistantMarkdown = [
  "## Repository-owned visual checks",
  "",
  "Use the capture harness whenever a Cake UI change benefits from a visual review.",
  "",
  "```tsx",
  "interface CaptureResult {",
  "  scenario: string;",
  '  state: "default" | "hover";',
  "  outputPath: string;",
  "}",
  "```",
  "",
  "> Named scenarios keep setup and interaction deterministic.",
].join("\n");

const assistantMarkdownCode: VisualCaptureScenario = {
  name: "assistant-markdown-code",
  description: "Assistant Markdown with a highlighted TypeScript code block",
  states: ["default", "hover", "quick-assistant", "assistant-chat", "resolved"],
  async seed(paths, theme) {
    const sessionId = "visual-assistant-markdown-code";
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      JSON.stringify({
        projectPath: paths.project,
        selectedSessionId: sessionId,
        activeConversation: {
          kind: "project-session",
          workspacePath: paths.project,
          sessionId,
        },
        recentProjectPaths: [paths.project],
        draft: "",
        draftsBySession: {},
        theme,
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "visual-capture-project",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [],
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      `${[
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "How should agents capture Cake UI changes?" }],
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: assistantMarkdown }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "visual-fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    await seedSessionAssistant(paths, sessionId, timestamp);
  },
  async prepare(page, state) {
    const code = page.locator('[data-streamdown="code-block-body"] code');
    await code.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-streamdown="code-block-body"] code span span',
        ),
      ).some((token) => token.style.getPropertyValue("--sdm-c") !== "inherit"),
    );

    if (state === "hover") {
      await page.locator(".group\\/code").hover();
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLElement>(
          '[data-streamdown="code-block-copy-button"]',
        );
        return button !== null && Number.parseFloat(getComputedStyle(button).opacity) === 1;
      });
      return;
    }
    if (state === "resolved") {
      await page.locator(".session-item.active .session-resolve-action").click();
      await page.getByRole("button", { name: "Expand Resolved", exact: true }).click();
      const lane = page.getByRole("region", { name: "Resolved sessions" });
      await lane
        .getByRole("button", { name: "Expand visual-capture-project resolved" })
        .last()
        .click();
      await lane.locator(".session-row").click();
      await expect(page.locator('[data-slot="session-smoke"]')).toHaveCount(1);
      await page.mouse.move(1, 1);
      await page.locator('[data-slot="session-smoke"]').evaluateAll(async (puffs) => {
        await Promise.all(
          puffs.flatMap((puff) => puff.getAnimations().map((animation) => animation.finished)),
        );
      });
      return;
    }
    const assistant = page.getByRole("button", { name: "Ask session assistant" });
    if (state === "quick-assistant") {
      await assistant.click();
      const input = page.getByRole("dialog", { name: "Quick session assistant" });
      await input.getByLabel("Ask session assistant").fill("Open the file we discussed in VS Code");
      return;
    }
    if (state === "assistant-chat") {
      await assistant.click({ button: "right" });
      const chat = page.getByRole("dialog", { name: "Session assistant chat" });
      await chat.getByText("I found the file and opened it in VS Code.").waitFor();
      return;
    }
    await page.mouse.move(1, 1);
  },
  region(page) {
    const dialog = page.getByRole("dialog");
    const message = page
      .locator('[data-slot="message"]')
      .filter({ has: page.locator('[data-streamdown="code-block-body"]') })
      .locator('[data-slot="message-content"]');
    return dialog.or(message).last();
  },
};

const workflowProgressScenario: VisualCaptureScenario = {
  ...assistantMarkdownCode,
  name: "workflow-progress",
  description: "Project-owned workflow card with optional frozen-source detail beside shared Chat",
  states: ["default", "details"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    await seedWorkflowCheckpoint(paths.cakeHome, "visual-assistant-markdown-code", paths.project);
  },
  async prepare(page, state) {
    const card = page.locator('[data-slot="workflow-progress"]');
    await expect(card.getByText("audit-auth", { exact: true })).toBeVisible();
    if (state === "details") {
      await card.getByRole("button", { name: "Details" }).click();
      await expect(
        page.getByRole("region", { name: "Frozen workflow source" }).locator("code"),
      ).toBeVisible();
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page
      .locator('[data-slot="session-pane"]')
      .filter({ has: page.locator('[data-slot="workflow-progress"]') });
  },
};

const workflowChoiceSource = [
  "export const meta = {",
  '  name: "audit-auth",',
  '  description: "Review authentication and verify findings.",',
  '  phases: ["Review routes", "Verify findings", "Report"],',
  "};",
  'await phase("Review routes");',
  "const reviews = await pipeline(args.groups, group =>",
  "  agent(`Review authentication in ${group}.`, { label: group }));",
  'await phase("Verify findings");',
  "const verified = await pipeline(reviews, review =>",
  "  review === null ? null : agent(`Verify ${JSON.stringify(review)}`));",
  'await phase("Report");',
  "return { reviews, verified };",
].join("\n");

const workflowChoiceScenario: VisualCaptureScenario = {
  ...assistantMarkdownCode,
  name: "workflow-choice",
  description: "Pre-launch dynamic workflow execution choice with inspectable frozen source",
  states: ["default", "script"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    const applicationFile = join(paths.cakeHome, "state", "application.json");
    const seeded = JSON.parse(await readFile(applicationFile, "utf8"));
    await writeFile(
      applicationFile,
      JSON.stringify({
        version: 6,
        data: {
          ...defaultApplicationState(),
          projects: seeded.projects,
          experimentalFeatures: { dynamicWorkflows: true },
        },
      }),
    );
    const file = join(
      workspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
      "1970-01-01T00-00-00-000Z_visual-assistant-markdown-code.jsonl",
    );
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const entry of entries) {
      if (entry.message?.role === "user")
        entry.message.content = [
          { type: "text", text: "Audit authentication across our API routes." },
        ];
      if (entry.message?.role === "assistant")
        entry.message.content = [
          {
            type: "text",
            text: "These route reviews are independent. A background workflow can review them in parallel, verify the findings, and return one consolidated report. You can choose workflow execution or continue normally below.",
          },
        ];
    }
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("The workflow choice capture requires Electron");
    await page.getByRole("combobox", { name: "Message", exact: true }).waitFor({ timeout: 20_000 });
    // Wait for the owner's authoritative transcript, not just its staged composer.
    await page
      .getByText(
        "These route reviews are independent. A background workflow can review them in parallel, verify the findings, and return one consolidated report. You can choose workflow execution or continue normally below.",
        { exact: true },
      )
      .waitFor({ timeout: 20_000 });
    await emitRendererEvent(application, {
      type: "ui-request",
      requestId: "af8396cb-8901-4ef7-bd6b-9f63104344ce",
      uiRequestId: "de0f4bcf-cba6-4963-92b0-62a0bc67b0fa",
      sessionId: "visual-assistant-markdown-code",
      kind: "workflow-choice",
      title: "audit-auth",
      message: "Review authentication and verify findings.",
      workflow: {
        ownerSessionId: "visual-assistant-markdown-code",
        program: {
          meta: {
            name: "audit-auth",
            description: "Review authentication and verify findings.",
            phases: ["Review routes", "Verify findings", "Report"],
          },
          source: workflowChoiceSource,
          sourcePath: ".cake/workflows/audit-auth.js",
          args: { groups: ["src/routes/auth", "src/routes/api"] },
        },
      },
    });
    const choice = page.getByRole("alertdialog", { name: "audit-auth" });
    await expect(choice).toBeVisible();
    await expect(choice.getByRole("button", { name: "Continue normally" })).toBeFocused();
    if (state === "script") {
      await choice.getByRole("button", { name: "View script" }).click();
      const source = choice.getByRole("region", { name: "Proposed workflow script" });
      await expect
        .poll(() => source.locator("code").first().locator(":scope > span").allTextContents())
        .toEqual(workflowChoiceSource.split("\n"));
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.getByRole("alertdialog", { name: "audit-auth" });
  },
};

const conversationEntryOrigin = "http://127.0.0.1:9";

const contextPillsScenario: VisualCaptureScenario = {
  ...assistantMarkdownCode,
  name: "context-pills",
  description: "Grouped prompt sources and inspectable injected context in horizontal pills",
  states: ["default", "expanded", "sources"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    await writeFile(
      join(paths.project, "AGENTS.md"),
      "## Project instructions\n\nUse shared UI primitives and keep the conversation primary.",
    );
    const skillDirectory = join(paths.cakeHome, "pi", "skills", "context-fixture");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: context-fixture\ndescription: Context disclosure fixture.\n---\n\nRead detailed instructions only when relevant.\n",
    );
    const timestamp = new Date(0).toISOString();
    const file = join(
      workspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
      "1970-01-01T00-00-00-000Z_visual-assistant-markdown-code.jsonl",
    );
    const entries = [
      {
        type: "message",
        id: "context-user",
        parentId: "assistant-1",
        timestamp,
        message: {
          role: "user",
          timestamp: 2,
          content: addResponseModeReminder(
            addPresentationModeReminder(
              "Show me everything being added to my context.",
              "normal",
              "draw",
            ),
            "text",
          ),
        },
      },
      {
        type: "custom_message",
        id: "cake-context",
        parentId: "context-user",
        timestamp,
        customType: "Cake reminder",
        display: false,
        content:
          "## Session guidance\n\nCake injected this **model-facing context**.\n\n- Keep instructions inspectable.\n- Preserve the original transcript.",
      },
      {
        type: "custom_message",
        id: "extension-context",
        parentId: "cake-context",
        timestamp,
        customType: "Extension reminder",
        display: false,
        content: "Extension-injected context is inspectable too.",
      },
    ];
    await writeFile(
      file,
      `${await readFile(file, "utf8")}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  },
  async prepare(page, state) {
    await expect(
      page.locator('[data-slot="context-group"]').last().locator('[data-slot="context-pill"]'),
    ).toHaveCount(4, { timeout: 20_000 });
    const sources = page.locator('[data-slot="context-group"]').first();
    await expect(sources.locator('[data-slot="context-pill"] button')).toHaveText([
      "System",
      "Tools",
      "Skills",
      "AGENTS.md",
    ]);
    const system = sources.getByRole("button", { name: "System", exact: true });
    await system.click();
    await expect(page.locator('[data-part-id="runtime-system-prompt-system"]')).toContainText(
      "coding assistant",
    );
    await expect(
      page.getByRole("heading", { name: "Cake desktop environment", exact: true }),
    ).toBeVisible();
    await system.click();
    const tools = sources.getByRole("button", { name: "Tools", exact: true });
    await tools.click();
    await expect(page.locator('[data-part-id="runtime-system-prompt-tools"]')).toContainText(
      '"name": "read"',
    );
    await tools.click();
    const skills = sources.getByRole("button", { name: "Skills", exact: true });
    await skills.click();
    await expect(page.locator('[data-part-id="runtime-system-prompt-skills"]')).toContainText(
      "context-fixture",
    );
    await skills.click();
    if (state === "sources") {
      await sources.getByRole("button", { name: "AGENTS.md", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Project instructions", exact: true }),
      ).toBeVisible();
    }
    if (state === "expanded") {
      await page.getByRole("button", { name: "Cake reminder", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Session guidance" })).toBeVisible();
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
  },
  region(page, state) {
    const groups = page.locator('[data-slot="context-group"]');
    return state === "sources" ? groups.first() : groups.last();
  },
};

const conversationEntryScenario: VisualCaptureScenario = {
  name: "conversation-entry",
  description:
    "Actual Project Session composer with conversation-mode entry and speech error toast",
  states: ["default", "hover", "error-toast"],
  async seed(paths, theme) {
    const sessionId = "visual-conversation-entry";
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.cakeHome, "pi", "settings.json"),
      JSON.stringify({ defaultProvider: "conversation-visual", defaultModel: "fixture" }),
    );
    await writeFile(join(paths.cakeHome, "pi", "auth.json"), "{}");
    // No submission occurs; the dummy loopback endpoint cannot invoke a billed provider.
    await writeFile(
      join(paths.cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          "conversation-visual": {
            name: "Visual fixture",
            baseUrl: `${conversationEntryOrigin}/v1`,
            apiKey: "fixture-only",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Visual fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(paths.userData, "window-state.json"),
      JSON.stringify({
        projectPath: paths.project,
        selectedSessionId: sessionId,
        activeConversation: { kind: "project-session", workspacePath: paths.project, sessionId },
        recentProjectPaths: [paths.project],
        draft: "",
        draftsBySession: {},
        theme,
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: paths.project, name: "Project", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
        trustedProjectPaths: [],
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          provider: "conversation-visual",
          modelId: "fixture",
        },
        {
          type: "message",
          id: "history",
          parentId: "model",
          timestamp,
          message: { role: "user", content: "Let's discuss this project.", timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("Conversation entry requires native Electron");
    expect(await installLocalModelHttpGuard(application, conversationEntryOrigin)).toEqual({
      allowedOrigin: conversationEntryOrigin,
      installed: true,
    });
    const composer = page.locator(".workbench-composer");
    await expect(composer.getByLabel("Message", { exact: true })).toBeVisible({ timeout: 20_000 });
    const entry = composer.getByRole("button", { name: "Enter conversation mode", exact: true });
    await expect(entry).toBeEnabled();
    await expect(
      page.locator("strong").filter({ hasText: "Let's discuss this project." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Exit conversation mode", exact: true }),
    ).toHaveCount(0);
    await page.waitForFunction(() => document.fonts.status === "loaded");
    if (state === "error-toast") {
      await entry.click();
      await expect(
        page.getByRole("alert").filter({ hasText: "Conversation mode unavailable" }),
      ).toBeVisible();
      await page.mouse.move(1, 1);
    } else if (state === "hover") {
      await entry.hover();
      await expect(
        page.getByRole("tooltip", { name: "Enter conversation mode", exact: true }),
      ).toBeVisible();
    } else {
      await page.mouse.move(1, 1);
    }
  },
  region(page) {
    return page
      .locator(".workbench-composer")
      .or(page.getByRole("alert").filter({ hasText: "Conversation mode unavailable" }))
      .last();
  },
};

const conversationCountdownScenario: VisualCaptureScenario = {
  name: "conversation-countdown",
  description:
    "Voice preparation spinner and live draft with the cancellable circular send countdown",
  states: ["default", "preparing", "cancelled"],
  environment: (paths) => ({
    CAKE_SMOKE_DICTATION_HELPER: join(paths.userData, "visual-dictation"),
  }),
  async seed(paths, theme) {
    await conversationEntryScenario.seed(paths, theme);
    const model = join(paths.userData, "dictation", "model");
    await mkdir(model, { recursive: true });
    await writeFile(
      join(paths.userData, "dictation", "settings.json"),
      JSON.stringify({ modelPath: model }),
    );
    const helper = join(paths.userData, "visual-dictation");
    await writeFile(
      helper,
      `#!${process.execPath}\nconst readline = require('node:readline');\nprocess.stdout.write(JSON.stringify({ready:true})+'\\n');\nreadline.createInterface({input:process.stdin}).on('line', () => process.stdout.write(JSON.stringify({text:'Let’s refine the voice conversation together.'})+'\\n'));\n`,
    );
    await chmod(helper, 0o755);
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("Conversation countdown requires Electron");
    await conversationEntryScenario.prepare(page, "default", application);
    await installSpeechHttpFixture(application);
    // Smoke windows start hidden. Presentation captures must never show or focus them.
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByLabel("ElevenLabs API key").fill("visual-fixture-only");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(page.getByLabel("ElevenLabs API key")).toHaveValue("");
    await page.getByRole("button", { name: "Refresh voices" }).click();
    await expect(
      page.getByLabel("Voice", { exact: true }).locator("option", { hasText: "Fixture voice" }),
    ).toHaveCount(1);
    await page.getByLabel("Voice", { exact: true }).selectOption("fixture-voice");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page
      .locator('[data-navigation-item][data-session-id="visual-conversation-entry"]')
      .click();
    // Only external audio is replaced. The real capture, recognition, Store and Chat remain in use.
    await page.evaluate((preparing) => {
      const source = new AudioContext();
      const stream = source.createMediaStreamDestination().stream;
      navigator.mediaDevices.getUserMedia = async () => {
        if (preparing) await new Promise(() => {});
        return stream;
      };
      const WorkletNode = AudioWorkletNode;
      globalThis.AudioWorkletNode = class extends WorkletNode {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options);
          this.port.addEventListener("message", (event) => {
            if (event.isTrusted) event.stopImmediatePropagation();
          });
          Object.assign(globalThis, { visualConversationProcessor: this });
        }
      };
    }, state === "preparing");
    await page.getByRole("button", { name: "Enter conversation mode" }).click();
    if (state === "preparing") {
      const control = page.getByRole("button", { name: "Preparing conversation mode" });
      await expect(control).toHaveAttribute("aria-busy", "true");
      await page
        .getByRole("combobox", { name: "Message", exact: true })
        .fill("Let’s refine the voice conversation together.");
      await page.mouse.move(1, 1);
      return;
    }
    await expect(page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await page.evaluate(() => {
      const processor = Reflect.get(globalThis, "visualConversationProcessor") as AudioWorkletNode;
      for (let i = 0; i < 8; i++)
        processor.port.dispatchEvent(
          new MessageEvent("message", { data: new Float32Array(1600).fill(0.1) }),
        );
    });
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveValue(
      "Let’s refine the voice conversation together.",
    );
    await page.evaluate(() => {
      const processor = Reflect.get(globalThis, "visualConversationProcessor") as AudioWorkletNode;
      for (let i = 0; i < 12; i++)
        processor.port.dispatchEvent(new MessageEvent("message", { data: new Float32Array(1600) }));
    });
    const cancel = page.getByRole("button", { name: "Cancel automatic send" });
    await expect(cancel).toBeVisible();
    if (state === "cancelled") {
      await cancel.click();
      await expect(page.getByRole("button", { name: "Mute input" })).toBeVisible();
    }
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
    await page.mouse.move(1, 1);
  },
  region: (page) => page.locator(".workbench-composer"),
};

const speechOutputSettingsScenario: VisualCaptureScenario = {
  name: "speech-output-settings",
  description:
    "Actual Speech output Settings with ElevenLabs credentials or local pitch-preserving speed",
  states: ["default", "faster", "configured", "local"],
  seed: conversationEntryScenario.seed,
  async prepare(page, state, application) {
    await conversationEntryScenario.prepare(page, "default", application);
    if (!application) throw new Error("Speech settings capture requires Electron");
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await expect(page.locator("#speech-output-title")).toBeVisible();
    const key = page.getByLabel("ElevenLabs API key", { exact: true });
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveValue("");
    await expect(page.getByText(/No key configured/)).toBeVisible();
    if (state === "configured") {
      // Save a non-secret fixture locally; no voice refresh or provider request.
      await key.fill("visual-fixture-key");
      await page.getByRole("button", { name: "Save key", exact: true }).click();
      await expect(key).toHaveValue("");
      await expect(key).toHaveAttribute("placeholder", "••••••••••••••••");
      await expect(page.getByRole("button", { name: "Save key", exact: true })).toBeDisabled();
    }
    const slider = page.getByRole("slider", { name: "Speaking speed" });
    await expect(slider).toBeVisible();
    if (state === "local") {
      await page.getByLabel("Speech provider").selectOption("pocket-tts");
      await expect(page.getByText(/Speaking speed is adjusted locally/)).toBeVisible();
    }
    if (state === "faster" || state === "local") {
      await slider.focus();
      await slider.press("End");
      await expect(slider).toHaveValue(state === "local" ? "2" : "1.2");
    }
    await slider.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.locator("#settings-content-scroll");
  },
};

const experimentalSettingsScenario: VisualCaptureScenario = {
  name: "experimental-settings",
  description: "Experimental Settings with the default-off dynamic workflow toggle",
  states: ["default", "enabled"],
  seed: assistantMarkdownCode.seed,
  async prepare(page, _state, application) {
    await assistantMarkdownCode.prepare(page, "default", application);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Experimental/ }).click();
    const toggle = page.getByRole("switch", { name: "Dynamic workflows" });
    await expect(toggle).not.toBeChecked();
    if (_state === "enabled") {
      await toggle.click();
      await expect(toggle).toBeChecked();
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: (page) => page.locator("#settings-content-scroll"),
};

const screenCaptureSettingsScenario: VisualCaptureScenario = {
  name: "screen-capture-settings",
  description: "Screen capture shortcut, image resizing, and crop/annotation instructions",
  states: ["default"],
  seed: assistantMarkdownCode.seed,
  async prepare(page, state, application) {
    await assistantMarkdownCode.prepare(page, state, application);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
    await expect(page.locator("#screen-capture-title")).toBeVisible();
    await expect(page.getByLabel("Maximum image dimension")).toHaveValue("2048");
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.locator("#settings-content-scroll");
  },
};

const captureOverlayRegions = new WeakMap<Page, Locator>();
const screenCaptureOverlayScenario: VisualCaptureScenario = {
  name: "screen-capture-overlay",
  description: "Compact movable capture strip, sidebar destination rows, and target-first arrows",
  states: ["default", "destination", "new-session", "annotate"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    const otherProject = join(paths.project, "other-project");
    await mkdir(otherProject, { recursive: true });
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "Capture Project",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
          {
            path: otherProject,
            name: "Other Project",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [paths.project, otherProject],
      }),
    );
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("Screen capture requires Electron");
    await assistantMarkdownCode.prepare(page, "default", application);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    // Fake only the native still. Never read the user's desktop or show/focus a window.
    await application.evaluate(
      ({ desktopCapturer, nativeImage, screen, systemPreferences }, size) => {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        screen.getDisplayNearestPoint = () => ({
          ...display,
          size,
          bounds: { x: 0, y: 0, ...size },
          scaleFactor: 1,
        });
        const bitmap = Buffer.alloc(size.width * size.height * 4);
        for (let index = 0; index < bitmap.length; index += 4) {
          bitmap[index] = 90;
          bitmap[index + 1] = 100;
          bitmap[index + 2] = 110;
          bitmap[index + 3] = 255;
        }
        const image = nativeImage.createFromBitmap(bitmap, size);
        desktopCapturer.getSources = async () => [
          {
            id: "screen:fixture",
            name: "Fixture display",
            display_id: String(display.id),
            thumbnail: image,
            appIcon: nativeImage.createEmpty(),
          },
        ];
        systemPreferences.getMediaAccessStatus = () => "granted";
      },
      dimensions,
    );
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
    const opened = application.waitForEvent("window");
    await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
    const overlay = await opened;
    const toolbar = overlay.getByRole("toolbar", { name: "Screen capture tools" });
    await expect(overlay.getByRole("button", { name: "Attach full display" })).toBeEnabled();
    await expect
      .poll(() =>
        overlay.locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width),
      )
      .toBe(dimensions.width);
    if (state === "destination" || state === "new-session") {
      await overlay.getByRole("button", { name: "Screenshot destination" }).click();
      if (state === "new-session") {
        await overlay.getByRole("button", { name: "New chat", exact: true }).click();
      }
    }
    if (state === "annotate") {
      await overlay.getByRole("button", { name: "Annotate", exact: true }).click();
      await overlay.mouse.move(dimensions.width * 0.3, dimensions.height * 0.4);
      await overlay.mouse.down();
      await overlay.mouse.move(dimensions.width * 0.6, dimensions.height * 0.65);
      await overlay.mouse.up();
      await expect(overlay.getByRole("textbox", { name: "Arrow label" })).toBeFocused();
      await overlay.keyboard.type("Point to this first");
      await overlay.keyboard.press("Enter");
    }
    await overlay.waitForFunction(() => document.fonts.status === "loaded");
    await overlay.mouse.move(1, 1);
    captureOverlayRegions.set(
      page,
      state === "default"
        ? toolbar
        : state === "annotate"
          ? overlay.getByLabel("Screen capture", { exact: true })
          : overlay.getByRole("dialog", { name: "Screenshot destination" }),
    );
  },
  region(page) {
    const region = captureOverlayRegions.get(page);
    if (!region) throw new Error("Screen capture overlay is missing");
    return region;
  },
};

const inlineLinks: VisualCaptureScenario = {
  name: "inline-links",
  description: "Consistent artifact, workspace, website, and session links in prose",
  states: ["default", "hover"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    const sessionId = "visual-assistant-markdown-code";
    const sessionFile = join(
      workspaceSessionDirectory(paths.project, join(paths.cakeHome, "pi", "sessions")),
      `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`,
    );
    const entries = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const message = entries.find((entry) => entry.id === "assistant-1");
    message.message.content = [
      {
        type: "text",
        text: [
          "## Links stay in the conversation",
          "",
          "Created [Collaboration requirements](cake://artifact/visual-link-report), with confirmed requirements and open decisions.",
          "",
          "Review [the implementation](src/main.ts#L12-L24), read [the website](https://example.com/docs), or return to [this session](cake://session/visual-assistant-markdown-code).",
          "",
          "Every destination uses the same clear link style. Hover a link to see where it goes.",
        ].join("\n"),
      },
    ];
    await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await seedArtifact(
      paths,
      {
        protocol: "cake.artifact/v1",
        id: "visual-link-report",
        sessionId,
        revision: 1,
        kind: "markdown",
        title: "Collaboration requirements",
        payload: {
          markdown: "# Collaboration requirements\n\nConfirmed requirements and open decisions.",
        },
        fallback: { markdown: "Collaboration requirements" },
      },
      new Date(0).toISOString(),
    );
  },
  async prepare(page, state) {
    const artifact = page.getByRole("link", { name: "Collaboration requirements", exact: true });
    await expect(artifact).toBeVisible();
    await expect(page.getByRole("link", { name: "the implementation" })).toBeVisible();
    await expect(page.getByRole("link", { name: "the website" })).toBeVisible();
    await expect(page.getByRole("link", { name: "this session" })).toBeVisible();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    if (state === "hover") {
      await artifact.hover();
      await expect(page.getByRole("tooltip")).toHaveText("cake://artifact/visual-link-report");
      await expect(page.getByRole("tooltip")).toBeVisible();
    } else {
      await page.mouse.move(1, 1);
    }
  },
  region(page) {
    return page
      .locator('[data-slot="message-content"]')
      .filter({ has: page.getByRole("link", { name: "the implementation" }) });
  },
};

async function seedArtifactScenario(
  paths: ScenarioFixturePaths,
  theme: "light" | "dark",
  artifact: CakeArtifactV1,
  inline = false,
) {
  const sessionId = artifact.sessionId;
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = workspaceSessionDirectory(
    paths.project,
    join(paths.cakeHome, "pi", "sessions"),
  );
  await Promise.all([
    mkdir(paths.userData, { recursive: true }),
    mkdir(paths.project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(paths.cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(paths.userData, "window-state.json"),
    JSON.stringify({
      projectPath: paths.project,
      selectedSessionId: sessionId,
      activeConversation: {
        kind: "project-session",
        workspacePath: paths.project,
        sessionId,
      },
      recentProjectPaths: [paths.project],
      draft: "",
      draftsBySession: {},
      theme,
    }),
  );
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: paths.project,
          name: "Cake architecture",
          addedAt: timestamp,
          lastOpenedAt: timestamp,
        },
      ],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${[
      { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
      {
        type: "message",
        id: "user-architecture",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Explain how Cake's desktop architecture works." }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-architecture",
        parentId: "user-architecture",
        timestamp,
        message: {
          role: "assistant",
          content: [
            ...(inline
              ? [
                  {
                    type: "toolCall",
                    id: "inline-publication",
                    name: "cake",
                    arguments: { command: "widgets.present", input: {} },
                  },
                ]
              : []),
            {
              type: "text",
              text: inline
                ? `The [saved visualization](cake://artifact/${artifact.id}) is also available here:\n\n![${artifact.title}](cake://artifact/${artifact.id}@r${artifact.revision})`
                : "Open the source-backed explanation to explore Cake’s process boundaries and who owns the conversation.",
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "visual-fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: inline ? "toolUse" : "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await seedArtifact(paths, artifact, timestamp);
  if (inline) {
    const file = join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    const transcript = await readFile(file, "utf8");
    await writeFile(
      file,
      transcript +
        [
          {
            type: "message",
            id: "inline-result",
            parentId: "assistant-architecture",
            timestamp,
            message: {
              role: "toolResult",
              toolCallId: "inline-publication",
              toolName: "cake",
              content: [{ type: "text", text: "Published" }],
              details: { artifactId: artifact.id, artifactRevision: artifact.revision },
              isError: false,
              timestamp: 2,
            },
          },
          {
            type: "custom",
            id: "inline-pointer",
            parentId: "inline-result",
            timestamp,
            customType: "cake.artifact/v1",
            data: {
              protocol: "cake.artifact/v1",
              lineageId: artifact.id,
              revision: artifact.revision,
              kind: artifact.kind,
              digest: sha256(`${JSON.stringify(artifact, null, 2)}\n`),
              title: artifact.title,
              stableRef: `cake://artifact/${artifact.id}`,
              exactRef: `cake://artifact/${artifact.id}@r${artifact.revision}`,
              origin: {
                assistantEntryId: "assistant-architecture",
                toolCallId: "inline-publication",
              },
            },
          },
          {
            type: "message",
            id: "inline-finished",
            parentId: "inline-pointer",
            timestamp,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Both views use the same saved artifact." }],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "visual-fixture",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 3,
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") +
        "\n",
    );
  }
}

const inlineArtifactScenario: VisualCaptureScenario = {
  name: "inline-artifact",
  description: "One saved visualization, expanded inline by default with collapse and fullscreen",
  states: ["default", "collapsed", "fullscreen", "popup", "pane"],
  async seed(paths, theme) {
    await seedArtifactScenario(
      paths,
      theme,
      {
        protocol: "cake.artifact/v1",
        id: "inline-visual",
        sessionId: "visual-inline-artifact",
        revision: 1,
        kind: "widget",
        title: "Inline visualization",
        payload: {
          language: "react",
          brief: "An interactive comparison using Cake's theme tokens",
          generationSessionId: "visual-inline-generation",
          source: `import React, { useState } from "react";
export default function Visual() {
  const [expanded, setExpanded] = useState(false);
  return <main style={{ color: "var(--foreground,CanvasText)", fontFamily: "var(--font-sans,system-ui)" }}>
    <h2 style={{ margin: "0 0 12px", fontSize: 20 }}>One artifact, two views</h2>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
      {[["Conversation", "Explain in context"], ["Artifact", "Revisit and explore"]].map(([name, text]) =>
        <section key={name} style={{ padding: 16, border: "1px solid var(--border,GrayText)", borderRadius: 12 }}>
          <strong>{name}</strong><p>{text}</p>
        </section>)}
    </div>
    <button onClick={() => setExpanded(!expanded)} style={{ marginTop: 12, padding: 8, color: "var(--foreground,CanvasText)", background: "var(--muted,Canvas)", border: "1px solid var(--border,GrayText)" }}>
      {expanded ? "Hide detail" : "Explore detail"}
    </button>
    {expanded && <section style={{ minHeight: 480, paddingTop: 16 }}>Expanded detail stays in this view.</section>}
  </main>;
}`,
        },
        fallback: {
          markdown: "One durable artifact can appear in the conversation and in the library.",
        },
        interaction: { mode: "present" },
      },
      true,
    );
  },
  async prepare(page, state) {
    const disclosure = page.locator('[data-slot="artifact-disclosure"]').first();
    await expect(disclosure).toBeVisible();
    await expect(
      disclosure
        .locator("iframe")
        .contentFrame()
        .getByRole("heading", { name: "One artifact, two views" }),
    ).toBeVisible();
    if (state === "popup") {
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await expect(
        page
          .getByRole("dialog", { name: "Artifacts", exact: true })
          .getByRole("button", { name: /Inline visualization/ }),
      ).toBeVisible();
    }
    if (state === "pane") {
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await page
        .getByRole("dialog", { name: "Artifacts", exact: true })
        .getByRole("button", { name: /Inline visualization/ })
        .click();
      const pane = page.getByRole("complementary", { name: "Artifact", exact: true });
      await expect(pane).toBeVisible();
      await expect(
        pane
          .locator("iframe")
          .contentFrame()
          .getByRole("heading", { name: "One artifact, two views" }),
      ).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Artifacts", exact: true })).not.toBeAttached();
    }
    if (state === "collapsed")
      await disclosure.getByRole("button", { name: "Inline visualization Collapse" }).click();
    if (state === "fullscreen")
      await disclosure
        .getByRole("button", { name: "View Inline visualization fullscreen" })
        .click();
    await page.mouse.move(1, 1);
  },
  region(page, state) {
    return state === "pane"
      ? page.locator('[data-slot="artifact-pane-layout"]')
      : state === "popup" || state === "fullscreen"
        ? page.getByRole("dialog")
        : page.locator('[data-slot="artifact-disclosure"]').first();
  },
};

const messageBoardScenario: VisualCaptureScenario = {
  name: "family-message-board",
  description:
    "Shared family artifact with expandable entries and independent notification/read receipts",
  states: ["default", "expanded", "receipts"],
  seed: (paths, theme) => seedMessageBoardFixture(paths, theme),
  async prepare(page, state) {
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await page
      .getByRole("dialog", { name: "Artifacts", exact: true })
      .getByRole("button", { name: /Editor isolation/ })
      .click();
    const board = page.locator(`[data-artifact-id="${MESSAGE_BOARD_FIXTURE_ID}"]`);
    await board.getByRole("button", { name: /^#1 · Editor isolation/ }).waitFor();
    if (state !== "default") {
      await board.getByRole("button", { name: /^#1 · Editor isolation/ }).click();
      await board.getByText("Finding:", { exact: true }).waitFor();
    }
    if (state === "receipts") {
      await board.getByRole("button", { name: "Agent receipts for #1" }).click();
      await board.getByText(/Notified: .*Read: Not recorded/).waitFor();
    }
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.locator(`[data-artifact-id="${MESSAGE_BOARD_FIXTURE_ID}"]`);
  },
};

const requestExplanationScenario: VisualCaptureScenario = {
  name: "cake-request-explanation",
  description: "Bespoke sandboxed React explanation of Cake's prompt and authority boundaries",
  states: ["default", "selected", "fullscreen"],
  async seed(paths, theme) {
    const source = await readFile(
      resolve(import.meta.dirname, "../../tests/fixtures/explanations/cake-request.react.txt"),
      "utf8",
    );
    await seedArtifactScenario(paths, theme, {
      protocol: "cake.artifact/v1",
      id: "cake-request-explanation",
      sessionId: "visual-cake-request-explanation",
      revision: 1,
      kind: "widget",
      title: "A prompt through Cake",
      payload: {
        language: "react",
        source,
        brief:
          "Explain the current Electron process and authority boundaries. Manually authored visual prototype; not a generated call trace.",
        generationSessionId: "manual-visual-prototype",
      },
      fallback: {
        markdown:
          "Cake's sandboxed renderer sends intent over the narrow preload RPC transport. Main owns privileged operations and embeds Pi. Pi owns the agent loop and transcript; renderer Models project validated updates.",
      },
      interaction: { mode: "present" },
    });
  },
  async prepare(page, state) {
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await page.getByRole("button", { name: "A prompt through Cake" }).click();
    let frame = page.frameLocator('iframe[title="A prompt through Cake"]');
    await frame.getByRole("heading", { name: "The conversation crosses." }).waitFor();
    if (state === "fullscreen") {
      await page.getByRole("button", { name: "View A prompt through Cake fullscreen" }).click();
      frame = page.frameLocator('iframe[title="A prompt through Cake fullscreen"]');
      await frame.getByRole("heading", { name: "The conversation crosses." }).waitFor();
    }
    if (state !== "default") {
      await frame.getByRole("button", { name: "04 Run" }).click();
      await frame.getByRole("heading", { name: "Pi runs the agent." }).waitFor();
      await frame.getByRole("button", { name: "Inspect evidence" }).click();
    }
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.getByRole("dialog").or(page.locator('[data-artifact-kind="widget"]')).last();
  },
};

const drawMermaidArchitectureScenario: VisualCaptureScenario = {
  name: "draw-mermaid-architecture",
  description: "Named native editable Mermaid architecture diagram in Cake Draw",
  states: ["default"],
  async seed(paths, theme) {
    const sessionId = "visual-draw-mermaid-architecture";
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      JSON.stringify({
        projectPath: paths.project,
        selectedSessionId: sessionId,
        activeConversation: {
          kind: "project-session",
          workspacePath: paths.project,
          sessionId,
        },
        recentProjectPaths: [paths.project],
        draft: "",
        draftsBySession: {},
        theme,
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "Cake Draw architecture",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [],
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      `${[
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "message",
          id: "user-draw",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Diagram Cake's desktop architecture." }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
  },
  async prepare(page, _state, application) {
    if (!application) throw new Error("The Draw visual scenario requires its Electron application");
    await page.getByRole("combobox", { name: "Message", exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    await page.getByRole("region", { name: "Cake Draw whiteboard" }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.locator(".excalidraw__canvas.interactive").waitFor({
      state: "visible",
      timeout: 20_000,
    });
    const event: CakeEvent = {
      type: "draw-control-requested",
      sessionId: "visual-draw-mermaid-architecture",
      drawRequestId: "00000000-0000-4000-8000-000000000099",
      invocation: {
        _tag: "Mermaid",
        id: "cake-desktop-architecture",
        replace: true,
        diagram: drawMermaidArchitecture,
      },
    };
    await application.evaluate((_electron, input) => {
      const emit = (
        globalThis as typeof globalThis & {
          cakeSmokeEmitRendererEvent?: (event: CakeEvent) => void;
        }
      ).cakeSmokeEmitRendererEvent;
      if (!emit) throw new Error("Cake smoke event source is unavailable");
      emit(input);
    }, event);
    try {
      await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled({ timeout: 20_000 });
    } catch (cause) {
      const body = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ").slice(0, 2_000);
      throw new Error(`Mermaid diagram insertion did not complete. Visible Cake UI: ${body}`, {
        cause,
      });
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.waitForTimeout(500);
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.getByRole("region", { name: "Cake Draw whiteboard" });
  },
};

const drawCompositionScenario: VisualCaptureScenario = {
  name: "draw-composition",
  description: "Compact authoring flow with a native frame and measured node labels",
  states: ["default"],
  seed: drawMermaidArchitectureScenario.seed,
  async prepare(page, _state, application) {
    if (!application) throw new Error("The Draw scenario requires Electron");
    await page.getByRole("combobox", { name: "Message", exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    await page.locator(".excalidraw__canvas.interactive").waitFor({ timeout: 20_000 });
    const response = await application.evaluate(async () => {
      const control = Reflect.get(globalThis, "cakeSmokeDrawControl") as (
        sessionId: string,
        invocation: unknown,
      ) => Promise<{ ok: boolean; message?: string }>;
      return control("visual-draw-mermaid-architecture", {
        _tag: "Apply",
        operations: [
          {
            type: "flow",
            nodes: [
              { id: "shape:cake", text: "Cake\nDesktop + UI" },
              { id: "shape:pi", text: "Pi\nAgent + history" },
            ],
            frame: { id: "shape:application", title: "Cake application" },
          },
        ],
      });
    });
    if (!response.ok) throw new Error(response.message);
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: drawMermaidArchitectureScenario.region,
};

const cakePromptsSettingsScenario: VisualCaptureScenario = {
  name: "cake-prompts-settings",
  description: "Editable Cake workflow prompts in Settings",
  states: ["default", "lower"],
  async seed(paths, theme) {
    const timestamp = new Date(0).toISOString();
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      JSON.stringify({
        projectPath: paths.project,
        recentProjectPaths: [paths.project],
        draft: "",
        draftsBySession: {},
        theme,
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "visual-capture-project",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [],
      }),
    );
  },
  async prepare(page, state) {
    await page.getByRole("button", { name: "Open settings", exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const prompts = page.getByRole("button", { name: "Instructions & prompts" });
    await prompts.waitFor({ state: "visible", timeout: 20_000 });
    await prompts.click();
    await page.getByRole("textbox", { name: "Commit before merge" }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    if (state === "lower")
      await page.getByRole("textbox", { name: "Squash commit message" }).scrollIntoViewIfNeeded();
  },
  region(page) {
    return page.locator("#settings-content-scroll");
  },
};

const mcpSettingsScenario: VisualCaptureScenario = {
  name: "mcp-settings",
  description: "Backend-owned native MCP configuration and masked advanced editor",
  states: ["default", "editor"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    await mkdir(join(paths.cakeHome, "pi"), { recursive: true });
    await writeFile(
      join(paths.cakeHome, "pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          documentation: {
            url: "https://docs.example.com/mcp",
            enabled: false,
            description: "Search the product documentation",
            exposure: "deferred",
            headers: { Authorization: "${DOCS_TOKEN}" },
            toolExposure: { search: "direct", "delete_*": "hidden" },
          },
        },
      }),
    );
  },
  async prepare(page, state) {
    await assistantMarkdownCode.prepare(page, "default");
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^MCP servers/ }).click();
    const edit = page.getByRole("button", { name: "Edit documentation", exact: true });
    await edit.waitFor({ state: "visible", timeout: 20_000 });
    if (state === "editor") {
      await edit.click();
      await page
        .getByRole("textbox", { name: "MCP advanced configuration", exact: true })
        .scrollIntoViewIfNeeded();
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: cakePromptsSettingsScenario.region,
};

const appearanceSettingsScenario: VisualCaptureScenario = {
  name: "appearance-settings",
  description: "Session-only sidebar character preference in Cake Appearance settings",
  states: ["default", "characters"],
  seed: assistantMarkdownCode.seed,
  async prepare(page, state) {
    await assistantMarkdownCode.prepare(page, "default");
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Show session characters" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    if (state === "characters") {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    }
    await toggle.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: cakePromptsSettingsScenario.region,
};

const cakeChatSidebarUnread: VisualCaptureScenario = {
  name: "cake-chat-sidebar-unread",
  description:
    "Permanent coordinator's persisted unread status alongside ordinary Project Sessions",
  states: ["default"],
  async seed(paths, theme) {
    await cakeChatScenario.seed(paths, theme);
    const file = join(paths.cakeHome, "state", "application.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({ ...state, unreadSessionIds: ["ca4ec4a7-0000-4000-8000-000000000001"] }),
    );
  },
  async prepare(page) {
    await assistantMarkdownCode.prepare(page, "default");
    await expect(
      page.locator('[data-slot="cake-chat-group"]').getByRole("img", { name: "Ready, unread" }),
    ).toBeVisible();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: (page) => page.locator('[data-slot="sidebar"]'),
};

const cakeChatScenario: VisualCaptureScenario = {
  name: "cake-chat",
  description:
    "Permanent coordinator with original history, memory settings and outbound request inspection",
  states: ["default", "settings", "inspector"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    const directory = join(paths.cakeHome, "pi", "global-chat");
    await mkdir(directory, { recursive: true });
    const texts = [
      "I prefer coding tasks to run in their own worktrees.",
      "I'll coordinate the work here and use independent Project Sessions for implementation.",
      "Will I still see my original conversation history?",
      "Yes. Your original messages and replies remain visible here. The summary tree is used behind the scenes to give the model a smaller history view.",
    ];
    const storage = await openNodeSqliteStorage(join(directory, "coordinator.sqlite"));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit(async (tx) => {
        for (const [index, text] of texts.entries()) {
          if (index % 2 === 0) {
            await tx.appendEntry(UserEntry, root.id, {
              model: [{ role: "user", content: [{ type: "text", text }], timestamp: index }],
            });
          } else {
            await tx.appendEntry(AssistantEntry, root.id, {
              model: [
                {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  timestamp: index,
                  api: "anthropic-messages",
                  provider: "anthropic",
                  model: "visual-fixture",
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
        }
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
  async prepare(page, state) {
    await assistantMarkdownCode.prepare(page, "default");
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText("Cake Chat");
    await expect(
      page.getByText("Will I still see my original conversation history?", { exact: true }),
    ).toBeVisible();
    if (state === "inspector") {
      await page.getByRole("button", { name: "Inspect context", exact: true }).click();
      await expect(page.getByText("No captured context yet.", { exact: true })).toBeVisible();
    }
    if (state === "settings") {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page
        .getByLabel("Settings sections")
        .getByRole("button", { name: /^Cake Chat\b/ })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Cake Chat instructions", exact: true }),
      ).toBeVisible();
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: (page) => page.locator("body"),
};

const cakeChatArtifactScenario: VisualCaptureScenario = {
  name: "cake-chat-artifact",
  description: "Cake Chat session-scoped artifacts opening in an isolated side pane",
  states: ["default"],
  async seed(paths, theme) {
    await cakeChatScenario.seed(paths, theme);
    for (const [id, sessionId] of [
      ["coordinator-report", CAKE_CHAT_SESSION_ID],
      ["unrelated-report", "visual-assistant-markdown-code"],
    ] as const) {
      await seedArtifact(
        paths,
        {
          protocol: "cake.artifact/v1",
          id,
          sessionId,
          revision: 1,
          kind: "markdown",
          title: id === "coordinator-report" ? "Coordinator report" : "Unrelated project report",
          payload: {
            markdown:
              "## Session artifact\n\nThis report belongs to this conversation.\n\n- Keep the conversation visible.\n- Open the library only when browsing all artifacts.",
          },
          fallback: { markdown: "A session-scoped report." },
        },
        new Date(0).toISOString(),
      );
    }
  },
  async prepare(page) {
    await cakeChatScenario.prepare(page, "default");
    await page.getByRole("button", { name: "1 artifacts" }).click();
    const menu = page.getByRole("dialog", { name: "Artifacts", exact: true });
    await expect(
      menu.getByRole("navigation", { name: "Artifact list" }).getByRole("button"),
    ).toHaveCount(1);
    await menu.getByRole("button", { name: /Coordinator report/ }).click();
    await expect(page.getByRole("complementary", { name: "Artifact", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Session artifact", exact: true }),
    ).toBeVisible();
  },
  region: (page) => page.locator("body"),
};

const sessionMessagesScenario: VisualCaptureScenario = {
  name: "session-messages",
  description: "Attributed incoming session report beside genuine system context in both chats",
  states: ["default", "project"],
  async seed(paths, theme) {
    await cakeChatScenario.seed(paths, theme);
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    const sourceId = "visual-report-source";
    const sourceTitle = "Add and globally install manual post-mortem skill";
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sourceId}.jsonl`),
      [
        { type: "session", version: 3, id: sourceId, timestamp, cwd: paths.project },
        { type: "session_info", id: "source-title", parentId: null, timestamp, name: sourceTitle },
        {
          type: "message",
          id: "source-input",
          parentId: "source-title",
          timestamp,
          message: { role: "user", content: "Install the skill.", timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const report = encodeCrossSessionMessage(
      "## Completed\n\nInstalled the **manual post-mortem skill** and verified it is available globally.\n\n- Preserved the existing skills.\n- Focused verification passed.\n\nNo repository merge was performed.",
      {
        version: 1,
        messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
        threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
        sequence: 1,
        expectsResponse: false,
        sender: {
          sessionId: sourceId,
          // Real completion reports can carry an ID-only title when backend catalog lookup fails.
          title: `Session ${sourceId}`,
          kind: "project-session",
          projectName: "Cake",
        },
      },
    );
    const messages = [
      {
        role: "user" as const,
        timestamp: 10,
        content: addResponseModeReminder("Report received below.", "text"),
      },
      { role: "user" as const, timestamp: 11, content: report },
    ];
    const file = join(
      sessionDirectory,
      "1970-01-01T00-00-00-000Z_visual-assistant-markdown-code.jsonl",
    );
    await writeFile(
      file,
      `${await readFile(file, "utf8")}${messages
        .map((message, index) =>
          JSON.stringify({
            type: "message",
            id: `incoming-${index}`,
            parentId: index === 0 ? "assistant-1" : "incoming-0",
            timestamp,
            message,
          }),
        )
        .join("\n")}\n`,
    );
    const storage = await openNodeSqliteStorage(
      join(paths.cakeHome, "pi", "global-chat", "coordinator.sqlite"),
    );
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit(async (tx) => {
        for (const message of messages)
          await tx.appendEntry(UserEntry, root.id, { model: [message] });
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
  async prepare(page, state) {
    await assistantMarkdownCode.prepare(page, "default");
    if (state !== "project") {
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText("Cake Chat");
    }
    await expect(
      page.getByRole("region", { name: "Message from another session" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cake · response mode", exact: true }),
    ).toBeVisible();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: (page) => page.locator(".transcript"),
};

const cakeChatInspectorScenario: VisualCaptureScenario = {
  name: "cake-chat-inspector",
  description:
    "Permanent Cake Chat request inspector showing an actual outbound request to a local deterministic provider",
  states: ["icon", "default", "memory"],
  async seed(paths, theme) {
    await cakeChatScenario.seed(paths, theme);
    return openRequestInspectorFixture(paths);
  },
  async prepare(page, state) {
    await cakeChatScenario.prepare(page, "default");
    if (state === "icon") return;
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await composer.fill("What context will you use to coordinate my next task?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("Request captured by the local inspection fixture.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Inspect context", exact: true }).click();
    const context = page.getByRole("dialog", { name: "Context", exact: true });
    await expect(
      context.getByRole("button", { name: "Copy raw context", exact: true }),
    ).toBeEnabled();
    await expect(context).toContainText("What context will you use to coordinate my next task?");
    if (state === "memory") {
      await context.getByRole("button", { name: "Instructions", exact: true }).click();
      await expect(context).toContainText("<current-time>");
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: (page, state) =>
    state === "icon" ? page.locator('[data-slot="workspace-header"]') : page.locator("body"),
};

const taskInputAttachmentsScenario: VisualCaptureScenario = {
  name: "task-input-attachments",
  description: "Shared screenshot and large-paste attachments with a private text preview",
  states: ["default", "preview", "project"],
  async seed(paths, theme) {
    await cakeChatScenario.seed(paths, theme);
  },
  async prepare(page, state) {
    await assistantMarkdownCode.prepare(page, "default");
    // A screenshot of this isolated fixture, never the user's actual desktop.
    const screenshot = (await page.screenshot({ animations: "disabled", type: "png" })).toString(
      "base64",
    );
    if (state !== "project") {
      await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      await expect(page.locator('[data-slot="workspace-header"] strong')).toHaveText("Cake Chat");
    }
    const input = page.getByRole("combobox", {
      name: state === "project" ? "Message" : "Message Cake Chat",
      exact: true,
    });
    await input.evaluate((element, data) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(
          [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
          "build-screenshot.png",
          { type: "image/png" },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, screenshot);
    await expect(
      page.getByRole("button", { name: "View build-screenshot.png enlarged", exact: true }),
    ).toBeVisible();
    const log = Array.from({ length: 72 }, (_, index) => {
      const time = `10:42:${String(index % 60).padStart(2, "0")}`;
      return index === 14
        ? `[${time}] ERROR build: Cannot resolve './config/runtime.json'`
        : `[${time}] ${index < 14 ? "INFO" : "DEBUG"} build step ${index + 1}: ${index < 14 ? "checking module dependencies" : "collecting diagnostic context"}`;
    }).join("\n");
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, log);
    await expect(input).toHaveValue("");
    await input.fill(
      state === "project"
        ? "Find the cause of this build failure and recommend a fix."
        : "Investigate this build failure in a Project Session.",
    );
    const pastedChip = page.getByRole("button", { name: /^Pasted text/ });
    await expect(pastedChip).toBeVisible();
    if (state === "preview") {
      await pastedChip.click();
      await expect(page.locator('[data-cake-private-preview="true"]')).toContainText(
        "Attachment preview",
      );
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region: (page) => page.locator(".workbench-composer"),
};

const newSessionScenario: VisualCaptureScenario = {
  name: "new-session",
  description: "Searchable Cake Chat and Project destination dialog",
  states: ["default", "hover", "selected-hover", "filtered", "empty"],
  async seed(paths, theme) {
    await cakePromptsSettingsScenario.seed(paths, theme);
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: paths.project, name: "Cake", addedAt: timestamp, lastOpenedAt: timestamp },
          {
            path: resolve(paths.project, "../website"),
            name: "Website",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
          {
            path: resolve(paths.project, "../research"),
            name: "Research",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [],
      }),
    );
  },
  async prepare(page, state) {
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+N" : "Control+N");
    const filter = page.getByRole("combobox", { name: "Filter projects" });
    await expect(filter).toBeFocused();
    if (state === "filtered" || state === "empty")
      await filter.fill(state === "filtered" ? "web" : "missing");
    await page.waitForFunction(() => document.fonts.status === "loaded");
    if (state === "hover") {
      await page.getByRole("option", { name: /^Research/ }).hover();
    } else if (state === "selected-hover") {
      await page.keyboard.press("ArrowDown");
      await page.getByRole("option", { selected: true }).hover();
    } else {
      await page.mouse.move(1, 1);
    }
  },
  region(page) {
    return page.getByRole("dialog", { name: "New session", exact: true }).locator(":scope > div");
  },
};

const sessionSearchScenario: VisualCaptureScenario = {
  name: "session-search",
  description: "Deterministic session title picker across projects or in project focus",
  states: ["default", "filtered", "empty", "focus", "sidebar"],
  async seed(paths, theme) {
    await cakePromptsSettingsScenario.seed(paths, theme);
    const website = resolve(paths.project, "../website");
    const timestamp = new Date(0).toISOString();
    await mkdir(website, { recursive: true });
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: paths.project, name: "Cake", addedAt: timestamp, lastOpenedAt: timestamp },
          { path: website, name: "Website", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
        trustedProjectPaths: [],
      }),
    );
    for (const [index, title] of [
      "Session search",
      "Search dialog keyboard",
      "Sidebar layout",
      "Website search",
    ].entries()) {
      const project = index === 3 ? website : paths.project;
      const sessionId = `visual-session-search-${index}`;
      const directory = workspaceSessionDirectory(project, join(paths.cakeHome, "pi", "sessions"));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        [
          { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
          { type: "session_info", id: "title", parentId: null, timestamp, name: title },
          {
            type: "message",
            id: "user-1",
            parentId: "title",
            timestamp,
            message: {
              role: "user",
              content: [{ type: "text", text: `Work on ${title}` }],
              timestamp: 0,
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    }
  },
  async prepare(page, state) {
    await expect(page.locator('[data-slot="sidebar"] [data-session-id]')).toHaveCount(4, {
      timeout: 20_000,
    });
    if (state === "focus")
      await page.getByRole("button", { name: "Focus on project", exact: true }).click();
    if (state !== "sidebar") {
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      const filter = page.getByRole("combobox", { name: "Search session titles" });
      await expect(filter).toBeFocused();
      if (state === "filtered" || state === "empty")
        await filter.fill(state === "filtered" ? "srch dlg" : "missing");
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.mouse.move(1, 1);
  },
  region(page, state) {
    return state === "sidebar"
      ? page.locator('[data-slot="sidebar"]')
      : page.getByRole("dialog", { name: "Search sessions", exact: true }).locator(":scope > div");
  },
};

const projectCustomInstructionsScenario: VisualCaptureScenario = {
  name: "project-custom-instructions",
  description: "Personal project instructions in the Project Settings dialog",
  states: ["default"],
  seed: (paths, theme) => cakePromptsSettingsScenario.seed(paths, theme),
  async prepare(page) {
    await page.getByRole("button", { name: "Open settings for project" }).click();
    await page.getByRole("dialog", { name: /settings/ }).waitFor({ state: "visible" });
    await page.waitForFunction(() => document.fonts.status === "loaded");
  },
  region(page) {
    return page.getByRole("dialog", { name: /settings/ });
  },
};

const dictationInputScenario: VisualCaptureScenario = {
  name: "dictation-input",
  description: "Real Chat composer with dictation and conversation mode in the leading toolbar",
  states: ["default", "preparing", "error", "speaking", "wrapped", "muted"],
  environment: conversationCountdownScenario.environment,
  seed: conversationCountdownScenario.seed,
  async prepare(page, state, application) {
    await conversationEntryScenario.prepare(page, "default", application);
    // Replace only the browser audio boundary; drive the real dictation workflow and PCM meter.
    await page.evaluate((state) => {
      const source = new AudioContext();
      const stream = source.createMediaStreamDestination().stream;
      navigator.mediaDevices.getUserMedia = async () => {
        if (state === "preparing") await new Promise(() => {});
        if (state === "error") throw new Error("Microphone unavailable");
        return stream;
      };
      const WorkletNode = AudioWorkletNode;
      globalThis.AudioWorkletNode = class extends WorkletNode {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options);
          this.port.addEventListener("message", (event) => {
            if (event.isTrusted) event.stopImmediatePropagation();
          });
          Object.assign(globalThis, { visualDictationProcessor: this });
        }
      };
    }, state);
    // Startup can finish opening the seeded session after its transcript is visible.
    // Retry navigation if that one-time completion returns us to chat.
    await expect(async () => {
      const section = page.getByRole("button", { name: /Voice & Dictation/ });
      if (!(await section.isVisible()))
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await section.click({ timeout: 1000 });
      await expect(page.getByRole("switch", { name: "Dictation mode" })).toBeVisible({
        timeout: 1000,
      });
    }).toPass({ timeout: 15_000 });
    await page.getByRole("switch", { name: "Dictation mode" }).click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page
      .locator('[data-navigation-item][data-session-id="visual-conversation-entry"]')
      .click();
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await input.fill(
      state === "wrapped"
        ? "Let’s refine the voice conversation together. The dictation bars sit in the bottom-left toolbar, while this longer dictated message wraps at the normal left edge of the input."
        : "Let’s refine the voice conversation together.",
    );
    if (state === "preparing") {
      const control = page.getByRole("button", { name: "Mute dictation", exact: true });
      await expect(control).toHaveAttribute("aria-busy", "true");
      await expect(control.locator('[role="status"]')).toBeVisible();
      await page.mouse.move(1, 1);
      return;
    }
    if (state === "error") {
      const control = page.getByRole("button", { name: "Mute dictation", exact: true });
      await expect(control).toHaveClass(/text-destructive/);
      await expect(
        page.locator('[data-slot="dictation-indicator"] [aria-live="polite"]'),
      ).toHaveText("Microphone unavailable");
      await page.mouse.move(1, 1);
      return;
    }
    await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await expect(page.locator('[data-slot="voice-meter"]')).toBeVisible();
    if (state === "muted") {
      await page.getByRole("button", { name: "Mute dictation", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Unmute dictation", exact: true }),
      ).toBeVisible();
      await page.mouse.move(1, 1);
      return;
    }
    await page.evaluate((speaking) => {
      const processor = Reflect.get(globalThis, "visualDictationProcessor") as AudioWorkletNode;
      processor.port.dispatchEvent(
        new MessageEvent("message", { data: new Float32Array(800).fill(speaking ? 0.09 : 0) }),
      );
    }, state === "speaking");
    await expect
      .poll(() =>
        page
          .locator('[data-slot="voice-meter-bar"]')
          .evaluateAll((bars) =>
            Math.max(...bars.map((bar) => bar.getBoundingClientRect().height)),
          ),
      )
      .toBeCloseTo(state === "speaking" ? 9.25 : 2.16, 0);
    await page.mouse.move(1, 1);
  },
  region: conversationEntryScenario.region,
};

const dictationSettingsScenario: VisualCaptureScenario = {
  name: "voice-dictation-settings",
  description:
    "Shared voice/dictation recognition, processing mode and editable utility prompt settings",
  states: ["default"],
  seed: assistantMarkdownCode.seed,
  async prepare(page) {
    await assistantMarkdownCode.prepare(page, "default");
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await page.getByRole("heading", { name: "Voice & Dictation", exact: true }).waitFor();
    await page.waitForFunction(() => document.fonts.status === "loaded");
  },
  region: cakePromptsSettingsScenario.region,
};

const serverClientSettingsScenario: VisualCaptureScenario = {
  name: "server-client-settings",
  description: "Real local backend selection and browser sharing controls in Network & privacy",
  states: ["backend", "sharing"],
  seed: (paths, theme) => cakePromptsSettingsScenario.seed(paths, theme),
  async prepare(page, state) {
    await page
      .getByRole("button", { name: "Open settings", exact: true })
      .waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const network = page.getByRole("button", { name: "Network & privacy" });
    await network.waitFor({ state: "visible", timeout: 20_000 });
    await network.click();
    const section =
      state === "backend"
        ? page.getByRole("region", { name: "Cake backend" })
        : page.locator("#setting-browser-sharing");
    await section.waitFor({ state: "visible", timeout: 20_000 });
    await section.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.fonts.status === "loaded");
  },
  region(page) {
    return page.locator("#settings-content-scroll");
  },
};

export const sessionPluginsScenario: VisualCaptureScenario = {
  name: "session-plugins",
  description: "Session Plugin controls and generated theme bridge above ordinary chat",
  states: ["default", "hover"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 4,
        data: {
          globalSessionLabels: [],
          unreadSessionIds: [],
          trustedProjectPaths: [],
          fastModeSessionIds: [],
          modelPresets: [],
          sessionPluginSharedState: [],
          projects: [
            {
              path: paths.project,
              name: "Session controls",
              addedAt: timestamp,
              lastOpenedAt: timestamp,
            },
          ],
          sessionPlugins: [
            {
              sessionId: "visual-assistant-markdown-code",
              id: "generated",
              title: "Custom controls",
              slot: "composer.above",
              source: `import { useCake, usePluginState } from "@cake/plugin-sdk";
export default function Plugin() { const cake = useCake(); const [state, setState] = usePluginState({ topic: "Current selection" }); return <section><span>{state.topic}</span> <button onClick={() => setState({topic: "Selection clarified"})}>Explain this</button> <button disabled>Unavailable</button></section>; }`,
              state: { topic: "Current selection" },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              sessionId: "visual-assistant-markdown-code",
              id: "draw-guide",
              title: "Draw guide",
              slot: "composer.above",
              preset: "action-bar",
              state: {
                label: "One meaningful Draw step",
                actions: [
                  {
                    id: "continue",
                    label: "Continue",
                    primary: true,
                    message: "Continue with one meaningful Draw step.",
                  },
                  {
                    id: "explain",
                    label: "Explain this",
                    message: "Clarify the current Draw point or selection.",
                  },
                  {
                    id: "done",
                    label: "Done",
                    message: "Remove draw-guide with plugins.delete; preserve the board.",
                  },
                ],
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              sessionId: "visual-assistant-markdown-code",
              id: "guided-steps",
              title: "Guided steps",
              slot: "composer.above",
              preset: "action-bar",
              state: {
                label: "Understanding the flow",
                progress: { current: 1, total: 4 },
                actions: [
                  {
                    id: "previous",
                    label: "Previous",
                    disabled: true,
                    message: "Revisit the previous step without undoing the board.",
                  },
                  {
                    id: "next",
                    label: "Next",
                    primary: true,
                    message: "Explain the next step and update guided-steps progress.",
                  },
                  {
                    id: "done",
                    label: "Done",
                    message: "Delete guided-steps; preserve existing work.",
                  },
                ],
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      }),
    );
  },
  async prepare(page, state) {
    const frame = page.frameLocator('iframe[title="Custom controls"]');
    await expect(frame.getByRole("button", { name: "Explain this" })).toBeVisible();
    await expect(frame.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
    if (state === "hover") await frame.getByRole("button", { name: "Explain this" }).hover();
  },
  region(page) {
    return page.locator('[data-session-plugin-slot="composer.above"]');
  },
};

let sourceSelectionProject = "";

const sourceSelectionScenario: VisualCaptureScenario = {
  name: "source-selection",
  description: "IDE source context in the composer and in a submitted message",
  states: ["draft", "sent"],
  async seed(paths, theme) {
    sourceSelectionProject = paths.project;
    const sessionId = "visual-source-selection";
    const timestamp = new Date(0).toISOString();
    const directory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(join(paths.project, "src"), { recursive: true }),
      mkdir(directory, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(join(paths.project, "src", "example.ts"), "export const answer = 42;\n");
    await writeFile(
      join(paths.userData, "window-state.json"),
      JSON.stringify({
        projectPath: paths.project,
        selectedSessionId: sessionId,
        activeConversation: { kind: "project-session", workspacePath: paths.project, sessionId },
        recentProjectPaths: [paths.project],
        draft: "",
        draftsBySession: {},
        theme,
      }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "source-selection",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [paths.project],
      }),
    );
    const attachment = {
      kind: "source" as const,
      name: "src/example.ts",
      location: {
        path: "src/example.ts",
        range: { start: { line: 0 }, end: { line: 0 } },
      },
    };
    await writeFile(
      join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      `${[
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Show me the source context" }],
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "user-2",
          parentId: "user-1",
          timestamp,
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `What does this line do?\n\n<cake-source-attachment>${JSON.stringify(attachment)}</cake-source-attachment>`,
              },
            ],
            timestamp: 1,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("The source selection scenario requires Electron");
    const sessionId = "visual-source-selection";
    await page.getByLabel("Message", { exact: true }).waitFor({ state: "visible" });
    await page
      .locator("article")
      .getByText("Show me the source context", { exact: true })
      .waitFor({ state: "visible" });
    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId,
      controlRequestId: randomUUID(),
      invocation: { _tag: "InvokeAppControl", command: "vscode.enter", input: {} },
    });
    await page.getByRole("region", { name: "VS Code workspace" }).waitFor({ state: "visible" });
    await page.locator("aside article").first().waitFor({ state: "visible" });
    if (state === "draft") {
      await emitRendererEvent(application, {
        type: "project-session-control-requested",
        sessionId,
        controlRequestId: randomUUID(),
        invocation: {
          _tag: "InvokeAppControl",
          command: "vscode.open",
          input: {
            path: "src/example.ts",
            line: 1,
            endLine: 1,
          },
        },
      });
      await page.locator('[aria-label="Editor selections"]').waitFor({ state: "visible" });
      await emitRendererEvent(application, {
        type: "embedded-editor-selection",
        workspacePath: sourceSelectionProject,
        path: "src/example.ts",
        startLine: 0,
        endLine: 0,
      });
      await page
        .locator("form")
        .getByRole("button", { name: /Open src\/example\.ts/ })
        .waitFor({ state: "visible" });
      await page.getByLabel("Message", { exact: true }).fill("Could you explain this selection?");
      await page.locator("aside article").last().scrollIntoViewIfNeeded();
    } else {
      await expect(page.getByText("What does this line do?", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Open src\/example\.ts/ })).toBeVisible();
    }
    await page.waitForFunction(() => document.fonts.status === "loaded");
  },
  region(page) {
    return page.locator("aside").last();
  },
};

const vscodeTerminalScenario: VisualCaptureScenario = {
  name: "vscode-terminal",
  description: "Native VS Code with the terminal open above it or docked below it",
  states: ["top", "bottom"],
  async seed(paths, theme) {
    await sourceSelectionScenario.seed(paths, theme);
    await writeFile(
      join(paths.project, "src", "example.ts"),
      [
        "export interface Project {",
        "  name: string;",
        "  workingDirectory: string;",
        "}",
        "",
        "export function describeProject(project: Project): string {",
        "  return `${project.name} — ${project.workingDirectory}`;",
        "}",
        "",
        "export const example: Project = {",
        '  name: "Cake",',
        '  workingDirectory: "~/dev/cake",',
        "};",
        "",
      ].join("\n"),
    );
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("The VS Code terminal scenario requires Electron");
    await sourceSelectionScenario.prepare(page, "draft", application);
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
        { timeout: 20_000 },
      )
      .toBe(true);
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((entry) => entry.submenu?.items ?? [])
        .find((entry) => entry.label === "Toggle Terminal");
      if (!item) throw new Error("Toggle Terminal menu item missing");
      item.click({}, undefined);
    });
    const terminal = page.locator('section[aria-label="Terminal"]');
    await expect(terminal).toHaveAttribute("aria-hidden", "false");
    await terminal.locator(".xterm-screen:visible").click();
    await page.keyboard.type("printf 'Terminal ready alongside VS Code\\n'");
    await page.keyboard.press("Enter");
    await expect(terminal.locator(".xterm-rows:visible")).toContainText(
      "Terminal ready alongside VS Code",
    );
    if (state === "bottom")
      await terminal.getByRole("button", { name: "Pin terminal to bottom" }).click();
    await expect
      .poll(async () => {
        const bounds = (await terminal.boundingBox())!;
        return application.evaluate(
          ({ BrowserWindow, WebContentsView }, panel) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (!window) throw new Error("Cake capture window is missing");
            const editor = window.contentView.children
              .find(
                (child) =>
                  child instanceof WebContentsView &&
                  child.webContents.getURL().startsWith("http://127.0.0.1:"),
              )
              ?.getBounds();
            if (!editor) return false;
            return panel.state === "top"
              ? editor.y >= panel.y + panel.height
              : editor.y + editor.height <= panel.y + 1;
          },
          { ...bounds, state },
        );
      })
      .toBe(true);
  },
  region(page) {
    return page.locator("body");
  },
};

const nestedToolActivityScenario: VisualCaptureScenario = {
  name: "nested-tool-activity",
  description: "Script source, returned error, and metadata-only restored child tool activity",
  states: ["script", "children"],
  async seed(paths, theme) {
    await assistantMarkdownCode.seed(paths, theme);
    const sessionId = "visual-assistant-markdown-code";
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = workspaceSessionDirectory(
      paths.project,
      join(paths.cakeHome, "pi", "sessions"),
    );
    const entries = nestedEntries();
    entries[0]!.parentId = "user-1";
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      `${[
        { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: "Show the script and its nested tool calls.",
            timestamp: 0,
          },
        },
        ...entries,
        {
          type: "message",
          id: "final",
          parentId: "result",
          timestamp,
          message: {
            ...nestedAssistant,
            content: [{ type: "text", text: "Script tool activity restored." }],
            stopReason: "stop",
            timestamp: 3,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
  },
  async prepare(page, state) {
    const log = page.locator('[data-slot="activity-group"]');
    await expect(log).toBeVisible();
    await log.locator(":scope > summary").click();
    const parent = page.locator('[data-part-id="tool-script"]');
    await parent.getByRole("button", { name: /^codemode/ }).click();
    await expect(parent).toContainText("Script failed");
    if (state === "children") {
      const activity = parent.getByRole("region", { name: "Nested tool activity" });
      for (const child of await activity.locator('[data-slot="tool"]').all()) {
        await child.getByRole("button").first().click();
        await expect(child.getByText(/Output unavailable in saved history/)).toBeVisible();
      }
    }
    await log
      .locator('[data-slot="work-log-content"]')
      .evaluate(
        (element, state) =>
          element.scrollTo({ top: state === "children" ? element.scrollHeight : 0 }),
        state,
      );
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await log.scrollIntoViewIfNeeded();
  },
  region(page) {
    return page.locator('[data-slot="activity-group"]');
  },
};

export const visualCaptureScenarios = [
  workflowChoiceScenario,
  workflowProgressScenario,
  nestedToolActivityScenario,
  vscodeTerminalScenario,
  sourceSelectionScenario,
  sessionPluginsScenario,
  assistantMarkdownCode,
  contextPillsScenario,
  sessionMessagesScenario,
  conversationEntryScenario,
  conversationCountdownScenario,
  speechOutputSettingsScenario,
  screenCaptureSettingsScenario,
  experimentalSettingsScenario,
  screenCaptureOverlayScenario,
  inlineLinks,
  requestExplanationScenario,
  messageBoardScenario,
  inlineArtifactScenario,
  drawMermaidArchitectureScenario,
  drawCompositionScenario,
  cakePromptsSettingsScenario,
  mcpSettingsScenario,
  appearanceSettingsScenario,
  projectCustomInstructionsScenario,
  newSessionScenario,
  sessionSearchScenario,
  cakeChatScenario,
  cakeChatArtifactScenario,
  cakeChatInspectorScenario,
  taskInputAttachmentsScenario,
  cakeChatSidebarUnread,
  dictationInputScenario,
  dictationSettingsScenario,
  serverClientSettingsScenario,
] as const;

export function findVisualCaptureScenario(name: string) {
  return visualCaptureScenarios.find((scenario) => scenario.name === name);
}

/** Mirrors Cake/Pi's per-working-directory session layout for an isolated fixture. */
function workspaceSessionDirectory(workingDirectory: string, root: string) {
  const normalized = resolve(workingDirectory);
  const safePath = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(root), safePath);
}

async function seedSessionAssistant(
  paths: ScenarioFixturePaths,
  parentSessionId: string,
  timestamp: string,
) {
  const threadId = "visual-session-assistant-thread";
  const assistantSessionId = "visual-session-assistant";
  const assistantDirectory = join(
    paths.cakeHome,
    "pi",
    "review-sessions",
    sha256(paths.project),
    sha256(parentSessionId),
    sha256(threadId),
  );
  const assistantSessionFile = join(
    assistantDirectory,
    `1970-01-01T00-00-00-000Z_${assistantSessionId}.jsonl`,
  );
  const recordDirectory = join(
    paths.cakeHome,
    "state",
    "reviews",
    sha256(paths.project),
    sha256(parentSessionId),
  );
  await Promise.all([
    mkdir(assistantDirectory, { recursive: true }),
    mkdir(recordDirectory, { recursive: true }),
  ]);
  await writeFile(
    assistantSessionFile,
    `${[
      {
        type: "session",
        version: 3,
        id: assistantSessionId,
        timestamp,
        cwd: paths.project,
      },
      {
        type: "message",
        id: "assistant-user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Open the file we discussed in VS Code" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-reply-1",
        parentId: "assistant-user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I found the file and opened it in VS Code." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "visual-fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await writeFile(
    join(recordDirectory, `${sha256(threadId)}.json`),
    `${JSON.stringify(
      {
        id: threadId,
        workspacePath: paths.project,
        sessionId: parentSessionId,
        agentSessionId: assistantSessionId,
        agentSessionFile: assistantSessionFile,
        anchor: {
          path: `session:${parentSessionId}/assistant`,
          view: "session",
          start: { diffLine: 0 },
          end: { diffLine: 0 },
          selectedText: "",
          contextBefore: "",
          contextAfter: "",
          diff: "",
        },
        pendingComments: [],
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      null,
      2,
    )}\n`,
  );
}

async function seedArtifact(
  paths: ScenarioFixturePaths,
  artifact: CakeArtifactV1,
  timestamp: string,
) {
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const digest = sha256(serialized);
  const artifactRoot = join(paths.cakeHome, "state", "artifacts");
  const recordDirectory = join(
    artifactRoot,
    "sessions",
    sha256(paths.project),
    sha256(artifact.sessionId),
  );
  await Promise.all([
    mkdir(join(artifactRoot, "blobs"), { recursive: true }),
    mkdir(recordDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(artifactRoot, "blobs", `${digest}.json`), serialized),
    writeFile(
      join(recordDirectory, `${sha256(artifact.id)}.json`),
      `${JSON.stringify(
        {
          protocol: artifact.protocol,
          id: artifact.id,
          sessionId: artifact.sessionId,
          workspacePath: paths.project,
          revision: artifact.revision,
          kind: artifact.kind,
          digest,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
