import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { VisualCaptureTheme } from "./arguments.ts";
import type { CakeArtifactV1 } from "../../src/ipc/artifact-contract.ts";

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
  prepare(page: Page, state: string): Promise<void>;
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
  states: ["default", "hover", "quick-assistant", "assistant-chat"],
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

const architectureArtifact = {
  protocol: "cake.artifact/v1",
  id: "cake-runtime-architecture",
  sessionId: "visual-architecture-artifact",
  revision: 1,
  kind: "architecture",
  title: "Cake runtime architecture",
  payload: {
    direction: "LR",
    groups: [
      { id: "renderer-boundary", label: "Sandboxed renderer" },
      { id: "main-boundary", label: "Electron main process" },
    ],
    nodes: [
      {
        id: "chat",
        label: "Chat & artifact panel",
        description: "React presentation backed by window-scoped Stores and Models.",
        category: "interface",
        group: "renderer-boundary",
        source: { path: "src/renderer/components/chat.tsx" },
      },
      {
        id: "projection",
        label: "Renderer projection",
        description: "Applies authoritative snapshots and ordered runtime events.",
        category: "module",
        group: "renderer-boundary",
        source: { path: "src/renderer/models/RootProjection.ts" },
      },
      {
        id: "preload",
        label: "Validated preload bridge",
        description: "The narrow, schema-validated boundary between renderer and main.",
        category: "service",
        group: "main-boundary",
        source: { path: "src/preload/index.ts" },
      },
      {
        id: "domain",
        label: "Cake domain services",
        description: "Owns projects, worktrees, artifacts, reviews, and coordination policy.",
        category: "service",
        group: "main-boundary",
      },
      {
        id: "pi",
        label: "Pi session runtime",
        description: "Owns agent loops, transcript history, tools, models, and compaction.",
        category: "process",
        group: "main-boundary",
        source: { path: "src/services/pi" },
      },
      {
        id: "storage",
        label: "Cake persistence",
        description: "Content-addressed artifacts and Cake-owned application state.",
        category: "database",
        group: "main-boundary",
        source: { path: "src/services/storage" },
      },
      {
        id: "providers",
        label: "Model providers",
        description: "External model APIs reached through Pi provider integrations.",
        category: "external",
      },
    ],
    edges: [
      { id: "chat-projection", source: "projection", target: "chat", label: "reactive state" },
      {
        id: "bridge-projection",
        source: "preload",
        target: "projection",
        label: "snapshots + events",
        kind: "event",
      },
      {
        id: "domain-bridge",
        source: "domain",
        target: "preload",
        label: "Effect RPC",
        kind: "control",
      },
      {
        id: "domain-pi",
        source: "domain",
        target: "pi",
        label: "session operations",
        kind: "control",
      },
      { id: "domain-storage", source: "domain", target: "storage", label: "persist", kind: "data" },
      {
        id: "pi-providers",
        source: "pi",
        target: "providers",
        label: "model requests",
        kind: "dependency",
      },
    ],
  },
  fallback: {
    markdown:
      "Cake's sandboxed renderer receives validated snapshots and events from Electron main. Main owns domain services, persistence, and Pi runtimes; Pi communicates with external model providers.",
  },
  interaction: { mode: "present" },
} as const;

const architectureArtifactScenario: VisualCaptureScenario = {
  name: "architecture-artifact",
  description: "Interactive XYFlow architecture artifact in the artifact workspace",
  states: ["default", "selected", "fullscreen"],
  async seed(paths, theme) {
    await seedArtifactScenario(paths, theme, architectureArtifact);
  },
  async prepare(page, state) {
    await prepareArchitectureArtifact(page, state);
  },
  region(page) {
    return page.getByRole("dialog").or(page.locator('[data-artifact-kind="architecture"]')).last();
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

async function prepareArchitectureArtifact(page: Page, state: string) {
  const artifactButton = page.getByRole("button", { name: "1 artifacts" });
  await artifactButton.waitFor({ state: "visible", timeout: 20_000 });
  await artifactButton.click();
  await page.getByRole("button", { name: "Cake runtime architecture" }).click();
  const artifact = page.locator('[data-artifact-kind="architecture"]');
  await artifact.waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".react-flow__node").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
  if (state === "selected") {
    await page.locator('.react-flow__node[data-id="chat"]').click();
    await page.getByText("React presentation backed by window-scoped Stores and Models.").waitFor();
  } else if (state === "fullscreen") {
    await page.getByRole("button", { name: "View Cake runtime architecture fullscreen" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.getByRole("dialog").locator(".react-flow__node").first().waitFor();
  }
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

const widgetPipelineScenario: VisualCaptureScenario = {
  name: "widget-pipeline-explanation",
  description: "Connected sandboxed diagram of widget publication, repair and ownership",
  states: ["default", "selected", "fullscreen"],
  async seed(paths, theme) {
    const source = await readFile(
      resolve(import.meta.dirname, "../../tests/fixtures/explanations/widget-pipeline.react.txt"),
      "utf8",
    );
    await seedArtifactScenario(paths, theme, {
      protocol: "cake.artifact/v1",
      id: "widget-pipeline-explanation",
      sessionId: "visual-widget-pipeline",
      revision: 1,
      kind: "widget",
      title: "Widget publication paths",
      payload: {
        language: "react",
        source,
        brief:
          "Source-backed diagram of the existing delegated widget path, not a live execution trace.",
        generationSessionId: "manual-diagram-prototype",
      },
      fallback: {
        markdown:
          "The primary Pi session delegates a brief to an isolated specialist. Source must compile before Cake persists the artifact and Pi appends a transcript pointer. Compile failure allows one restricted repair and recheck; a second failure propagates. The renderer compiles stored source for an opaque-origin allow-scripts iframe. Generated code has no host privileges.",
      },
      interaction: { mode: "present" },
    });
  },
  async prepare(page, state) {
    await page.getByRole("button", { name: "1 artifacts" }).click();
    await page.getByRole("button", { name: "Widget publication paths" }).click();
    let frame = page.frameLocator('iframe[title="Widget publication paths"]');
    await frame.getByRole("heading", { name: "One gate. Two outcomes." }).waitFor();
    if (state === "fullscreen") {
      await page.getByRole("button", { name: "View Widget publication paths fullscreen" }).click();
      frame = page.frameLocator('iframe[title="Widget publication paths fullscreen"]');
    }
    if (state !== "default") {
      await frame.getByRole("button", { name: "Repair loop", exact: true }).click();
      await frame.getByRole("heading", { name: "One repair", exact: true }).waitFor();
      await frame.getByRole("button", { name: "Source evidence" }).click();
    }
    // Flow measures nodes asynchronously; a heading alone does not prove the diagram is ready.
    await frame.locator('.react-flow__node[data-id="widget"]').waitFor({ state: "visible" });
    await frame.locator('.react-flow__edge[data-id="embed"] text').waitFor({ state: "visible" });
    await page.mouse.move(1, 1);
  },
  region(page) {
    return page.getByRole("dialog").or(page.locator('[data-artifact-kind="widget"]')).last();
  },
};

export const visualCaptureScenarios = [
  assistantMarkdownCode,
  architectureArtifactScenario,
  requestExplanationScenario,
  widgetPipelineScenario,
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
