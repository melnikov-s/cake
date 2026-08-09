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
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [], widgets: [] },
  sessions: [],
  tree: []
};

describe("PiWorkspaceDriver", () => {
  it("owns Pi directly and correlates extension UI without an internal transport", async () => {
    const events: DesktopEvent[] = [];
    let options: CakeRuntimeOptions | undefined;
    let promptSettled = 0;
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => {
        options?.onEvent({ type: "extension-ui", sessionId: snapshot.sessionId, event: { kind: "status", key: "fixture", text: "running" } });
        await options?.requestUi({ kind: "confirm", title: "Continue?", message: "Confirm" });
        promptSettled += 1;
      }),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(async () => undefined),
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
    const driver = new PiWorkspaceDriver({ workspacePath: "/project", emit: (event) => events.push(event), createRuntime });
    const openId = crypto.randomUUID();

    driver.dispatch({ type: "open-workspace", requestId: openId, path: "/project", trusted: true, newSession: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === openId)).toBe(true));
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "session-snapshot", requestId: openId, snapshot });

    const promptId = crypto.randomUUID();
    driver.dispatch({ type: "prompt", requestId: promptId, workspacePath: "/project", sessionId: snapshot.sessionId, text: "hello", delivery: "prompt", attachments: [] });
    await vi.waitFor(() => expect(events.some((event) => event.type === "ui-request" && event.requestId === promptId)).toBe(true));
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
      abort: vi.fn(async () => undefined), setModel: vi.fn(async () => undefined), setThinkingLevel: vi.fn(async () => undefined), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })), navigate: vi.fn(async () => undefined), dispose: vi.fn()
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
