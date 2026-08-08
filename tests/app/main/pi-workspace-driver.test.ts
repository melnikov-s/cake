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
  sessions: [],
  tree: []
};

describe("PiWorkspaceDriver", () => {
  it("owns Pi directly and correlates extension UI without an internal transport", async () => {
    const events: DesktopEvent[] = [];
    let options: CakeRuntimeOptions | undefined;
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => {
        await options?.requestUi({ kind: "confirm", title: "Continue?", message: "Confirm" });
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
    const request = events.find((event): event is Extract<DesktopEvent, { type: "ui-request" }> => event.type === "ui-request" && event.requestId === promptId)!;
    driver.dispatch({ type: "respond-ui", requestId: promptId, workspacePath: "/project", sessionId: snapshot.sessionId, uiRequestId: request.uiRequestId, value: "true", cancelled: false });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete" && event.requestId === promptId)).toBe(true));

    driver[Symbol.dispose]();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
