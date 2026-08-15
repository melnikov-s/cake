import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cakePluginAuthoringSkillPath,
  cakeWorkspaceSessionDirectory,
  createCakeArtifactExtension,
  createCakeRuntime,
  createFoundationRuntime,
  createLiveMessageProjector,
  inspectWorkspace,
  loadPiChangelog,
  loadWorkspaceSessionPreview,
  listWorkspaceSessions,
  piRuntimeVersion,
  runReviewTurn,
  suggestProjectFiles,
  type CakeRuntime,
  type FoundationRuntime
} from "../../../src/agent/pi-runtime";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import { sessionSnapshotSchema } from "../../../src/ipc/session-contract";

const temporaryDirectories: string[] = [];
const runtimes: Array<FoundationRuntime | CakeRuntime> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
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
      generateInlineWidget: async () => ({ language: "react", source: "export default () => null", generationSessionId: "generation-1" }),
      onEvent: () => undefined
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
      execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: { model?: { provider: string; id: string }; sessionManager: { getSessionId(): string } }): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
    };
    let widgetTool: RegisteredTool | undefined;
    const pointers: Array<{ type: string; data: unknown }> = [];
    const persisted: CakeArtifactV1[] = [];
    const source = "export default () => <strong>Private source</strong>";
    const extension = createCakeArtifactExtension({
      persistArtifact: async (artifact) => {
        persisted.push(artifact);
        return { artifact, workspacePath: "/project", digest: "a".repeat(64), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
      },
      requestArtifact: async () => undefined,
      generateInlineWidget: async () => ({ language: "react", source, generationSessionId: "generation-1" })
    });
    (extension as unknown as (pi: unknown) => void)({
      registerTool(tool: unknown) { const registered = tool as RegisteredTool; if (registered.name === "ui_widget") widgetTool = registered; },
      registerCommand() {},
      appendEntry(type: string, data: unknown) { pointers.push({ type, data }); }
    } as never);
    if (!widgetTool) throw new Error("Expected ui_widget to be registered");

    const result = await widgetTool.execute("call-1", { widget: { id: "widget-1", title: "Comparison", brief: "Compare these values", data: [1, 2], fallback: { markdown: "Values 1 and 2." } } }, undefined, undefined, { model: { provider: "fixture", id: "model" }, sessionManager: { getSessionId: () => "session-1" } });

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
    await writeFile(join(workspaceSessionDir, "long-title.jsonl"), [
      { type: "session", version: 3, id: "long-title", timestamp, cwd: directory },
      { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "x".repeat(2_048) }], timestamp: Date.now() } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const [summary] = await listWorkspaceSessions(directory, sessionDir);

    expect(summary).toBeDefined();
    if (!summary) throw new Error("Expected Pi to list the session fixture");
    expect(summary.title).toBe("x".repeat(1_024));
    expect(() => sessionSnapshotSchema.shape.sessions.parse([summary])).not.toThrow();
  });

  it("persists Git checkpoints in the Pi session branch and reloads them", async () => {
    const directory = await createTemporaryDirectory();
    const sessionDir = join(directory, "sessions");
    const agentDir = join(directory, "agent");
    let capture = 0;
    const first = await createCakeRuntime({
      cwd: directory, agentDir, sessionDir, trusted: false, newSession: true,
      requestUi: async () => undefined,
      captureGitCheckpoint: async () => ({ tree: String(++capture).padStart(40, "a"), ref: `refs/cake/checkpoints/${capture}` }),
      onEvent: () => undefined
    });
    runtimes.push(first);

    const initial = await first.ensureInitialGitCheckpoint!();
    const latest = await first.captureLatestGitCheckpoint!();
    expect(first.gitCheckpoints!().map((checkpoint) => checkpoint.tree)).toEqual([initial?.tree, latest?.tree]);
    const sessionId = first.sessionId;
    const sessionFile = first.sessionFile;
    first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    const timestamp = new Date().toISOString();
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: directory },
      { type: "custom", id: "checkpoint-1", parentId: null, timestamp, customType: "cake.git-checkpoint/v1", data: initial },
      { type: "custom", id: "checkpoint-2", parentId: "checkpoint-1", timestamp, customType: "cake.git-checkpoint/v1", data: latest },
      { type: "message", id: "assistant-1", parentId: "checkpoint-2", timestamp, message: { role: "assistant", content: [{ type: "text", text: "done" }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const second = await createCakeRuntime({
      cwd: directory, agentDir, sessionDir, trusted: false, sessionId, sessionFile,
      requestUi: async () => undefined,
      captureGitCheckpoint: async () => ({ tree: "f".repeat(40), ref: "refs/cake/checkpoints/f" }),
      onEvent: () => undefined
    });
    runtimes.push(second);

    expect(await second.ensureInitialGitCheckpoint!()).toMatchObject({ tree: initial?.tree });
    expect(second.gitCheckpoints!().map((checkpoint) => checkpoint.tree)).toEqual([initial?.tree, latest?.tree]);
    const reviewRun = { operationId: "00000000-0000-4000-8000-000000000003", threadIds: ["review-3"], commentCount: 1 };
    second.recordReviewRun({ ...reviewRun, status: "running" });
    second.recordReviewRun({ ...reviewRun, status: "complete" });
    expect((await second.snapshot()).parts.filter((part) => part.kind === "review-run")).toEqual([
      expect.objectContaining({ ...reviewRun, status: "complete" })
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
    await writeFile(parentFile, [
      { type: "session", version: 3, id: "parent-session", timestamp, cwd: directory },
      { type: "message", id: "parent-user", parentId: null, timestamp, message: { role: "user", content: "Build the feature", timestamp: 0 } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const controller = new AbortController();
    controller.abort();
    const thread = {
      id: "review-1", workspacePath: directory, sessionId: "parent-session", status: "open" as const, createdAt: timestamp, updatedAt: timestamp,
      anchor: { path: "src/app.ts", start: { diffLine: 1 }, end: { diffLine: 1 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" },
      pendingComments: [{ id: "comment-1", body: "Rename this", createdAt: timestamp }]
    };

    await expect(runReviewTurn({
      cwd: directory, trusted: false, thread, sessionDir: reviewDir, parentSessionRoot: parentDir, agentDir, signal: controller.signal,
      parent: { sessionId: "parent-session", sessionFile: parentFile, leafId: "parent-user" }
    })).rejects.toThrow("cancelled");

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
    await writeFile(parentFile, [
      { type: "session", version: 3, id: "parent-session", timestamp, cwd: directory },
      { type: "message", id: "parent-user", parentId: null, timestamp, message: { role: "user", content: "Draft a plan", timestamp: 0 } },
      { type: "message", id: "parent-assistant", parentId: "parent-user", timestamp, message: { role: "assistant", content: [{ type: "text", text: "The original plan" }], timestamp: 0 } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const controller = new AbortController();
    controller.abort();
    const thread = {
      id: "comment-1", workspacePath: directory, sessionId: "parent-session", status: "open" as const, createdAt: timestamp, updatedAt: timestamp,
      anchor: { path: "session:parent-session/message/assistant", view: "message" as const, messageId: "assistant", entryId: "parent-assistant", startOffset: 4, endOffset: 12, start: { diffLine: 0 }, end: { diffLine: 0 }, selectedText: "original", contextBefore: "The ", contextAfter: " plan", diff: "" },
      pendingComments: [{ id: "question-1", body: "Why original?", createdAt: timestamp }]
    };

    await expect(runReviewTurn({
      cwd: directory, trusted: false, thread, sessionDir: reviewDir, parentSessionRoot: parentDir, agentDir, signal: controller.signal,
      parent: { sessionId: "parent-session", sessionFile: parentFile, leafId: "parent-assistant", model: { provider: "fixture", id: "model" } }
    })).rejects.toThrow("cancelled");

    const projection = await readFile(join(reviewDir, "context", "parent-transcript.md"), "utf8");
    expect(projection).toContain("Draft a plan");
    expect(projection).toContain("The original plan");
    expect((await readdir(reviewDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("gives assistant messages on either side of a tool call distinct live positions", () => {
    const project = createLiveMessageProjector();
    const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    const event = (value: object) => value as AgentSessionEvent;

    project(event({ type: "message_start", message: assistant("") }));
    const beforeTool = project(event({ type: "message_update", message: assistant("I'll inspect that."), assistantMessageEvent: { type: "text_delta", delta: "I'll inspect that." } }));
    project(event({ type: "message_end", message: assistant("I'll inspect that.") }));
    project(event({ type: "message_start", message: assistant("") }));
    const afterTool = project(event({ type: "message_update", message: assistant("Here is the result."), assistantMessageEvent: { type: "text_delta", delta: "Here is the result." } }));

    expect(beforeTool[0]).toMatchObject({ id: "stream-1-text-0", text: "I'll inspect that." });
    expect(afterTool[0]).toMatchObject({ id: "stream-2-text-0", text: "Here is the result." });
  });

  it("projects bash tool calls as commands instead of JSON arguments", () => {
    const project = createLiveMessageProjector();
    const message = { role: "assistant", content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 5" } }] };
    project({ type: "message_start", message } as unknown as AgentSessionEvent);
    const parts = project({
      type: "message_end",
      message
    } as unknown as AgentSessionEvent);

    expect(parts[0]).toMatchObject({ kind: "tool", name: "bash", input: "sleep 5" });
  });

  it("loads Pi's bundled changelog through its public package directory", () => {
    expect(loadPiChangelog()).toContain("# Changelog");
    expect(loadPiChangelog()).toContain("0.84.0");
  });

  it("resolves Cake's bundled authoring skill from the matching source tree", () => {
    expect(cakePluginAuthoringSkillPath("/cake-authoring")).toBe(join("/cake-authoring", ".agents", "skills", "cake-plugin-authoring"));
  });

  it("uses Pi's fuzzy @ provider for project file suggestions", async () => {
    const directory = await createTemporaryDirectory();
    const fakeFd = join(directory, "fd");
    await writeFile(fakeFd, "#!/bin/sh\nprintf 'src/\\nsrc/app.ts\\ntests/app.test.ts\\n'\n");
    await chmod(fakeFd, 0o755);

    expect(await suggestProjectFiles({ cwd: directory, prefix: "app", agentDir: join(directory, "agent"), fdPath: fakeFd })).toEqual([
      { value: "@src/app.ts", label: "app.ts", description: "src/app.ts" },
      { value: "@tests/app.test.ts", label: "app.test.ts", description: "tests/app.test.ts" }
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
      onEvent: (event) => events.push(event)
    });
    runtimes.push(runtime);

    expect(piRuntimeVersion).toBe("0.84.0");
    expect(runtime.sessionFile).toBeUndefined();
    expect(runtime.sessionId).toBeTruthy();

    await runtime.run();

    expect(requestConfirm).toHaveBeenCalledWith(
      "Pi extension confirmation",
      expect.stringContaining("Pi extension"),
      undefined
    );
    expect(events.find((event) => event.type === "session-ready")?.sessionId).toBe(runtime.sessionId);
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""))
      .toBe("Pi session boundary is alive.");
  });

  it("disposes idempotently and rejects later runs", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createFoundationRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      requestConfirm: async () => false,
      onEvent: () => undefined
    });

    runtime.dispose();
    runtime.dispose();

    await expect(runtime.run()).rejects.toThrow("disposed");
  });
});

describe("S1 Pi runtime", () => {
  it("enables Cake application tools in global chat without enabling coding tools", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "global-chat-sessions"),
      trusted: false,
      requestUi: async () => undefined,
      globalControl: {
        tools: [
          { name: "get_app_state", description: "Read Cake application state." },
          { name: "search_sessions", description: "Search Cake sessions." }
        ],
        invoke: async () => ({ ok: true })
      },
      onEvent: () => undefined
    });
    runtimes.push(runtime);

    expect(runtime.getReviewParentContext?.().activeTools).toEqual(["get_app_state", "search_sessions"]);
  });

  it("opens the OpenAI Codex browser login URL", async () => {
    const directory = await createTemporaryDirectory();
    const openExternal = vi.fn(async () => undefined);
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      trusted: false,
      requestUi: async (request) => request.kind === "select" ? "browser" : undefined,
      openExternal,
      onEvent: () => undefined
    });
    runtimes.push(runtime);

    await expect(runtime.login("openai-codex", "oauth")).rejects.toThrow("Authentication cancelled");
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/));
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
        onEvent: () => undefined
      });
      runtimes.push(runtime);

      const openai = (await runtime.snapshot()).models.find((model) => model.provider === "openai");
      expect(openai).toMatchObject({ authenticated: true, authSource: "environment", authLabel: "OPENAI_API_KEY" });
      await expect(runtime.logout("openai")).rejects.toThrow("managed outside Cake");
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("detects project-local executable resources before loading them", async () => {
    const directory = await createTemporaryDirectory();
    await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
    await writeFile(join(directory, ".pi", "extensions", "example.ts"), "export default () => {}\n");

    expect(inspectWorkspace(directory)).toEqual({ path: directory, trustRequired: true });
  });

  it("persists Cake runtime settings and reloads Pi resources", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const onEvent = vi.fn();
    const runtime = await createCakeRuntime({ cwd: directory, agentDir, sessionDir: join(directory, "sessions"), trusted: false, requestUi: async () => undefined, onEvent });
    runtimes.push(runtime);

    await runtime.setPiSetting({ key: "retryEnabled", value: false });
    await runtime.setPiSetting({ key: "shellPath", value: "/bin/zsh" });
    await runtime.setPiSetting({ key: "npmCommand", value: ["mise", "exec", "node@22", "--", "npm"] });
    await runtime.setPiSetting({ key: "skills", value: ["skills", "!skills/legacy"] });
    await runtime.reload?.();

    expect((await runtime.snapshot()).piSettings).toMatchObject({ retryEnabled: false, shellPath: "/bin/zsh", npmCommand: ["mise", "exec", "node@22", "--", "npm"], skills: ["skills", "!skills/legacy"], reloadPending: false });
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ retry: { enabled: false }, shellPath: "/bin/zsh", npmCommand: ["mise", "exec", "node@22", "--", "npm"], skills: ["skills", "!skills/legacy"] });
    expect(onEvent).toHaveBeenCalledWith({ type: "part-removed", sessionId: runtime.sessionId, partId: "pi-reload-status" });
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
      onEvent: () => undefined
    });
    runtimes.push(first);
    const firstSnapshot = await first.snapshot();

    expect(first.sessionFile).toMatch(/\.jsonl$/);
    expect(firstSnapshot.sessionId).toBe(first.sessionId);
    expect(firstSnapshot.parts).toEqual([]);
    expect(firstSnapshot.piSettings).toMatchObject({ autoCompact: true, steeringMode: "one-at-a-time", transport: "auto" });
    await first.setPiSetting({ key: "autoCompact", value: false });
    await first.setPiSetting({ key: "steeringMode", value: "all" });
    expect((await first.snapshot()).piSettings).toMatchObject({ autoCompact: false, steeringMode: "all" });
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({ compaction: { enabled: false }, steeringMode: "all" });
    first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    await mkdir(sessionDir, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(first.sessionFile, [
      { type: "session", version: 3, id: first.sessionId, timestamp, cwd: directory },
      { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Hello" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], timestamp: Date.now() } },
      { type: "custom", id: "review-start", parentId: "user-1", timestamp, customType: "cake.review-run/v1", data: { operationId: "00000000-0000-4000-8000-000000000001", threadIds: ["review-1"], commentCount: 1, status: "running" } },
      { type: "message", id: "assistant-tools", parentId: "review-start", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } },
      { type: "message", id: "tool-result", parentId: "assistant-tools", timestamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now() } },
      { type: "custom", id: "compacted-review-start", parentId: "tool-result", timestamp, customType: "cake.review-run/v1", data: { operationId: "00000000-0000-4000-8000-000000000002", threadIds: ["review-2"], commentCount: 2, status: "running" } },
      { type: "custom", id: "compacted-review-complete", parentId: "compacted-review-start", timestamp, customType: "cake.review-run/v1", data: { operationId: "00000000-0000-4000-8000-000000000002", threadIds: ["review-2"], commentCount: 2, status: "complete" } },
      { type: "message", id: "assistant-edit", parentId: "compacted-review-complete", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } },
      { type: "message", id: "edit-result", parentId: "assistant-edit", timestamp, message: { role: "toolResult", toolCallId: "call-edit", toolName: "edit", content: [{ type: "text", text: "Applied" }], details: { diff: "-1 old\n+1 new", patch: "@@ -1 +1 @@\n-old\n+new" }, isError: false, timestamp: Date.now() } },
      { type: "compaction", id: "compaction-1", parentId: "edit-result", timestamp, summary: "Earlier work compacted", firstKeptEntryId: "assistant-edit", tokensBefore: 10 },
      { type: "message", id: "assistant-1", parentId: "compaction-1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Hi" }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } },
      { type: "custom", id: "review-complete", parentId: "assistant-1", timestamp, customType: "cake.review-run/v1", data: { operationId: "00000000-0000-4000-8000-000000000001", threadIds: ["review-1"], commentCount: 1, status: "complete" } },
      { type: "message", id: "assistant-error", parentId: "review-complete", timestamp, message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "Subscription authentication failed", timestamp: Date.now() } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const preview = await loadWorkspaceSessionPreview(directory, first.sessionId, sessionDir);
    expect(preview?.parts.some((part) => part.kind === "text" && part.text === "Hi")).toBe(true);
    expect(preview?.parts.some((part) => part.kind === "tool" && part.name === "read")).toBe(true);
    expect(preview?.parts).toContainEqual(expect.objectContaining({ kind: "attachment", attachmentKind: "image", mediaType: "image/png", data: "aW1hZ2U=" }));
    expect(preview?.parts).toContainEqual(expect.objectContaining({ kind: "notice", tone: "error", detail: "Subscription authentication failed" }));
    expect(preview?.parts).toContainEqual(expect.objectContaining({ kind: "review-run", operationId: "00000000-0000-4000-8000-000000000001", status: "complete" }));
    expect(preview?.parts.findIndex((part) => part.kind === "review-run")).toBeLessThan(preview?.parts.findIndex((part) => part.kind === "tool") ?? -1);

    const second = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      requestUi: async () => undefined,
      onEvent: () => undefined
    });
    runtimes.push(second);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionFile).toBe(first.sessionFile);
    const reopenedParts = (await second.snapshot()).parts;
    expect(reopenedParts.some((part) => part.kind === "text" && part.text === "Hi")).toBe(true);
    expect(reopenedParts.filter((part) => part.kind === "review-run")).toEqual([
      expect.objectContaining({ operationId: "00000000-0000-4000-8000-000000000002", status: "complete" }),
      expect.objectContaining({ operationId: "00000000-0000-4000-8000-000000000001", status: "complete" })
    ]);
    expect(reopenedParts.filter((part) => part.kind === "tool")).toEqual([
      expect.objectContaining({ id: "tool-call-edit", name: "edit", filePath: "src/app.ts", diff: "-1 old\n+1 new", state: "success" })
    ]);
    expect((await second.snapshot()).tree[0]).toMatchObject({ id: "user-1", active: true });
    await second.rename("Named session");
    expect((await second.snapshot()).sessions.find((item) => item.id === second.sessionId)?.title).toBe("Named session");
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
      onEvent: () => undefined
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
    const entries: object[] = [{ type: "session", version: 3, id: sessionId, timestamp, cwd: directory }];
    for (let index = 0; index < 600; index += 1) {
      entries.push({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        timestamp,
        message: { role: "user", content: `Message ${index}`, timestamp: Date.now() + index }
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
      onEvent: () => undefined
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
    await Promise.all([mkdir(join(standaloneAgent, "extensions"), { recursive: true }), mkdir(join(agentDir, "extensions"), { recursive: true })]);
    await writeFile(join(standaloneAgent, "extensions", "standalone.ts"), `export default function (pi) { pi.registerCommand("standalone-only", { handler() {} }); }\n`);
    await writeFile(join(agentDir, "extensions", "cake-only.ts"), `export default function (pi) { pi.registerCommand("cake-only", { handler() {} }); }\n`);
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
        onEvent: () => undefined
      });
      runtimes.push(runtime);
      const snapshot = await runtime.snapshot();

      expect(snapshot.commands).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "standalone-only" })]));
      expect(snapshot.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: "cake-only" })]));
      expect(snapshot.compatibility.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "skill", name: "cake-plugin-authoring" }),
        expect.objectContaining({ kind: "extension", tools: ["ui_request"] })
      ]));
      expect(snapshot.compatibility.resources.some((resource) => resource.path?.startsWith(standaloneAgent))).toBe(false);
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
    await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({ packages: [packageDir] }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "cake-compat-fixture", version: "1.0.0", pi: { extensions: ["extensions/compat.ts"], skills: ["skills"], prompts: ["prompts"] } }));
    await writeFile(join(packageDir, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill\n---\nUse the fixture.\n");
    await writeFile(join(packageDir, "prompts", "fixture-prompt.md"), "---\ndescription: Fixture prompt\n---\nFixture prompt body.\n");
    await writeFile(join(packageDir, "extensions", "compat.ts"), `
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
`);
    const events: Array<{ type: string; event?: { kind: string } }> = [];
    const requests: string[] = [];
    const runtime = await createCakeRuntime({
      cwd: directory, agentDir, sessionDir: join(directory, "sessions"), trusted: true,
      requestUi: async (request) => { requests.push(request.kind); return request.kind === "select" ? "one" : request.kind === "editor" ? "edited" : "value"; },
      onEvent: (event) => events.push(event)
    });
    runtimes.push(runtime);

    const firstSnapshot = await runtime.snapshot();
    expect(() => sessionSnapshotSchema.parse(firstSnapshot)).not.toThrow();
    expect(firstSnapshot.usage).toMatchObject({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0
    });
    const catalog = firstSnapshot.compatibility;
    expect(firstSnapshot.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "settings", source: "builtin" }),
      expect.objectContaining({ name: "tree", source: "builtin" }),
      expect.objectContaining({ name: "quit", source: "builtin" }),
      expect.objectContaining({ name: "cake-compat", source: "extension" }),
      expect.objectContaining({ name: "fixture-prompt", source: "prompt" }),
      expect.objectContaining({ name: "skill:fixture-skill", source: "skill" }),
      expect.objectContaining({ name: "skill:cake-plugin-authoring", source: "skill" })
    ]));
    expect(firstSnapshot.commands.slice(0, 22).map((command) => command.name)).toEqual([
      "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session", "changelog", "hotkeys",
      "fork", "clone", "tree", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit"
    ]);
    expect(catalog.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "package", name: packageDir }),
      expect.objectContaining({ kind: "skill", name: "fixture-skill" }),
      expect.objectContaining({ kind: "skill", name: "cake-plugin-authoring" }),
      expect.objectContaining({ kind: "prompt", name: "fixture-prompt" }),
      expect.objectContaining({ kind: "extension", commands: ["cake-compat"], tools: ["mcp_fixture_lookup"] })
    ]));
    expect(firstSnapshot.models).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "fixture-provider", id: "fixture-model" })]));

    await runtime.prompt("/cake-compat", "prompt", []);
    const snapshot = await runtime.snapshot();
    expect(requests).toEqual(["select", "text", "editor"]);
    expect(snapshot.extensionUi).toMatchObject({ title: "Fixture title", statuses: [{ key: "fixture", text: "Ready" }], widgets: [{ key: "fixture-widget", lines: ["line one", "line two"], placement: "belowEditor" }] });
    expect(events.some((event) => event.type === "extension-ui" && event.event?.kind === "notify")).toBe(true);
    expect(snapshot.compatibility.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "compatibility", method: "setFooter" }),
      expect.objectContaining({ source: "compatibility", method: "custom" })
    ]));
  });

  it("loads Pi's shipped subagent extension unchanged when available", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const packageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
    const subagentPath = join(packageRoot, "examples", "extensions", "subagent", "index.ts");
    await mkdir(join(directory, ".pi"), { recursive: true });
    await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({ packages: [subagentPath] }));
    const runtime = await createCakeRuntime({ cwd: directory, agentDir, sessionDir: join(directory, "sessions"), trusted: true, requestUi: async () => undefined, onEvent: () => undefined });
    runtimes.push(runtime);
    const extension = (await runtime.snapshot()).compatibility.resources.find((item) => item.kind === "extension" && item.path?.includes("subagent"));
    expect(extension?.tools).toContain("subagent");
  });
});
