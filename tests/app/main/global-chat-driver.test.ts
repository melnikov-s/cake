import { describe, expect, it, vi } from "vitest";
import type { CakeRuntime, CakeRuntimeOptions } from "../../../src/agent/cake-runtime";
import type { DesktopEvent } from "../../../src/ipc/desktop-ipc";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { GlobalChatDriver } from "../../../src/main/global-chat-driver";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "global-1",
  sessionFile: "/data/global-chat/global-1.jsonl",
  parts: [
    { id: "prior", kind: "text", role: "assistant", text: "Found task-7", status: "complete" },
  ],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: [],
};

function runtime(nextSnapshot = snapshot): CakeRuntime {
  return {
    sessionId: nextSnapshot.sessionId,
    sessionFile: nextSnapshot.sessionFile,
    snapshot: vi.fn(async () => nextSnapshot),
    prompt: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    applyConfiguration: vi.fn(async () => undefined),
    setPiSetting: vi.fn(async () => undefined),
    recordReviewRun: vi.fn(),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl" })),
    handoff: vi.fn(async () => ({ sessionId: "handoff", sessionFile: "/handoff.jsonl" })),
    navigate: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("GlobalChatDriver", () => {
  it("renames a Cake Chat through its existing runtime", async () => {
    const events: DesktopEvent[] = [];
    const cakeRuntime = runtime();
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async () => cakeRuntime),
    });
    const requestId = crypto.randomUUID();

    driver.rename(requestId, "global-1", "Renamed chat");

    await vi.waitFor(() => expect(cakeRuntime.rename).toHaveBeenCalledWith("Renamed chat"));
    expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId });
  });

  it("creates a clean Cake Chat handoff and starts its optional instruction", async () => {
    const events: DesktopEvent[] = [];
    const source = runtime({
      ...snapshot,
      model: { provider: "openai", id: "gpt-test", name: "Test" },
      thinkingLevel: "high",
      fastMode: true,
    });
    const target = runtime({
      ...snapshot,
      sessionId: "handoff",
      sessionFile: "/data/global-chat/handoff.jsonl",
    });
    const createRuntime = vi.fn(async (options: CakeRuntimeOptions) =>
      options.sessionId === "handoff" ? target : source,
    );
    const setSessionResolved = vi.fn(async () => undefined);
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
      setSessionResolved,
    });
    const requestId = crypto.randomUUID();

    driver.handoff(requestId, "global-1", "assistant-entry", "Implement it", true);

    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId }),
    );
    expect(source.handoff).toHaveBeenCalledWith("assistant-entry");
    expect(target.applyConfiguration).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-test",
      thinkingLevel: "high",
      fastMode: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "global-chat-snapshot",
        requestId,
        snapshot: expect.objectContaining({ sessionId: "handoff" }),
      }),
    );
    expect(setSessionResolved).toHaveBeenCalledWith("global-1", true);
    expect(target.prompt).toHaveBeenCalledWith("Implement it", "prompt", []);
  });

  it("reopens one persistent Pi transcript and routes control tools to the renderer", async () => {
    const events: DesktopEvent[] = [];
    const cakeRuntime = runtime();
    let runtimeOptions: CakeRuntimeOptions | undefined;
    const createRuntime = vi.fn(async (options: CakeRuntimeOptions) => {
      runtimeOptions = options;
      return cakeRuntime;
    });
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const openId = crypto.randomUUID();

    driver.open(openId, [
      {
        command: "sessions.open",
        topic: "sessions",
        summary: "Open a session",
        parameters: { type: "object", properties: {} },
      },
    ]);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "global-chat-snapshot",
          requestId: openId,
          snapshot: expect.objectContaining({ sessionId: "global-1" }),
        }),
      ),
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        newSession: false,
        agentDir: "/cake/pi",
        sessionDir: "/cake/pi/global-chat/sessions",
      }),
    );

    const control = runtimeOptions!.globalControl!.invoke(
      { name: "open_session", arguments: { workspacePath: "/cake", sessionId: "task-7" } },
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "global-chat-control-request")).toBe(true),
    );
    const request = events.find(
      (event): event is Extract<DesktopEvent, { type: "global-chat-control-request" }> =>
        event.type === "global-chat-control-request",
    )!;
    driver.respond(request.controlRequestId, { ok: true });
    await expect(control).resolves.toEqual({ ok: true });
    driver[Symbol.dispose]();
  });

  it("releases a settled runtime for archival but rejects a streaming session", async () => {
    const settled = runtime();
    const createRuntime = vi.fn(async () => settled);
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: () => undefined,
      createRuntime,
    });
    driver.open(crypto.randomUUID(), [], { sessionId: "global-1" });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());

    await driver.releaseSessionForArchive("global-1");
    expect(settled.dispose).toHaveBeenCalledOnce();

    const streaming = runtime({ ...snapshot, sessionId: "global-2", streaming: true });
    createRuntime.mockResolvedValueOnce(streaming);
    driver.open(crypto.randomUUID(), [], { sessionId: "global-2" });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2));
    await expect(driver.releaseSessionForArchive("global-2")).rejects.toThrow(
      "while it is running",
    );
    expect(streaming.dispose).not.toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("applies model and reasoning selections to the persistent runtime", async () => {
    const events: DesktopEvent[] = [];
    const cakeRuntime = runtime();
    const createRuntime = vi.fn(async () => cakeRuntime);
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const modelId = crypto.randomUUID();
    const thinkingId = crypto.randomUUID();

    driver.open(
      crypto.randomUUID(),
      [
        {
          command: "app.state",
          topic: "app",
          summary: "Read state",
          parameters: { type: "object", properties: {} },
        },
      ],
      { sessionId: "global-1" },
    );
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());
    driver.setModel(modelId, "global-1", "openai", "gpt-5");
    await vi.waitFor(() => expect(cakeRuntime.setModel).toHaveBeenCalledWith("openai", "gpt-5"));
    driver.setThinkingLevel(thinkingId, "global-1", "high");
    await vi.waitFor(() => expect(cakeRuntime.setThinkingLevel).toHaveBeenCalledWith("high"));
    expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId: modelId });
    expect(events).toContainEqual({
      type: "global-chat-operation-completed",
      requestId: thinkingId,
    });
    driver[Symbol.dispose]();
  });

  it("forwards image attachments to the persistent runtime", async () => {
    const events: DesktopEvent[] = [];
    const cakeRuntime = runtime();
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async () => cakeRuntime),
    });
    const requestId = crypto.randomUUID();
    const attachments = [
      { kind: "image" as const, name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" },
    ];

    driver.open(
      crypto.randomUUID(),
      [
        {
          command: "app.state",
          topic: "app",
          summary: "Read state",
          parameters: { type: "object", properties: {} },
        },
      ],
      { sessionId: "global-1" },
    );
    await vi.waitFor(() => expect(cakeRuntime.snapshot).toHaveBeenCalled());
    driver.prompt(requestId, "global-1", "", attachments);

    await vi.waitFor(() =>
      expect(cakeRuntime.prompt).toHaveBeenCalledWith("", "prompt", attachments),
    );
    expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId });
    driver[Symbol.dispose]();
  });

  it("creates a new persistent Cake Chat session on request", async () => {
    const events: DesktopEvent[] = [];
    const createRuntime = vi.fn(async () => runtime());
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const openId = crypto.randomUUID();

    driver.open(
      openId,
      [
        {
          command: "app.state",
          topic: "app",
          summary: "Read state",
          parameters: { type: "object", properties: {} },
        },
      ],
      { newSession: true },
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId: openId }),
    );
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ newSession: true }));
    driver[Symbol.dispose]();
  });

  it("opens a selected Cake Chat session", async () => {
    const events: DesktopEvent[] = [];
    const createRuntime = vi.fn(async () => runtime());
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const openId = crypto.randomUUID();

    driver.open(
      openId,
      [
        {
          command: "app.state",
          topic: "app",
          summary: "Read state",
          parameters: { type: "object", properties: {} },
        },
      ],
      { sessionId: "global-1" },
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "global-chat-operation-completed", requestId: openId }),
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ newSession: false, sessionId: "global-1" }),
    );
    driver[Symbol.dispose]();
  });

  it("keeps multiple Cake Chat runtimes alive and routes turns by session", async () => {
    const events: DesktopEvent[] = [];
    const first = runtime(snapshot);
    const secondSnapshot = {
      ...snapshot,
      sessionId: "global-2",
      sessionFile: "/data/global-chat/global-2.jsonl",
      parts: [],
    };
    const second = runtime(secondSnapshot);
    const createRuntime = vi.fn(async (options: CakeRuntimeOptions) =>
      options.sessionId === "global-1" ? first : second,
    );
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
    });

    driver.open(
      crypto.randomUUID(),
      [
        {
          command: "app.state",
          topic: "app",
          summary: "Read state",
          parameters: { type: "object", properties: {} },
        },
      ],
      { sessionId: "global-1" },
    );
    driver.open(
      crypto.randomUUID(),
      [
        {
          command: "app.state",
          topic: "app",
          summary: "Read state",
          parameters: { type: "object", properties: {} },
        },
      ],
      { sessionId: "global-2" },
    );
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2));
    driver.prompt(crypto.randomUUID(), "global-1", "first turn", []);
    driver.prompt(crypto.randomUUID(), "global-2", "second turn", []);
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledWith("first turn", "prompt", []));
    await vi.waitFor(() => expect(second.prompt).toHaveBeenCalledWith("second turn", "prompt", []));
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("shares runtime startup across windows", async () => {
    const events: DesktopEvent[] = [];
    let release!: (value: CakeRuntime) => void;
    const createRuntime = vi.fn(
      () =>
        new Promise<CakeRuntime>((resolve) => {
          release = resolve;
        }),
    );
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: (event) => events.push(event),
      createRuntime,
    });

    driver.open(crypto.randomUUID(), [
      {
        command: "app.state",
        topic: "app",
        summary: "Read state",
        parameters: { type: "object", properties: {} },
      },
    ]);
    driver.open(crypto.randomUUID(), [
      {
        command: "app.state",
        topic: "app",
        summary: "Read state",
        parameters: { type: "object", properties: {} },
      },
    ]);
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());
    release(runtime());
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "global-chat-snapshot")).toHaveLength(2),
    );
    driver[Symbol.dispose]();
  });

  it("waits for an active global-chat turn before refreshing recovery context", async () => {
    const cakeRuntime = runtime();
    let options!: CakeRuntimeOptions;
    const driver = new GlobalChatDriver({
      agentDir: "/cake/pi",
      sessionDir: "/cake/pi/global-chat/sessions",
      emit: () => undefined,
      recoveryContext: () => "failed revision",
      createRuntime: vi.fn(async (input) => {
        options = input;
        return cakeRuntime;
      }),
    });
    driver.open(crypto.randomUUID(), [
      {
        command: "customizations.state",
        topic: "customizations",
        summary: "Read customization",
        parameters: { type: "object", properties: {} },
      },
    ]);
    await vi.waitFor(() => expect(options).toBeDefined());
    options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: true });
    driver.refreshRecoveryContext();
    expect(cakeRuntime.dispose).not.toHaveBeenCalled();
    options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: false });
    expect(cakeRuntime.dispose).toHaveBeenCalledOnce();
    driver[Symbol.dispose]();
  });
});
