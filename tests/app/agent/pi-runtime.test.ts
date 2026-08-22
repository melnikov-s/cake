import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCakeArtifactExtension } from "../../../src/agent/artifact-extension";
import {
  createCakeRuntime,
  piRuntimeVersion,
  type CakeRuntime,
} from "../../../src/agent/cake-runtime";
import {
  createFoundationRuntime,
  type FoundationRuntime,
} from "../../../src/agent/foundation-runtime";
import {
  cakePluginAuthoringSkillPath,
  cakeWorkspaceSessionDirectory,
  inspectWorkspace,
  loadPiChangelog,
  loadWorkspaceSessionPreview,
  listWorkspaceSessions,
  suggestProjectFiles,
} from "../../../src/agent/session-discovery";
import {
  createLiveMessageProjector,
  formatToolResult,
  formatUnknown,
  projectQueuedMessages,
  projectSessionEntries,
  toolResultContent,
} from "../../../src/agent/session-projection";
import { loadReviewSessionProjection, runReviewTurn } from "../../../src/agent/sidecar-runtime";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import { sessionSnapshotSchema } from "../../../src/ipc/session-contract";

const temporaryDirectories: string[] = [];
const runtimes: Array<FoundationRuntime | CakeRuntime> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cake-pi-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

function maximumObjectDepth(value: unknown) {
  let maximum = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    maximum = Math.max(maximum, current.depth);
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const child of Object.values(current.value))
      stack.push({ value: child, depth: current.depth + 1 });
  }
  return maximum;
}

describe("Pi 0.84.0 foundation contract", () => {
  it("extends Pi's project system prompt with Cake desktop context", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      trusted: false,
      newSession: true,
      requestUi: async () => undefined,
      generateInlineWidget: async () => ({
        language: "react",
        source: "export default () => null",
        generationSessionId: "generation-1",
      }),
      onEvent: () => undefined,
    });
    runtimes.push(runtime);

    if (!runtime.getReviewParentContext) throw new Error("Expected a project runtime");
    const { systemPrompt, activeTools } = runtime.getReviewParentContext();

    expect(systemPrompt).toContain("You are an expert coding assistant operating inside pi");
    expect(systemPrompt).toContain("## Cake desktop environment");
    expect(systemPrompt).toContain("Mermaid diagrams directly in the transcript");
    expect(systemPrompt).toContain("Use ui_widget");
    expect(systemPrompt).toContain("do not write React or HTML yourself");
    expect(systemPrompt).toContain("PowerPoint presentations, PDFs, spreadsheets");
    expect(systemPrompt).toContain("Use ui_request only when the running turn must block");
    expect(systemPrompt).toContain("cake.request/v1");
    expect(systemPrompt).toContain("stores the implementation outside this conversation context");
    expect(systemPrompt).toContain("use Markdown links with absolute paths so Cake can open them");
    expect(activeTools).toContain("ui_widget");
  });

  it("keeps delegated widget source out of the primary tool result and artifact pointer", async () => {
    type RegisteredTool = {
      name: string;
      execute(
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: {
          model?: { provider: string; id: string };
          sessionManager: { getSessionId(): string };
        },
      ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
    };
    let widgetTool: RegisteredTool | undefined;
    const pointers: Array<{ type: string; data: unknown }> = [];
    const persisted: CakeArtifactV1[] = [];
    const source = "export default () => <strong>Private source</strong>";
    const extension = createCakeArtifactExtension({
      persistArtifact: async (artifact) => {
        persisted.push(artifact);
        return {
          artifact,
          workspacePath: "/project",
          digest: "a".repeat(64),
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      },
      requestArtifact: async () => undefined,
      generateInlineWidget: async () => ({
        language: "react",
        source,
        generationSessionId: "generation-1",
      }),
    });
    (extension as unknown as (pi: unknown) => void)({
      registerTool(tool: unknown) {
        const registered = tool as RegisteredTool;
        if (registered.name === "ui_widget") widgetTool = registered;
      },
      registerCommand() {},
      appendEntry(type: string, data: unknown) {
        pointers.push({ type, data });
      },
    } as never);
    if (!widgetTool) throw new Error("Expected ui_widget to be registered");

    const result = await widgetTool.execute(
      "call-1",
      {
        widget: {
          id: "widget-1",
          title: "Comparison",
          brief: "Compare these values",
          data: [1, 2],
          fallback: { markdown: "Values 1 and 2." },
        },
      },
      undefined,
      undefined,
      {
        model: { provider: "fixture", id: "model" },
        sessionManager: { getSessionId: () => "session-1" },
      },
    );

    expect(persisted[0]).toMatchObject({ kind: "widget", payload: { source } });
    expect(JSON.stringify(result)).not.toContain(source);
    expect(JSON.stringify(pointers)).not.toContain(source);
    expect(result.details).toEqual({ artifactId: "widget-1" });
  });

  it("keeps session listing alive when Pi's first-message title exceeds Cake's IPC limit", async () => {
    const directory = await createTemporaryDirectory();
    const sessionDir = join(directory, "sessions");
    const workspaceSessionDir = cakeWorkspaceSessionDirectory(directory, sessionDir);
    const timestamp = new Date().toISOString();
    await mkdir(workspaceSessionDir, { recursive: true });
    await writeFile(
      join(workspaceSessionDir, "long-title.jsonl"),
      [
        { type: "session", version: 3, id: "long-title", timestamp, cwd: directory },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "x".repeat(2_048) }],
            timestamp: Date.now(),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const [summary] = await listWorkspaceSessions(directory, sessionDir);

    expect(summary).toBeDefined();
    if (!summary) throw new Error("Expected Pi to list the session fixture");
    expect(summary.title).toBe("x".repeat(1_024));
    expect(() => sessionSnapshotSchema.shape.sessions.parse([summary])).not.toThrow();
  });

  it("starts automatic naming from the initial user message", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const server = createServer((_request, response) => {
      void responseReleased.then(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finishReason: string | null = null) =>
          `data: ${JSON.stringify({
            id: "fixture-completion",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1_000),
            model: "fixture-model",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        response.write(chunk({ role: "assistant", content: "The response" }));
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    const port = (address as AddressInfo).port;
    await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "extensions", "fixture-provider.ts"),
      `export default function (pi) { pi.registerProvider("fixture-provider", ${JSON.stringify({
        name: "Fixture provider",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "fixture",
        api: "openai-completions",
        models: [
          {
            id: "fixture-model",
            name: "Fixture model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 1_024,
          },
        ],
      })}); }\n`,
    );
    let prompt: Promise<void> | undefined;
    const generateTitle = vi.fn(async ({ firstUserMessage }: { firstUserMessage: string }) => {
      return firstUserMessage === "Investigate session naming" ? "Generated title" : "Unexpected";
    });
    try {
      const runtime = await createCakeRuntime({
        cwd: directory,
        agentDir,
        sessionDir: join(directory, "sessions"),
        trusted: true,
        utilityModel: () => ({
          provider: "fixture-provider",
          modelId: "fixture-model",
          thinkingLevel: "off",
        }),
        generateSessionTitle: generateTitle as never,
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      runtimes.push(runtime);
      await runtime.setModel("fixture-provider", "fixture-model");
      prompt = runtime.prompt("Investigate session naming", "prompt", []);

      await vi.waitFor(() => expect(generateTitle).toHaveBeenCalledOnce(), { timeout: 1_000 });
      await vi.waitFor(
        async () =>
          expect(
            (await runtime.snapshot()).sessions.find((item) => item.id === runtime.sessionId)
              ?.title,
          ).toBe("Generated title"),
        { timeout: 1_000 },
      );
      expect(generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({ firstUserMessage: "Investigate session naming" }),
      );
      releaseResponse();
      await prompt;
      prompt = undefined;
    } finally {
      releaseResponse();
      await prompt?.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("lists Cake Chat sessions directly from its dedicated session directory", async () => {
    const directory = await createTemporaryDirectory();
    const sessionDir = join(directory, "cake-chat-sessions");
    const timestamp = new Date().toISOString();
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "cake-chat.jsonl"),
      [
        { type: "session", version: 3, id: "cake-chat", timestamp, cwd: directory },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Repair my plugins" }],
            timestamp: Date.now(),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const summaries = await listWorkspaceSessions(directory, sessionDir, true);

    expect(summaries).toEqual([
      expect.objectContaining({ id: "cake-chat", title: "Repair my plugins" }),
    ]);
  });

  it("keeps code comments lightweight and refreshes their live parent projection", async () => {
    const directory = await createTemporaryDirectory();
    const parentDir = join(directory, "parents");
    const reviewDir = join(directory, "reviews");
    const agentDir = join(directory, "agent");
    await mkdir(parentDir, { recursive: true });
    const timestamp = new Date(0).toISOString();
    const parentFile = join(parentDir, "parent.jsonl");
    await writeFile(
      parentFile,
      [
        { type: "session", version: 3, id: "parent-session", timestamp, cwd: directory },
        {
          type: "message",
          id: "parent-user",
          parentId: null,
          timestamp,
          message: { role: "user", content: "Build the feature", timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const controller = new AbortController();
    controller.abort();
    const thread = {
      id: "review-1",
      workspacePath: directory,
      sessionId: "parent-session",
      status: "open" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      anchor: {
        path: "src/app.ts",
        start: { diffLine: 1 },
        end: { diffLine: 1 },
        selectedText: "value",
        contextBefore: "",
        contextAfter: "",
        diff: "+value",
      },
      pendingComments: [{ id: "comment-1", body: "Rename this", createdAt: timestamp }],
    };

    await expect(
      runReviewTurn({
        cwd: directory,
        trusted: false,
        thread,
        sessionDir: reviewDir,
        parentSessionRoot: parentDir,
        agentDir,
        signal: controller.signal,
        parent: { sessionId: "parent-session", sessionFile: parentFile, leafId: "parent-user" },
      }),
    ).rejects.toThrow("cancelled");

    const projection = await readFile(join(reviewDir, "context", "parent-transcript.md"), "utf8");
    expect(projection).toContain("Build the feature");
    expect((await readdir(reviewDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("keeps transcript comments lightweight and refreshes their live parent projection", async () => {
    const directory = await createTemporaryDirectory();
    const parentDir = join(directory, "parents");
    const reviewDir = join(directory, "comments");
    const agentDir = join(directory, "agent");
    await mkdir(parentDir, { recursive: true });
    const timestamp = new Date(0).toISOString();
    const parentFile = join(parentDir, "parent.jsonl");
    await writeFile(
      parentFile,
      [
        { type: "session", version: 3, id: "parent-session", timestamp, cwd: directory },
        {
          type: "message",
          id: "parent-user",
          parentId: null,
          timestamp,
          message: { role: "user", content: "Draft a plan", timestamp: 0 },
        },
        {
          type: "message",
          id: "parent-assistant",
          parentId: "parent-user",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The original plan" }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const controller = new AbortController();
    controller.abort();
    const thread = {
      id: "comment-1",
      workspacePath: directory,
      sessionId: "parent-session",
      status: "open" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      anchor: {
        path: "session:parent-session/message/assistant",
        view: "message" as const,
        messageId: "assistant",
        entryId: "parent-assistant",
        startOffset: 4,
        endOffset: 12,
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "original",
        contextBefore: "The ",
        contextAfter: " plan",
        diff: "",
      },
      pendingComments: [{ id: "question-1", body: "Why original?", createdAt: timestamp }],
    };

    await expect(
      runReviewTurn({
        cwd: directory,
        trusted: false,
        thread,
        sessionDir: reviewDir,
        parentSessionRoot: parentDir,
        agentDir,
        signal: controller.signal,
        parent: {
          sessionId: "parent-session",
          sessionFile: parentFile,
          leafId: "parent-assistant",
          model: { provider: "fixture", id: "model" },
        },
      }),
    ).rejects.toThrow("cancelled");

    const projection = await readFile(join(reviewDir, "context", "parent-transcript.md"), "utf8");
    expect(projection).toContain("Draft a plan");
    expect(projection).toContain("The original plan");
    expect((await readdir(reviewDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("reopens review sidecars as complete chat parts with persisted usage", async () => {
    const directory = await createTemporaryDirectory();
    const reviewDir = join(directory, "reviews");
    await mkdir(reviewDir, { recursive: true });
    const timestamp = new Date(0).toISOString();
    const sessionFile = join(reviewDir, "review.jsonl");
    await writeFile(
      sessionFile,
      [
        { type: "session", version: 3, id: "review-session", timestamp, cwd: directory },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: { role: "user", content: "Explain this", timestamp: 0 },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Inspect the file" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/app.ts" } },
            ],
            timestamp: 0,
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { total: 0.01 },
            },
            stopReason: "toolUse",
          },
        },
        {
          type: "message",
          id: "tool-1",
          parentId: "assistant-1",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "const value = true;" }],
            details: {},
            isError: false,
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "assistant-2",
          parentId: "tool-1",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "It enables the feature." }],
            timestamp: 0,
            usage: {
              input: 20,
              output: 6,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 26,
              cost: { total: 0.02 },
            },
            stopReason: "stop",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const usage = {
      tokens: { input: 30, output: 11, cacheRead: 0, cacheWrite: 0, total: 41 },
      cost: 0.03,
    };
    const projection = await loadReviewSessionProjection(
      {
        id: "thread-1",
        workspacePath: directory,
        sessionId: "parent",
        agentSessionId: "review-session",
        agentSessionFile: sessionFile,
        usage,
        anchor: {
          path: "src/app.ts",
          start: { diffLine: 1 },
          end: { diffLine: 1 },
          selectedText: "value",
          contextBefore: "",
          contextAfter: "",
          diff: "",
        },
        pendingComments: [],
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      reviewDir,
    );

    expect(projection.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "reasoning", text: "Inspect the file" }),
        expect.objectContaining({ kind: "tool", name: "read", state: "success" }),
        expect.objectContaining({
          kind: "text",
          role: "assistant",
          text: "It enables the feature.",
        }),
      ]),
    );
    expect(projection.usage).toEqual(usage);
  });

  it("gives assistant messages on either side of a tool call distinct live positions", () => {
    const project = createLiveMessageProjector();
    const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    const event = (value: object) => value as AgentSessionEvent;

    project(event({ type: "message_start", message: assistant("") }));
    const beforeTool = project(
      event({
        type: "message_update",
        message: assistant("I'll inspect that."),
        assistantMessageEvent: { type: "text_delta", delta: "I'll inspect that." },
      }),
    );
    project(event({ type: "message_end", message: assistant("I'll inspect that.") }));
    project(event({ type: "message_start", message: assistant("") }));
    const afterTool = project(
      event({
        type: "message_update",
        message: assistant("Here is the result."),
        assistantMessageEvent: { type: "text_delta", delta: "Here is the result." },
      }),
    );

    expect(beforeTool[0]).toMatchObject({ id: "stream-1-text-0", text: "I'll inspect that." });
    expect(afterTool[0]).toMatchObject({ id: "stream-2-text-0", text: "Here is the result." });
  });

  it("projects a consumed user message as soon as Pi starts it", () => {
    const project = createLiveMessageProjector();
    const parts = project({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "Queued work" }], timestamp: 0 },
    } as AgentSessionEvent);

    expect(parts).toEqual([
      expect.objectContaining({
        id: "live-user-1-text",
        kind: "text",
        role: "user",
        text: "Queued work",
        status: "complete",
      }),
    ]);
  });

  it("projects Pi queue state with stable delivery labels and duplicate identities", () => {
    expect(
      projectQueuedMessages(["Change direction", "Change direction"], ["Do this next"]),
    ).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^queued-steering-.*-1$/),
        text: "Change direction",
        deliveryState: "steering",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^queued-steering-.*-2$/),
        text: "Change direction",
        deliveryState: "steering",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^queued-follow-up-.*-1$/),
        text: "Do this next",
        deliveryState: "queued",
      }),
    ]);
    expect(projectQueuedMessages([], [], ["After compaction", "After compaction"])).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^queued-pending-.*-1$/),
        text: "After compaction",
        deliveryState: "queued",
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^queued-pending-.*-2$/),
        text: "After compaction",
        deliveryState: "queued",
      }),
    ]);
    expect(projectQueuedMessages([], [])).toEqual([]);
    expect(projectQueuedMessages([], [""])).toEqual([]);
  });

  it("projects bash tool calls as commands instead of JSON arguments", () => {
    const project = createLiveMessageProjector();
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 5" } },
      ],
    };
    project({ type: "message_start", message } as unknown as AgentSessionEvent);
    const parts = project({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);

    expect(parts[0]).toMatchObject({ kind: "tool", name: "bash", input: "sleep 5" });
  });

  it("keeps tool result content separate from its result envelope", () => {
    expect(
      formatToolResult({
        content: [{ type: "text", text: "export const value = true;" }],
        details: { truncation: undefined },
      }),
    ).toBe("export const value = true;");
    expect(formatToolResult({ content: [{ type: "text", text: "" }], details: {} })).toBe("");
    expect(formatToolResult({ details: { status: "ok" } })).toContain('"status": "ok"');
    expect(
      toolResultContent({
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }),
    ).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
  });

  it("projects a tool result with no text or details without failing later snapshots", () => {
    expect(formatUnknown(undefined)).toBe("");
    expect(
      projectSessionEntries([
        {
          type: "message",
          id: "tool-result",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [],
            isError: false,
            timestamp: 0,
          },
        } as never,
      ]),
    ).toEqual([
      expect.objectContaining({ id: "tool-call-1", kind: "tool", output: "", state: "success" }),
    ]);
  });

  it("loads Pi's bundled changelog through its public package directory", () => {
    expect(loadPiChangelog()).toContain("# Changelog");
    expect(loadPiChangelog()).toContain("0.84.0");
  });

  it("resolves Cake's bundled authoring skill from the matching source tree", () => {
    expect(cakePluginAuthoringSkillPath("/cake-authoring")).toBe(
      join("/cake-authoring", ".agents", "skills", "cake-plugin-authoring"),
    );
  });

  it("uses Pi's fuzzy @ provider for project file suggestions", async () => {
    const directory = await createTemporaryDirectory();
    const fakeFd = join(directory, "fd");
    await writeFile(fakeFd, "#!/bin/sh\nprintf 'src/\\nsrc/app.ts\\ntests/app.test.ts\\n'\n");
    await chmod(fakeFd, 0o755);

    expect(
      await suggestProjectFiles({
        cwd: directory,
        prefix: "app",
        agentDir: join(directory, "agent"),
        fdPath: fakeFd,
      }),
    ).toEqual([
      { value: "@src/app.ts", label: "app.ts", description: "src/app.ts" },
      { value: "@tests/app.test.ts", label: "app.test.ts", description: "tests/app.test.ts" },
    ]);
  });

  it("creates an in-memory session, binds extension UI, and projects session events", async () => {
    const directory = await createTemporaryDirectory();
    const requestConfirm = vi.fn(async () => true);
    const events: Array<{ type: string; text?: string; sessionId?: string }> = [];
    const runtime = await createFoundationRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      requestConfirm,
      onEvent: (event) => events.push(event),
    });
    runtimes.push(runtime);

    expect(piRuntimeVersion).toBe("0.84.0");
    expect(runtime.sessionFile).toBeUndefined();
    expect(runtime.sessionId).toBeTruthy();

    await runtime.run();

    expect(requestConfirm).toHaveBeenCalledWith(
      "Pi extension confirmation",
      expect.stringContaining("Pi extension"),
      undefined,
    );
    expect(events.find((event) => event.type === "session-ready")?.sessionId).toBe(
      runtime.sessionId,
    );
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Pi session boundary is alive.");
  });

  it("disposes idempotently and rejects later runs", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createFoundationRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      requestConfirm: async () => false,
      onEvent: () => undefined,
    });

    runtime.dispose();
    runtime.dispose();

    await expect(runtime.run()).rejects.toThrow("disposed");
  });
});

describe("S1 Pi runtime", () => {
  it("exposes delegation as hidden subagents rather than session construction", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      trusted: false,
      newSession: true,
      requestUi: async () => undefined,
      agentControl: {
        spawn: async () => ({ handleId: crypto.randomUUID(), running: true }),
        parallel: async () => ({ mode: "parallel", completed: 0, total: 0, results: [] }),
        prompt: async () => ({ streaming: false, parts: [] }),
        wait: async () => ({ streaming: false, parts: [] }),
        abort: async () => ({ streaming: false }),
        close: async () => ({ closed: true }),
      },
      onEvent: () => undefined,
    });
    runtimes.push(runtime);

    const parentContext = runtime.getReviewParentContext?.();
    const tools = parentContext?.activeTools ?? [];
    expect(tools).toEqual(
      expect.arrayContaining([
        "subagent_spawn",
        "subagent_parallel",
        "subagent_prompt",
        "subagent_follow_up",
        "subagent_wait",
        "subagent_abort",
        "subagent_close",
      ]),
    );
    expect(tools).not.toEqual(expect.arrayContaining(["agent_open", "agent_prompt", "agent_wait"]));
    expect(parentContext?.systemPrompt).toContain(
      "Do not use subagent tools unless the user explicitly asks",
    );
  });

  it("keeps auxiliary runtime snapshots limited to turn execution data", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      trusted: false,
      newSession: true,
      auxiliary: true,
      tools: ["read", "grep", "find", "ls"],
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(runtime);

    const auxiliary = await runtime.snapshot();
    expect(auxiliary.models).toEqual([]);
    expect(auxiliary.commands).toEqual([]);
    expect(auxiliary.tree).toEqual([]);
    expect(auxiliary.artifacts).toEqual([]);
  });

  it("enables Cake application tools alongside the full coding toolset in global chat", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "global-chat-sessions"),
      trusted: false,
      requestUi: async () => undefined,
      globalControl: {
        tools: [
          {
            name: "get_app_state",
            description: "Read Cake application state.",
            parameters: { type: "object", properties: {} },
          },
        ],
        invoke: async () => ({ ok: true }),
      },
      onEvent: () => undefined,
    });
    runtimes.push(runtime);

    const context = runtime.getReviewParentContext?.();
    expect(context?.activeTools).toContain("get_app_state");
    expect(context?.activeTools).toContain("bash");
    expect(context?.activeTools).toContain("read");
    expect(context?.activeTools).toContain("edit");
    expect(context?.systemPrompt).toContain("You are Cake Chat, the built-in assistant of Cake");
    expect(context?.systemPrompt).toContain("treat it as read-only");
    expect(context?.systemPrompt).toContain("that request authorizes the complete authoring loop");
    expect(context?.systemPrompt).toContain("fix the source and validate again autonomously");
    expect(context?.systemPrompt).toContain("Validation never changes the running UI");
    expect(context?.systemPrompt).toContain("Do not stop to report ordinary authoring diagnostics");
    expect(context?.systemPrompt).toContain(
      "collision-free layout as an authoring acceptance criterion",
    );
    expect(context?.systemPrompt).toContain("from 320 CSS pixels through wide desktop sizes");
  });

  it("opens the OpenAI Codex browser login URL", async () => {
    const directory = await createTemporaryDirectory();
    const openExternal = vi.fn(async () => undefined);
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      trusted: false,
      requestUi: async (request) => (request.kind === "select" ? "browser" : undefined),
      openExternal,
      onEvent: () => undefined,
    });
    runtimes.push(runtime);

    await expect(runtime.login("openai-codex", "oauth")).rejects.toThrow(
      "Authentication cancelled",
    );
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/),
    );
  });

  it("reports environment OpenAI credentials as externally managed", async () => {
    const directory = await createTemporaryDirectory();
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    try {
      const runtime = await createCakeRuntime({
        cwd: directory,
        agentDir: join(directory, "agent"),
        sessionDir: join(directory, "sessions"),
        trusted: false,
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      runtimes.push(runtime);

      const openai = (await runtime.snapshot()).models.find((model) => model.provider === "openai");
      expect(openai).toMatchObject({
        authenticated: true,
        authSource: "environment",
        authLabel: "OPENAI_API_KEY",
      });
      await expect(runtime.logout("openai")).rejects.toThrow("managed outside Cake");
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("detects project-local executable resources before loading them", async () => {
    const directory = await createTemporaryDirectory();
    await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "extensions", "example.ts"),
      "export default () => {}\n",
    );

    expect(inspectWorkspace(directory)).toEqual({ path: directory, trustRequired: true });
  });

  it("persists Cake runtime settings and reloads Pi resources", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const onEvent = vi.fn();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir: join(directory, "sessions"),
      trusted: false,
      requestUi: async () => undefined,
      onEvent,
    });
    runtimes.push(runtime);

    await runtime.setPiSetting({ key: "retryEnabled", value: false });
    await runtime.setPiSetting({ key: "shellPath", value: "/bin/zsh" });
    await runtime.setPiSetting({
      key: "npmCommand",
      value: ["mise", "exec", "node@22", "--", "npm"],
    });
    await runtime.setPiSetting({ key: "skills", value: ["skills", "!skills/excluded"] });
    await runtime.reload?.();

    expect((await runtime.snapshot()).piSettings).toMatchObject({
      retryEnabled: false,
      shellPath: "/bin/zsh",
      npmCommand: ["mise", "exec", "node@22", "--", "npm"],
      skills: ["skills", "!skills/excluded"],
      reloadPending: false,
    });
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
      retry: { enabled: false },
      shellPath: "/bin/zsh",
      npmCommand: ["mise", "exec", "node@22", "--", "npm"],
      skills: ["skills", "!skills/excluded"],
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "part-removed",
      sessionId: runtime.sessionId,
      partId: "pi-reload-status",
    });
  });

  it("creates and reopens an authoritative persistent Pi session", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const first = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(first);
    const firstSnapshot = await first.snapshot();

    expect(first.sessionFile).toMatch(/\.jsonl$/);
    expect(firstSnapshot.sessionId).toBe(first.sessionId);
    expect(firstSnapshot.parts).toEqual([]);
    expect(firstSnapshot.sessions).toEqual([
      expect.objectContaining({
        id: first.sessionId,
        title: "New chat",
        messageCount: 0,
      }),
    ]);
    expect(firstSnapshot.piSettings).toMatchObject({
      autoCompact: true,
      steeringMode: "one-at-a-time",
      transport: "auto",
    });
    await first.setPiSetting({ key: "autoCompact", value: false });
    await first.setPiSetting({ key: "steeringMode", value: "all" });
    expect((await first.snapshot()).piSettings).toMatchObject({
      autoCompact: false,
      steeringMode: "all",
    });
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
      compaction: { enabled: false },
      steeringMode: "all",
    });
    first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    await mkdir(sessionDir, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(
      first.sessionFile,
      [
        { type: "session", version: 3, id: first.sessionId, timestamp, cwd: directory },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [
              { type: "text", text: "Hello" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
            timestamp: Date.now(),
          },
        },
        {
          type: "custom",
          id: "review-start",
          parentId: "user-1",
          timestamp,
          customType: "cake.review-run/v1",
          data: {
            operationId: "00000000-0000-4000-8000-000000000001",
            threadIds: ["review-1"],
            commentCount: 1,
            status: "running",
          },
        },
        {
          type: "message",
          id: "assistant-tools",
          parentId: "review-start",
          timestamp,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
        {
          type: "message",
          id: "tool-result",
          parentId: "assistant-tools",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "result" }],
            isError: false,
            timestamp: Date.now(),
          },
        },
        {
          type: "custom",
          id: "compacted-review-start",
          parentId: "tool-result",
          timestamp,
          customType: "cake.review-run/v1",
          data: {
            operationId: "00000000-0000-4000-8000-000000000002",
            threadIds: ["review-2"],
            commentCount: 2,
            status: "running",
          },
        },
        {
          type: "custom",
          id: "compacted-review-complete",
          parentId: "compacted-review-start",
          timestamp,
          customType: "cake.review-run/v1",
          data: {
            operationId: "00000000-0000-4000-8000-000000000002",
            threadIds: ["review-2"],
            commentCount: 2,
            status: "complete",
          },
        },
        {
          type: "message",
          id: "assistant-edit",
          parentId: "compacted-review-complete",
          timestamp,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-edit",
                name: "edit",
                arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
        {
          type: "message",
          id: "edit-result",
          parentId: "assistant-edit",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "call-edit",
            toolName: "edit",
            content: [{ type: "text", text: "Applied" }],
            details: { diff: "-1 old\n+1 new", patch: "@@ -1 +1 @@\n-old\n+new" },
            isError: false,
            timestamp: Date.now(),
          },
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "edit-result",
          timestamp,
          summary: "Earlier work compacted",
          firstKeptEntryId: "assistant-edit",
          tokensBefore: 10,
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "compaction-1",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
        {
          type: "custom",
          id: "review-complete",
          parentId: "assistant-1",
          timestamp,
          customType: "cake.review-run/v1",
          data: {
            operationId: "00000000-0000-4000-8000-000000000001",
            threadIds: ["review-1"],
            commentCount: 1,
            status: "complete",
          },
        },
        {
          type: "message",
          id: "assistant-error",
          parentId: "review-complete",
          timestamp,
          message: {
            role: "assistant",
            content: [],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: "Subscription authentication failed",
            timestamp: Date.now(),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const preview = await loadWorkspaceSessionPreview(directory, first.sessionId, sessionDir);
    expect(preview?.parts.some((part) => part.kind === "text" && part.text === "Hi")).toBe(true);
    expect(preview?.parts.some((part) => part.kind === "tool" && part.name === "read")).toBe(true);
    expect(preview?.parts).toContainEqual(
      expect.objectContaining({
        kind: "attachment",
        attachmentKind: "image",
        mediaType: "image/png",
        data: "aW1hZ2U=",
      }),
    );
    expect(preview?.parts).toContainEqual(
      expect.objectContaining({
        kind: "notice",
        tone: "error",
        detail: "Subscription authentication failed",
      }),
    );
    expect(preview?.parts).toContainEqual(
      expect.objectContaining({
        kind: "compaction",
        summary: "Earlier work compacted",
        tokensBefore: 10,
      }),
    );
    expect(preview?.parts).toContainEqual(
      expect.objectContaining({
        kind: "review-run",
        operationId: "00000000-0000-4000-8000-000000000001",
        status: "complete",
      }),
    );
    expect(preview?.parts.findIndex((part) => part.kind === "review-run")).toBeLessThan(
      preview?.parts.findIndex((part) => part.kind === "tool") ?? -1,
    );

    const second = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(second);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionFile).toBe(first.sessionFile);
    const reopenedParts = (await second.snapshot()).parts;
    expect(reopenedParts.some((part) => part.kind === "text" && part.text === "Hi")).toBe(true);
    expect(reopenedParts.filter((part) => part.kind === "review-run")).toEqual([
      expect.objectContaining({
        operationId: "00000000-0000-4000-8000-000000000001",
        status: "complete",
      }),
      expect.objectContaining({
        operationId: "00000000-0000-4000-8000-000000000002",
        status: "complete",
      }),
    ]);
    expect(reopenedParts.filter((part) => part.kind === "tool")).toEqual([
      expect.objectContaining({ id: "tool-call-1", name: "read", state: "success" }),
      expect.objectContaining({
        id: "tool-call-edit",
        name: "edit",
        filePath: "src/app.ts",
        diff: "-1 old\n+1 new",
        state: "success",
      }),
    ]);
    expect(reopenedParts).toContainEqual(
      expect.objectContaining({ kind: "text", role: "user", text: "Hello" }),
    );
    expect(reopenedParts).toContainEqual(
      expect.objectContaining({ kind: "compaction", summary: "Earlier work compacted" }),
    );
    expect((await second.snapshot()).tree[0]).toMatchObject({ id: "user-1", active: true });
    await second.rename("Named session");
    expect(
      (await second.snapshot()).sessions.find((item) => item.id === second.sessionId)?.title,
    ).toBe("Named session");
    await second.navigate("assistant-tools");
    expect((await second.snapshot()).tree[0]).toMatchObject({ id: "user-1", active: true });
    const fork = await second.fork("user-1");
    expect(fork.sessionId).not.toBe(second.sessionId);
    expect(fork.sessionFile.startsWith(`${sessionDir}/`)).toBe(true);
    expect(fork.sessionFile).toMatch(/\.jsonl$/);

    const isolated = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      newSession: true,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(isolated);
    expect(isolated.sessionId).not.toBe(second.sessionId);
    expect((await isolated.snapshot()).parts).toEqual([]);
  });

  it("keeps long linear Pi sessions shallow enough for Electron's context bridge", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const workspaceSessionDir = cakeWorkspaceSessionDirectory(directory, sessionDir);
    const sessionFile = join(workspaceSessionDir, "deep-session.jsonl");
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const entries: object[] = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: directory },
    ];
    for (let index = 0; index < 600; index += 1) {
      entries.push({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        timestamp,
        message: { role: "user", content: `Message ${index}`, timestamp: Date.now() + index },
      });
    }
    await mkdir(workspaceSessionDir, { recursive: true });
    await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      sessionFile,
      trusted: false,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(runtime);

    const snapshot = await runtime.snapshot();
    const messageEntries = snapshot.tree.filter((entry) => entry.id.startsWith("message-"));
    expect(messageEntries).toHaveLength(600);
    expect(messageEntries.at(-1)).toMatchObject({ id: "message-599", parentId: "message-598" });
    expect(snapshot.tree.every((entry) => !("children" in entry))).toBe(true);
    expect(maximumObjectDepth(snapshot)).toBeLessThan(100);
  });
});

describe("S3 Pi ecosystem compatibility", () => {
  it("isolates standalone Pi resources while retaining Cake's required resources", async () => {
    const directory = await createTemporaryDirectory();
    const standaloneHome = join(directory, "standalone-home");
    const standaloneAgent = join(standaloneHome, ".pi", "agent");
    const agentDir = join(directory, "cake-home", "pi");
    await Promise.all([
      mkdir(join(standaloneAgent, "extensions"), { recursive: true }),
      mkdir(join(agentDir, "extensions"), { recursive: true }),
    ]);
    await writeFile(
      join(standaloneAgent, "extensions", "standalone.ts"),
      `export default function (pi) { pi.registerCommand("standalone-only", { handler() {} }); }\n`,
    );
    await writeFile(
      join(agentDir, "extensions", "cake-only.ts"),
      `export default function (pi) { pi.registerCommand("cake-only", { handler() {} }); }\n`,
    );
    const previousHome = process.env.HOME;
    process.env.HOME = standaloneHome;
    try {
      const runtime = await createCakeRuntime({
        cwd: directory,
        agentDir,
        sessionDir: join(agentDir, "sessions"),
        trusted: false,
        newSession: true,
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      runtimes.push(runtime);
      const snapshot = await runtime.snapshot();

      expect(snapshot.commands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "standalone-only" })]),
      );
      expect(snapshot.commands).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "cake-only" })]),
      );
      expect(snapshot.compatibility.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "skill", name: "cake-plugin-authoring" }),
          expect.objectContaining({ kind: "extension", tools: ["ui_request"] }),
        ]),
      );
      expect(
        snapshot.compatibility.resources.some((resource) =>
          resource.path?.startsWith(standaloneAgent),
        ),
      ).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("discovers packaged resources and projects primitive and degraded extension UI", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const packageDir = join(directory, "fixture-package");
    await mkdir(join(directory, ".pi"), { recursive: true });
    await mkdir(join(packageDir, "extensions"), { recursive: true });
    await mkdir(join(packageDir, "skills", "fixture-skill"), { recursive: true });
    await mkdir(join(packageDir, "prompts"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "settings.json"),
      JSON.stringify({ packages: [packageDir] }),
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "cake-compat-fixture",
        version: "1.0.0",
        pi: { extensions: ["extensions/compat.ts"], skills: ["skills"], prompts: ["prompts"] },
      }),
    );
    await writeFile(
      join(packageDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Fixture skill\n---\nUse the fixture.\n",
    );
    await writeFile(
      join(packageDir, "prompts", "fixture-prompt.md"),
      "---\ndescription: Fixture prompt\n---\nFixture prompt body.\n",
    );
    await writeFile(
      join(packageDir, "extensions", "compat.ts"),
      `
export default function (pi) {
  pi.registerProvider("fixture-provider", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture", api: "openai-completions", models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }] });
  pi.registerTool({ name: "mcp_fixture_lookup", label: "MCP fixture", description: "Headless MCP-style fixture", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  pi.registerCommand("cake-compat", { description: "Exercise desktop primitives", async handler(_args, ctx) {
    ctx.ui.notify("Fixture notification", "warning");
    ctx.ui.setStatus("fixture", "Ready");
    ctx.ui.setTitle("Fixture title");
    ctx.ui.setEditorText("fixture draft");
    ctx.ui.setWidget("fixture-widget", ["line one", "line two"], { placement: "belowEditor" });
    await ctx.ui.select("Choose", ["one", "two"]);
    await ctx.ui.input("Input", "placeholder");
    await ctx.ui.editor("Editor", "prefill");
    ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
    await ctx.ui.custom(() => ({ render: () => [], invalidate() {} }));
  } });
}
`,
    );
    const events: Array<{ type: string; event?: { kind: string } }> = [];
    const requests: string[] = [];
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir: join(directory, "sessions"),
      trusted: true,
      requestUi: async (request) => {
        requests.push(request.kind);
        return request.kind === "select" ? "one" : request.kind === "editor" ? "edited" : "value";
      },
      onEvent: (event) => events.push(event),
    });
    runtimes.push(runtime);

    const firstSnapshot = await runtime.snapshot();
    expect(() => sessionSnapshotSchema.parse(firstSnapshot)).not.toThrow();
    expect(firstSnapshot.usage).toMatchObject({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
    const catalog = firstSnapshot.compatibility;
    expect(firstSnapshot.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "compact", source: "builtin" }),
        expect.objectContaining({ name: "model", source: "builtin" }),
        expect.objectContaining({ name: "name", source: "builtin" }),
        expect.objectContaining({ name: "cake-compat", source: "extension" }),
        expect.objectContaining({ name: "fixture-prompt", source: "prompt" }),
        expect.objectContaining({ name: "skill:fixture-skill", source: "skill" }),
        expect.objectContaining({ name: "skill:cake-plugin-authoring", source: "skill" }),
      ]),
    );
    expect(firstSnapshot.commands.slice(0, 3).map((command) => command.name)).toEqual([
      "compact",
      "model",
      "name",
    ]);
    expect(catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "package", name: packageDir }),
        expect.objectContaining({ kind: "skill", name: "fixture-skill" }),
        expect.objectContaining({ kind: "skill", name: "cake-plugin-authoring" }),
        expect.objectContaining({ kind: "prompt", name: "fixture-prompt" }),
        expect.objectContaining({
          kind: "extension",
          commands: ["cake-compat"],
          tools: ["mcp_fixture_lookup"],
        }),
      ]),
    );
    expect(firstSnapshot.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "fixture-provider", id: "fixture-model" }),
      ]),
    );

    await runtime.prompt("/cake-compat", "prompt", []);
    const snapshot = await runtime.snapshot();
    expect(requests).toEqual(["select", "text", "editor"]);
    expect(snapshot.extensionUi).toMatchObject({
      title: "Fixture title",
      statuses: [{ key: "fixture", text: "Ready" }],
    });
    expect(
      events.some((event) => event.type === "extension-ui" && event.event?.kind === "notify"),
    ).toBe(true);
    expect(snapshot.compatibility.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "compatibility", method: "setFooter" }),
        expect.objectContaining({ source: "compatibility", method: "custom" }),
        expect.objectContaining({ source: "compatibility", method: "setWidget" }),
      ]),
    );
  });

  it("loads Pi's shipped subagent extension unchanged when available", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const packageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
    const subagentPath = join(packageRoot, "examples", "extensions", "subagent", "index.ts");
    await mkdir(join(directory, ".pi"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "settings.json"),
      JSON.stringify({ packages: [subagentPath] }),
    );
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir: join(directory, "sessions"),
      trusted: true,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(runtime);
    const extension = (await runtime.snapshot()).compatibility.resources.find(
      (item) => item.kind === "extension" && item.path?.includes("subagent"),
    );
    expect(extension?.tools).toContain("subagent");
  });
});
