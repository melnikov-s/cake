import { describe, expect, it, vi } from "vitest";
import type { CakeRuntime, CakeRuntimeOptions } from "../../../src/agent/pi-runtime";
import type { DesktopEvent } from "../../../src/ipc/desktop-ipc";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { GlobalChatDriver } from "../../../src/main/global-chat-driver";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "global-1",
  sessionFile: "/data/global-chat/global-1.jsonl",
  parts: [{ id: "prior", kind: "text", role: "assistant", text: "Found task-7", status: "complete" }],
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

function runtime(): CakeRuntime {
  return {
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    snapshot: vi.fn(async () => snapshot),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    setPiSetting: vi.fn(async () => undefined),
    recordReviewRun: vi.fn(),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl" })),
    navigate: vi.fn(async () => undefined),
    dispose: vi.fn()
  };
}

describe("GlobalChatDriver", () => {
  it("reopens one persistent Pi transcript and routes control tools to the renderer", async () => {
    const events: DesktopEvent[] = [];
    const cakeRuntime = runtime();
    let runtimeOptions: CakeRuntimeOptions | undefined;
    const createRuntime = vi.fn(async (options: CakeRuntimeOptions) => { runtimeOptions = options; return cakeRuntime; });
    const driver = new GlobalChatDriver({ agentDir: "/cake/pi", sessionDir: "/cake/pi/global-chat/sessions", emit: (event) => events.push(event), createRuntime });
    const openId = crypto.randomUUID();

    driver.open(openId, [{ name: "open_session", description: "Open a session" }]);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "global-chat-snapshot", requestId: openId, snapshot: expect.objectContaining({ sessionId: "global-1" }) })));
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ newSession: false, agentDir: "/cake/pi", sessionDir: "/cake/pi/global-chat/sessions" }));

    const control = runtimeOptions!.globalControl!.invoke({ name: "open_session", arguments: { workspacePath: "/cake", sessionId: "task-7" } }, new AbortController().signal);
    await vi.waitFor(() => expect(events.some((event) => event.type === "global-chat-control-request")).toBe(true));
    const request = events.find((event): event is Extract<DesktopEvent, { type: "global-chat-control-request" }> => event.type === "global-chat-control-request")!;
    driver.respond(request.controlRequestId, { ok: true });
    await expect(control).resolves.toEqual({ ok: true });
    driver[Symbol.dispose]();
  });

  it("applies model and reasoning selections to the persistent runtime", async () => {
    const events: DesktopEvent[] = [];
    const cakeRuntime = runtime();
    const driver = new GlobalChatDriver({ agentDir: "/cake/pi", sessionDir: "/cake/pi/global-chat/sessions", emit: (event) => events.push(event), createRuntime: vi.fn(async () => cakeRuntime) });
    const modelId = crypto.randomUUID();
    const thinkingId = crypto.randomUUID();

    driver.setModel(modelId, "openai", "gpt-5");
    await vi.waitFor(() => expect(cakeRuntime.setModel).toHaveBeenCalledWith("openai", "gpt-5"));
    driver.setThinkingLevel(thinkingId, "high");
    await vi.waitFor(() => expect(cakeRuntime.setThinkingLevel).toHaveBeenCalledWith("high"));
    expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId: modelId });
    expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId: thinkingId });
    driver[Symbol.dispose]();
  });

  it("creates a new persistent Pi session when cleared", async () => {
    const events: DesktopEvent[] = [];
    const createRuntime = vi.fn(async () => runtime());
    const driver = new GlobalChatDriver({ agentDir: "/cake/pi", sessionDir: "/cake/pi/global-chat/sessions", emit: (event) => events.push(event), createRuntime });
    const clearId = crypto.randomUUID();

    driver.clear(clearId, [{ name: "get_app_state", description: "Read state" }]);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId: clearId }));
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ newSession: true }));
    driver[Symbol.dispose]();
  });

  it("shares runtime startup across windows", async () => {
    const events: DesktopEvent[] = [];
    let release!: (value: CakeRuntime) => void;
    const createRuntime = vi.fn(() => new Promise<CakeRuntime>((resolve) => { release = resolve; }));
    const driver = new GlobalChatDriver({ agentDir: "/cake/pi", sessionDir: "/cake/pi/global-chat/sessions", emit: (event) => events.push(event), createRuntime });

    driver.open(crypto.randomUUID(), [{ name: "get_app_state", description: "Read state" }]);
    driver.open(crypto.randomUUID(), [{ name: "get_app_state", description: "Read state" }]);
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());
    release(runtime());
    await vi.waitFor(() => expect(events.filter((event) => event.type === "global-chat-snapshot")).toHaveLength(2));
    driver[Symbol.dispose]();
  });
});
