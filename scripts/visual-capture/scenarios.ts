import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { VisualCaptureTheme } from "./arguments.ts";
import type { CakeArtifactV1 } from "../../src/ipc/artifact-contract.ts";
import type { CakeEvent } from "../../src/ipc/cake-rpc-contract.ts";

interface ScenarioFixturePaths {
  readonly cakeHome: string;
  readonly project: string;
  readonly userData: string;
}

interface VisualCaptureScenario {
  readonly name: string;
  readonly description: string;
  readonly states: readonly string[];
  seed(
    paths: ScenarioFixturePaths,
    theme: VisualCaptureTheme,
    artifact?: CakeArtifactV1,
  ): Promise<void>;
  prepare(page: Page, state: string, application?: ElectronApplication): Promise<void>;
  region(page: Page): Locator;
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
      await expect(page.locator('[data-slot="session-smoke"]')).toHaveCount(2);
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

async function seedArtifactScenario(
  paths: ScenarioFixturePaths,
  theme: "light" | "dark",
  artifact: CakeArtifactV1,
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
            {
              type: "text",
              text: "Open the source-backed explanation to explore Cake’s process boundaries and who owns the conversation.",
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
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await seedArtifact(paths, artifact, timestamp);
}

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
        diagram: `flowchart TB
  subgraph renderer["Sandboxed Renderer"]
    models["Renderer Models + Stores with measured labels"]
    chat["Shared Chat and Conversation surfaces"]
  end
  subgraph main["Electron Main"]
    services["Cake services"]
    pi["Pi Runtime agent loop + transcript"]
  end
  models -->|typed RPC| services
  chat --> services
  services --> pi`,
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
    const prompts = page.getByRole("button", { name: "Cake prompts" });
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

export const visualCaptureScenarios = [
  sessionPluginsScenario,
  assistantMarkdownCode,
  requestExplanationScenario,
  drawMermaidArchitectureScenario,
  drawCompositionScenario,
  cakePromptsSettingsScenario,
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
