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
  it("reads persisted checkpoints without capturing workspace state during inspection", async () => {
    const events: DesktopEvent[] = [];
    const captureLatestGitCheckpoint = vi.fn(async () => ({ tree: "c".repeat(40), ref: "refs/cake/checkpoints/c", capturedAt: new Date(0).toISOString() }));
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot), prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn(),
      ensureInitialGitCheckpoint: vi.fn(async () => ({ tree: "a".repeat(40), ref: "refs/cake/checkpoints/a", capturedAt: new Date(0).toISOString() })),
      captureLatestGitCheckpoint,
      waitForGitCheckpoints: vi.fn(async () => undefined),
      gitCheckpoints: vi.fn(() => [
        { tree: "a".repeat(40), ref: "refs/cake/checkpoints/a", capturedAt: new Date(0).toISOString() },
        { tree: "b".repeat(40), ref: "refs/cake/checkpoints/b", capturedAt: new Date(0).toISOString() }
      ])
    };
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime: vi.fn(async () => runtime) });
    const openId = crypto.randomUUID();
    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", newSession: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));
    const inspectId = crypto.randomUUID();
    driver.dispatch({ type: "inspect-changes", requestId: inspectId, workspacePath: "/project", sessionId: snapshot.sessionId });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "fatal", requestId: inspectId })));

    expect(captureLatestGitCheckpoint).not.toHaveBeenCalled();
    expect(runtime.waitForGitCheckpoints).toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("routes auxiliary review replies without appending a primary session snapshot", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile,
      getReviewParentContext: vi.fn(() => ({ sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile, leafId: "parent-leaf", systemPrompt: "Parent prompt", activeTools: ["read"], model: { provider: "openai-codex", id: "gpt-5.6-sol" } })),
      snapshot: vi.fn(async () => snapshot), prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
    };
    const now = new Date(0).toISOString();
    const thread = { id: "review-1", workspacePath: "/project", sessionId: snapshot.sessionId, status: "open" as const, createdAt: now, updatedAt: now, anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" }, pendingComments: [{ id: "message-1", body: "Rename this", createdAt: now }] };
    const projected = { ...thread, agentSessionId: "review-session", messages: [{ id: "message-1", role: "user" as const, body: "Rename this", createdAt: now, delivered: true, status: "complete" as const }, { id: "message-2", role: "assistant" as const, body: "Renamed.", createdAt: now, delivered: true, status: "complete" as const }] };
    const reviewRepository = {
      recoverRunning: vi.fn(async () => undefined),
      claimPending: vi.fn(async (_workspacePath: string, _sessionId: string, _threadId: string, runId: string) => ({ ...thread, submission: { status: "running" as const, runId, commentIds: ["message-1"], startedAt: now } })),
      agentSessionDirectory: vi.fn(() => "/reviews/review-1"),
      completeRun: vi.fn(async () => projected),
      failRun: vi.fn(async () => projected)
    };
    const runReview = vi.fn(async () => ({ sessionId: "review-session", sessionFile: "/reviews/review-1/session.jsonl" }));
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime: vi.fn(async () => runtime), reviewRepository, runReviewTurn: runReview, isTrusted: () => true });
    const openId = crypto.randomUUID();
    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", newSession: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));
    events.splice(0);

    const requestId = crypto.randomUUID();
    driver.dispatch({ type: "submit-review-threads", requestId, workspacePath: "/project", sessionId: snapshot.sessionId, threadIds: [thread.id], commentCount: 1 });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId }));

    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ thread: expect.objectContaining({ id: thread.id, submission: expect.objectContaining({ status: "running" }) }) }));
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ sessionDir: "/reviews/review-1" }));
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ parent: expect.objectContaining({ sessionId: snapshot.sessionId, leafId: "parent-leaf", systemPrompt: "Parent prompt" }) }));
    expect(reviewRepository.completeRun).toHaveBeenCalledWith("/project", snapshot.sessionId, thread.id, expect.any(String), expect.objectContaining({ sessionId: "review-session" }));
    expect(runtime.recordReviewRun).toHaveBeenNthCalledWith(1, { operationId: requestId, threadIds: [thread.id], commentCount: 1, status: "running" });
    expect(runtime.recordReviewRun).toHaveBeenNthCalledWith(2, { operationId: requestId, threadIds: [thread.id], commentCount: 1, status: "complete" });
    expect(events).toContainEqual(expect.objectContaining({ type: "review-thread-updated", thread: expect.objectContaining({ id: thread.id }) }));
    expect(events.some((event) => event.type === "session-snapshot")).toBe(false);
    expect(runtime.prompt).not.toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("cancels an active review turn when the workspace driver is disposed", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile, snapshot: vi.fn(async () => snapshot), prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
    };
    const now = new Date(0).toISOString();
    const thread = { id: "review-1", workspacePath: "/project", sessionId: snapshot.sessionId, status: "open" as const, createdAt: now, updatedAt: now, anchor: { path: "src/app.ts", start: { diffLine: 1 }, end: { diffLine: 1 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" }, pendingComments: [{ id: "comment-1", body: "Explain", createdAt: now }] };
    const failRun = vi.fn(async () => undefined);
    const reviewRepository = {
      recoverRunning: vi.fn(async () => undefined),
      claimPending: vi.fn(async (_workspacePath: string, _sessionId: string, _threadId: string, runId: string) => ({ ...thread, submission: { status: "running" as const, runId, commentIds: ["comment-1"], startedAt: now } })),
      agentSessionDirectory: vi.fn(() => "/reviews/review-1"),
      completeRun: vi.fn(async () => undefined),
      failRun
    };
    let reviewSignal: AbortSignal | undefined;
    const runReview = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      reviewSignal = signal;
      return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime: vi.fn(async () => runtime), reviewRepository, runReviewTurn: runReview as never, isTrusted: () => true });
    const openId = crypto.randomUUID();
    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", newSession: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));
    driver.dispatch({ type: "submit-review-threads", requestId: crypto.randomUUID(), workspacePath: "/project", sessionId: snapshot.sessionId, threadIds: [thread.id], commentCount: 1 });
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledOnce());

    driver[Symbol.dispose]();

    expect(reviewSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(failRun).toHaveBeenCalledWith("/project", snapshot.sessionId, thread.id, expect.any(String), "cancelled"));
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
      setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(),
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

  it("opens a fork whose Pi session history carries its Git checkpoints", async () => {
    const events: DesktopEvent[] = [];
    const runtime = (sessionId: string): CakeRuntime => ({
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      snapshot: vi.fn(async () => ({ ...snapshot, sessionId, sessionFile: `/sessions/${sessionId}.jsonl` })),
      prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
    });
    const parent = runtime("session-1");
    const child = runtime("fork");
    const driver = new PiWorkspaceDriver({
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async ({ sessionId }) => sessionId === "fork" ? child : parent)
    });
    const openId = crypto.randomUUID();
    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", newSession: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));

    const forkId = crypto.randomUUID();
    driver.dispatch({ type: "fork-session", requestId: forkId, workspacePath: "/project", sessionId: "session-1", entryId: "entry" });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: forkId }));

    expect(parent.fork).toHaveBeenCalledWith("entry");
    expect(child.snapshot).toHaveBeenCalled();
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
      setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(),
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
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime, openExternal, isTrusted: () => true });
    const openId = crypto.randomUUID();

    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", newSession: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === openId)).toBe(true));
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ trusted: true }));
    await options?.openExternal?.("https://auth.example.test/");
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/");
    expect(events).toContainEqual({ type: "session-snapshot", requestId: openId, snapshot });

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
      abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), setPiSetting: vi.fn(async () => undefined), recordReviewRun: vi.fn(), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
    };
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", artifactRepository: repository, emit: (event) => events.push(event), createRuntime: vi.fn(async (next) => { options = next; return runtime; }), isTrusted: () => true });
    const openId = crypto.randomUUID(); driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", newSession: true });
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
