import { describe, expect, it, vi } from "vitest";
import type { CakeRuntime, CakeRuntimeOptions } from "../../../src/agent/pi-runtime";
import type { DesktopEvent } from "../../../src/ipc/desktop-ipc";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { PiWorkspaceDriver } from "../../../src/main/pi-workspace-driver";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/one.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [], widgets: [] },
  sessions: [],
  tree: []
};

describe("PiWorkspaceDriver", () => {
  it("routes auxiliary review replies without appending a primary session snapshot", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile, snapshot: vi.fn(async () => snapshot), prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
    };
    const now = new Date(0).toISOString();
    const thread = { id: "review-1", workspacePath: "/project", sessionId: snapshot.sessionId, status: "open" as const, createdAt: now, updatedAt: now, anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" }, pendingComments: [{ id: "message-1", body: "Rename this", createdAt: now }] };
    const projected = { ...thread, agentSessionId: "review-session", messages: [{ id: "message-1", role: "user" as const, body: "Rename this", createdAt: now, delivered: true, status: "complete" as const }, { id: "message-2", role: "assistant" as const, body: "Renamed.", createdAt: now, delivered: true, status: "complete" as const }] };
    const reviewRepository = { get: vi.fn(async () => thread), agentSessionDirectory: vi.fn(() => "/reviews/review-1"), attachAgentSession: vi.fn(async () => projected) };
    const runReview = vi.fn(async () => ({ sessionId: "review-session", sessionFile: "/reviews/review-1/session.jsonl" }));
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime: vi.fn(async () => runtime), reviewRepository, runReviewTurn: runReview });
    const openId = crypto.randomUUID();
    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", trusted: true, newSession: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));
    events.splice(0);

    const requestId = crypto.randomUUID();
    driver.dispatch({ type: "submit-review-threads", requestId, workspacePath: "/project", sessionId: snapshot.sessionId, threadIds: [thread.id] });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId }));

    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ thread }));
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ sessionDir: "/reviews/review-1" }));
    expect(reviewRepository.attachAgentSession).toHaveBeenCalledWith("/project", snapshot.sessionId, thread.id, expect.objectContaining({ sessionId: "review-session" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "review-thread-updated", thread: expect.objectContaining({ id: thread.id }) }));
    expect(events.some((event) => event.type === "session-snapshot")).toBe(false);
    expect(runtime.prompt).not.toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("opens a dormant session before renaming it", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: "session-2",
      sessionFile: "/sessions/two.jsonl",
      snapshot: vi.fn(async () => ({ ...snapshot, sessionId: "session-2", sessionFile: "/sessions/two.jsonl" })),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(async () => undefined),
      setPiSetting: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn()
    };
    const createRuntime = vi.fn(async () => runtime);
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime });
    const operationId = crypto.randomUUID();

    driver.dispatch({ type: "rename-session", requestId: operationId, workspacePath: "/project", sessionId: "session-2", name: "Renamed" });

    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: operationId }));
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ newSession: false, sessionId: "session-2" }));
    expect(runtime.rename).toHaveBeenCalledWith("Renamed");
    driver[Symbol.dispose]();
  });

  it("owns Pi directly and correlates extension UI without an internal transport", async () => {
    const events: DesktopEvent[] = [];
    let options: CakeRuntimeOptions | undefined;
    let promptSettled = 0;
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => {
        options?.onEvent({ type: "part-updated", sessionId: snapshot.sessionId, part: { id: "user-1", kind: "text", role: "user", text: "hello", status: "complete" } });
        options?.onEvent({ type: "extension-ui", sessionId: snapshot.sessionId, event: { kind: "status", key: "fixture", text: "running" } });
        await options?.requestUi({ kind: "confirm", title: "Continue?", message: "Confirm" });
        promptSettled += 1;
      }),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(async () => undefined),
      setPiSetting: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn()
    };
    const createRuntime = vi.fn(async (next: CakeRuntimeOptions) => {
      options = next;
      return runtime;
    });
    const openExternal = vi.fn(async () => undefined);
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime, openExternal });
    const openId = crypto.randomUUID();

    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", trusted: true, newSession: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === openId)).toBe(true));
    expect(createRuntime).toHaveBeenCalledOnce();
    await options?.openExternal?.("https://auth.example.test/");
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/");
    expect(events).toContainEqual({ type: "session-snapshot", requestId: openId, snapshot });

    const refreshId = crypto.randomUUID();
    driver.dispatch({ type: "refresh-session", requestId: refreshId, workspacePath: "/project", sessionId: snapshot.sessionId });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: refreshId }));
    expect(events).toContainEqual({ type: "session-snapshot", snapshot });

    const changelogId = crypto.randomUUID();
    driver.dispatch({ type: "get-changelog", requestId: changelogId, workspacePath: "/project", sessionId: snapshot.sessionId });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === changelogId)).toBe(true));
    expect(events).toContainEqual(expect.objectContaining({
      type: "changelog-snapshot",
      requestId: changelogId,
      workspacePath: "/project",
      sessionId: snapshot.sessionId,
      markdown: expect.stringContaining("0.84.0")
    }));

    const settingId = crypto.randomUUID();
    driver.dispatch({ type: "set-pi-setting", requestId: settingId, workspacePath: "/project", sessionId: snapshot.sessionId, update: { key: "autoCompact", value: false } });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: settingId }));
    expect(runtime.setPiSetting).toHaveBeenCalledWith({ key: "autoCompact", value: false });

    const promptId = crypto.randomUUID();
    driver.dispatch({ type: "prompt", requestId: promptId, workspacePath: "/project", sessionId: snapshot.sessionId, text: "hello", delivery: "prompt", attachments: [] });
    await vi.waitFor(() => expect(events.some((event) => event.type === "ui-request" && event.requestId === promptId)).toBe(true));
    await vi.waitFor(() => expect(events.some((event) => event.type === "session-snapshot" && event.requestId === undefined)).toBe(true));
    expect(promptSettled).toBe(0);
    expect(events).toContainEqual({ type: "extension-ui", sessionId: snapshot.sessionId, event: { kind: "status", key: "fixture", text: "running" } });
    const request = events.find((event): event is Extract<DesktopEvent, { type: "ui-request" }> => event.type === "ui-request" && event.requestId === promptId)!;
    driver.dispatch({ type: "respond-ui", requestId: promptId, workspacePath: "/project", sessionId: snapshot.sessionId, uiRequestId: request.uiRequestId, value: "true", cancelled: false });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === promptId)).toBe(true));

    const pendingId = crypto.randomUUID();
    driver.dispatch({ type: "prompt", requestId: pendingId, workspacePath: "/project", sessionId: snapshot.sessionId, text: "pending", delivery: "prompt", attachments: [] });
    await vi.waitFor(() => expect(events.some((event) => event.type === "ui-request" && event.requestId === pendingId)).toBe(true));
    driver[Symbol.dispose]();
    await vi.waitFor(() => expect(promptSettled).toBe(2));
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("persists, emits, correlates, and terminally settles artifact requests", async () => {
    const events: DesktopEvent[] = [];
    let options: CakeRuntimeOptions | undefined;
    let response: unknown = "pending";
    const artifact = { protocol: "cake.artifact/v1" as const, id: "form-1", sessionId: snapshot.sessionId, revision: 1, kind: "form" as const, payload: { fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }], submitLabel: "Send" }, fallback: { markdown: "Answer" }, interaction: { mode: "request" as const } };
    const repository = {
      upsert: vi.fn(async (workspacePath: string, next: unknown) => ({ artifact: next as typeof artifact, workspacePath, digest: "a".repeat(64), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })),
      get: vi.fn(async () => undefined),
      linkSession: vi.fn(async () => undefined),
      listSession: vi.fn(async () => [])
    };
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile, snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => { const record = await options!.persistArtifact!(artifact); response = await options!.requestArtifact!(record, new AbortController().signal); }),
      abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
    };
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", artifactRepository: repository, emit: (event) => events.push(event), createRuntime: vi.fn(async (next) => { options = next; return runtime; }) });
    const openId = crypto.randomUUID(); driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", trusted: true, newSession: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === openId)).toBe(true));
    const operationId = crypto.randomUUID(); driver.dispatch({ type: "prompt", requestId: operationId, workspacePath: "/project", sessionId: snapshot.sessionId, text: "request", delivery: "prompt", attachments: [] });
    await vi.waitFor(() => expect(events.some((event) => event.type === "artifact-requested")).toBe(true));
    const request = events.find((event): event is Extract<DesktopEvent, { type: "artifact-requested" }> => event.type === "artifact-requested")!;
    expect(events.some((event) => event.type === "artifact-updated")).toBe(true);
    driver.dispatch({ type: "respond-artifact", requestId: operationId, workspacePath: "/project", sessionId: snapshot.sessionId, artifactRequestId: request.artifactRequestId, value: { answer: "yes" }, cancelled: false });
    await vi.waitFor(() => expect(response).toEqual({ answer: "yes" }));
    driver.dispatch({ type: "respond-artifact", requestId: operationId, workspacePath: "/project", sessionId: snapshot.sessionId, artifactRequestId: request.artifactRequestId, value: { answer: "late" }, cancelled: false });
    expect(response).toEqual({ answer: "yes" });
    driver[Symbol.dispose]();
  });
});
