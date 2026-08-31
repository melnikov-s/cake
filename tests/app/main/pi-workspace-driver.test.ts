import { describe, expect, it, vi } from "vitest";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
import type { ReviewTurnOptions } from "../../../src/services/pi/runtime/sidecar-runtime";
import type { DesktopEvent } from "../../../src/ipc/desktop-ipc";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { PiWorkspaceDriver } from "../../../src/main/pi-workspace-driver";

const piPaths = { agentDir: "/cake/pi", sessionDir: "/cake/pi/sessions" };

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
  extensionUi: { statuses: [] },
  sessions: [],
  tree: [],
};

describe("PiWorkspaceDriver", () => {
  it("coordinates concurrent attaches through one writable runtime", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createRuntime = vi.fn(async () => {
      await gate;
      return runtime;
    });
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: vi.fn(),
      createRuntime,
    });
    const first = driver.openAgent({ target: { kind: "attach", sessionId: snapshot.sessionId } });
    const second = driver.openAgent({ target: { kind: "attach", sessionId: snapshot.sessionId } });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(createRuntime).toHaveBeenCalledOnce();
    driver[Symbol.dispose]();
  });

  it("releases a private agent runtime after its final owning handle closes", async () => {
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createRuntime = vi.fn(async () => runtime);
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: vi.fn(),
      createRuntime,
    });

    await driver.openAgent({ target: { kind: "new", visibility: "private" } });
    await driver.openAgent({ target: { kind: "attach", sessionId: snapshot.sessionId } });
    driver.releaseAgent(snapshot.sessionId);
    expect(runtime.dispose).not.toHaveBeenCalled();
    driver.releaseAgent(snapshot.sessionId);

    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
    driver[Symbol.dispose]();
  });

  it("spawns a hidden parent-owned subagent and starts its task without exposing a session", async () => {
    let finishTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const createdWith: CakeRuntimeOptions[] = [];
    const runtime = (
      sessionId: string,
      prompt: CakeRuntime["prompt"],
      includeModel = true,
    ): CakeRuntime => ({
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        model: includeModel ? { provider: "test", id: "model", name: "Model" } : undefined,
      })),
      prompt,
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const parent = runtime(
      "parent",
      vi.fn(async () => undefined),
    );
    const notifySubagentCompletion = vi.fn(async () => undefined);
    parent.notifySubagentCompletion = notifySubagentCompletion;
    const childPrompt = vi.fn(async () => taskGate);
    const child = runtime("child", childPrompt, false);
    const resolveAgentModel = vi.fn(() => ({
      requested: "current" as const,
      source: "current" as const,
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "max" as const,
      fallbacks: [],
    }));
    const emit = vi.fn();
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit,
      resolveAgentModel,
      createRuntime: vi.fn(async (options) => {
        createdWith.push(options);
        return options.sessionDir.endsWith("plugin-agent-sessions") ? child : parent;
      }),
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    const control = createdWith[0]?.agentControl;
    if (!control) throw new Error("Expected subagent control");

    const spawned = await control.start(
      { task: "Audit the IPC boundary", model: { prefer: "current" }, fastMode: true },
      parent.sessionId,
      new AbortController().signal,
    );

    expect(spawned).toMatchObject({
      handleId: expect.any(String),
      task: "Audit the IPC boundary",
      profile: "worker",
      status: "running",
      retained: false,
      fastMode: true,
      maxDepth: 0,
      resolvedModel: {
        requested: "current",
        source: "current",
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        thinkingLevel: "max",
      },
    });
    expect(JSON.stringify(spawned)).not.toContain('"sessionId"');
    expect(emit).toHaveBeenCalledWith({
      type: "subagent-activity",
      activity: expect.objectContaining({
        parentSessionId: parent.sessionId,
        handleId: expect.any(String),
        task: "Audit the IPC boundary",
        status: "running",
        parts: [],
      }),
    });
    expect(emit).toHaveBeenCalledWith({
      type: "session-background-work",
      sessionId: parent.sessionId,
      active: true,
    });
    expect(resolveAgentModel).toHaveBeenCalledWith(
      { prefer: "current" },
      expect.objectContaining({ sessionId: parent.sessionId }),
    );
    expect(createdWith[1]).toMatchObject({
      newSession: true,
      sessionDir: "/cake/pi/plugin-agent-sessions",
      auxiliary: true,
      agentControl: undefined,
    });
    expect(createdWith[1]?.fastMode?.get()).toBe(true);
    await vi.waitFor(() =>
      expect(childPrompt).toHaveBeenCalledWith("Audit the IPC boundary", "prompt", []),
    );

    if (typeof spawned !== "object" || spawned === null || Array.isArray(spawned))
      throw new Error("Expected subagent spawn result");
    const handleId = String(spawned.handleId);
    const update = vi.fn();
    const snapshotCalls = vi.mocked(child.snapshot).mock.calls.length;
    const waiting = control.wait(handleId, parent.sessionId, new AbortController().signal, update);
    createdWith[1]!.onEvent({
      type: "part-updated",
      sessionId: child.sessionId,
      part: {
        id: "child-answer",
        kind: "text",
        role: "assistant",
        entryId: undefined,
        text: "Inspecting the boundary",
        status: "streaming",
      },
    });
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ parts: [expect.objectContaining({ id: "child-answer" })] }),
      ),
    );
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({
        type: "subagent-activity",
        activity: expect.objectContaining({
          handleId,
          parts: [expect.objectContaining({ id: "child-answer" })],
        }),
      }),
    );
    expect(child.snapshot).toHaveBeenCalledTimes(snapshotCalls);

    driver.steerSubagent(handleId, parent.sessionId, "Also inspect cancellation");
    await vi.waitFor(() =>
      expect(childPrompt).toHaveBeenCalledWith("Also inspect cancellation", "steer", []),
    );

    finishTask();
    await expect(waiting).resolves.toMatchObject({
      resolvedModel: {
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        thinkingLevel: "max",
      },
      fastMode: true,
    });
    await expect(waiting).resolves.not.toHaveProperty("sessionId");
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith({
        type: "subagent-activity-removed",
        parentSessionId: parent.sessionId,
        handleId,
      }),
    );
    expect(emit).toHaveBeenCalledWith({
      type: "session-background-work",
      sessionId: parent.sessionId,
      active: false,
    });
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(notifySubagentCompletion).not.toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("automatically wakes the parent when a background subagent completes without a waiter", async () => {
    let finishTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const createdWith: CakeRuntimeOptions[] = [];
    const runtime = (sessionId: string, prompt: CakeRuntime["prompt"]): CakeRuntime => ({
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        model: { provider: "test", id: "model", name: "Model" },
      })),
      prompt,
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const parent = runtime(
      "parent",
      vi.fn(async () => undefined),
    );
    const notifySubagentCompletion = vi.fn(async () => undefined);
    parent.notifySubagentCompletion = notifySubagentCompletion;
    const child = runtime(
      "child",
      vi.fn(async () => taskGate),
    );
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: vi.fn(),
      resolveAgentModel: () => ({
        requested: "current",
        source: "current",
        provider: "test",
        modelId: "model",
        thinkingLevel: "off",
        fallbacks: [],
      }),
      createRuntime: vi.fn(async (options) => {
        createdWith.push(options);
        return options.auxiliary ? child : parent;
      }),
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    const control = createdWith[0]?.agentControl;
    if (!control) throw new Error("Expected subagent control");

    const started = await control.start(
      { task: "Background audit" },
      parent.sessionId,
      new AbortController().signal,
    );
    expect(started).toMatchObject({ status: "running", handleId: expect.any(String) });
    finishTask();

    await vi.waitFor(() => expect(notifySubagentCompletion).toHaveBeenCalledOnce());
    expect(notifySubagentCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        handleId: expect.any(String),
        task: "Background audit",
        status: "complete",
      }),
    );
    driver[Symbol.dispose]();
  });

  it("keeps foreground delegation pending until its result is ready", async () => {
    let finishTask!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const createdWith: CakeRuntimeOptions[] = [];
    const base = (sessionId: string, prompt: CakeRuntime["prompt"]): CakeRuntime => ({
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        model: { provider: "test", id: "model", name: "Model" },
      })),
      prompt,
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const parent = base(
      "parent",
      vi.fn(async () => undefined),
    );
    const child = base(
      "child",
      vi.fn(async () => gate),
    );
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: vi.fn(),
      resolveAgentModel: () => ({
        requested: "current",
        source: "current",
        provider: "test",
        modelId: "model",
        thinkingLevel: "off",
        fallbacks: [],
      }),
      createRuntime: vi.fn(async (options) => {
        createdWith.push(options);
        return options.auxiliary ? child : parent;
      }),
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    const control = createdWith[0]?.agentControl;
    if (!control) throw new Error("Expected subagent control");

    let settled = false;
    const running = control
      .run({ task: "Foreground audit" }, parent.sessionId, new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(child.prompt).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishTask();
    await expect(running).resolves.toMatchObject({ task: "Foreground audit", status: "complete" });
    driver[Symbol.dispose]();
  });

  it("preflights every parallel model before constructing a subagent runtime", async () => {
    const createdWith: CakeRuntimeOptions[] = [];
    const parent: CakeRuntime = {
      sessionId: "parent",
      sessionFile: "/sessions/parent.jsonl",
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId: "parent",
        sessionFile: "/sessions/parent.jsonl",
        model: { provider: "test", id: "model", name: "Model" },
      })),
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const resolveAgentModel = vi.fn((preference) => {
      if (preference.prefer === "exact")
        throw new Error(`Requested model ${preference.provider}/${preference.modelId} is unknown`);
      return {
        requested: "current" as const,
        source: "current" as const,
        provider: "test",
        modelId: "model",
        thinkingLevel: "off" as const,
        fallbacks: [],
      };
    });
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: vi.fn(),
      resolveAgentModel,
      createRuntime: vi.fn(async (options) => {
        createdWith.push(options);
        return parent;
      }),
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    const control = createdWith[0]?.agentControl;
    if (!control) throw new Error("Expected subagent control");

    await expect(
      control.parallel(
        {
          tasks: [
            { task: "Valid task", model: { prefer: "current" } },
            {
              task: "Invalid task",
              model: { prefer: "exact", provider: "missing", modelId: "unknown" },
            },
          ],
        },
        parent.sessionId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Requested model missing/unknown is unknown");

    expect(resolveAgentModel).toHaveBeenCalledTimes(2);
    expect(createdWith.filter((options) => options.auxiliary)).toHaveLength(0);
    driver[Symbol.dispose]();
  });

  it("acquires the active slot before constructing parallel subagent runtimes", async () => {
    const createdWith: CakeRuntimeOptions[] = [];
    const finishers: Array<() => void> = [];
    let childCount = 0;
    const runtime = (sessionId: string, prompt: CakeRuntime["prompt"]): CakeRuntime => ({
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        model: { provider: "test", id: "model", name: "Model" },
      })),
      prompt,
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const parent = runtime(
      "parent",
      vi.fn(async () => undefined),
    );
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: vi.fn(),
      resolveAgentModel: () => ({
        requested: "current",
        source: "current",
        provider: "test",
        modelId: "model",
        thinkingLevel: "off",
        fallbacks: [],
      }),
      createRuntime: vi.fn(async (options) => {
        createdWith.push(options);
        if (!options.auxiliary) return parent;
        const gate = new Promise<void>((resolve) => finishers.push(resolve));
        return runtime(
          `child-${++childCount}`,
          vi.fn(async () => gate),
        );
      }),
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    const control = createdWith[0]?.agentControl;
    if (!control) throw new Error("Expected subagent control");

    const parallel = control.parallel(
      { tasks: Array.from({ length: 6 }, (_, index) => ({ task: `Task ${index + 1}` })) },
      parent.sessionId,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(childCount).toBe(4));
    expect(finishers).toHaveLength(4);

    finishers[0]!();
    finishers[1]!();
    await vi.waitFor(() => expect(childCount).toBe(6));
    for (const finish of finishers.slice(2)) finish();

    await expect(parallel).resolves.toMatchObject({ mode: "parallel", completed: 6, total: 6 });
    expect(createdWith.filter((options) => options.auxiliary)).toHaveLength(6);
    driver[Symbol.dispose]();
  });

  it("routes auxiliary review replies without appending a primary session snapshot", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      getReviewParentContext: vi.fn(() => ({
        sessionId: snapshot.sessionId,
        sessionFile: snapshot.sessionFile,
        leafId: "parent-leaf",
        systemPrompt: "Parent prompt",
        activeTools: ["read"],
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      })),
      snapshot: vi.fn(async () => snapshot),
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const now = new Date(0).toISOString();
    const thread = {
      id: "review-1",
      workspacePath: "/project",
      sessionId: snapshot.sessionId,
      status: "open" as const,
      createdAt: now,
      updatedAt: now,
      anchor: {
        path: "src/app.ts",
        start: { diffLine: 1, newLine: 2 },
        end: { diffLine: 1, newLine: 2 },
        selectedText: "value",
        contextBefore: "",
        contextAfter: "",
        diff: "+value",
      },
      pendingComments: [{ id: "message-1", body: "Rename this", createdAt: now }],
    };
    const projected = {
      ...thread,
      agentSessionId: "review-session",
      parts: [
        {
          id: "message-1",
          kind: "text" as const,
          role: "user" as const,
          text: "Rename this",
          status: "complete" as const,
        },
        {
          id: "message-2",
          kind: "text" as const,
          role: "assistant" as const,
          text: "Renamed.",
          status: "complete" as const,
        },
      ],
    };
    const reviewRepository = {
      recoverRunning: vi.fn(async () => undefined),
      claimPending: vi.fn(
        async (_workspacePath: string, _sessionId: string, _threadId: string, runId: string) => ({
          ...thread,
          submission: {
            status: "running" as const,
            runId,
            commentIds: ["message-1"],
            startedAt: now,
          },
        }),
      ),
      agentSessionDirectory: vi.fn(() => "/cake/pi/review-sessions/review-1"),
      completeRun: vi.fn(async () => projected),
      failRun: vi.fn(async () => projected),
    };
    const usage = {
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: 0.012,
      context: { tokens: 20, contextWindow: 1_000, percent: 2 },
    };
    const runReview = vi.fn(async (options: ReviewTurnOptions) => {
      options.onEvent?.({
        type: "part-updated",
        part: { id: "reasoning-1", kind: "reasoning", text: "Inspecting", status: "streaming" },
      });
      options.onEvent?.({ type: "usage-updated", usage });
      return {
        sessionId: "review-session",
        sessionFile: "/cake/pi/review-sessions/review-1/session.jsonl",
        usage,
      };
    });
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async () => runtime),
      reviewRepository,
      runReviewTurn: runReview,
      isTrusted: () => true,
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    events.splice(0);

    const requestId = crypto.randomUUID();
    driver.dispatch({
      type: "submit-review-thread",
      requestId,
      sessionId: snapshot.sessionId,
      threadId: thread.id,
      thinkingLevel: "high",
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId }));

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({
          id: thread.id,
          submission: expect.objectContaining({ status: "running" }),
        }),
      }),
    );
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDir: "/cake/pi/review-sessions/review-1" }),
    );
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: piPaths.agentDir,
        parentSessionRoot: piPaths.sessionDir,
      }),
    );
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel: "high" }));
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({
          sessionId: snapshot.sessionId,
          leafId: "parent-leaf",
          systemPrompt: "Parent prompt",
        }),
      }),
    );
    expect(reviewRepository.completeRun).toHaveBeenCalledWith(
      "/project",
      snapshot.sessionId,
      thread.id,
      expect.any(String),
      expect.objectContaining({ sessionId: "review-session" }),
    );
    expect(runtime.recordReviewRun).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "review-thread-updated",
        thread: expect.objectContaining({ id: thread.id }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "review-thread-part-updated",
        threadId: thread.id,
        part: expect.objectContaining({ kind: "reasoning" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "review-thread-usage-updated", threadId: thread.id, usage }),
    );
    expect(events.some((event) => event.type === "session-snapshot")).toBe(false);
    expect(runtime.prompt).not.toHaveBeenCalled();
    driver[Symbol.dispose]();
  });

  it("cancels an active review turn when the workspace driver is disposed", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const now = new Date(0).toISOString();
    const thread = {
      id: "review-1",
      workspacePath: "/project",
      sessionId: snapshot.sessionId,
      status: "open" as const,
      createdAt: now,
      updatedAt: now,
      anchor: {
        path: "src/app.ts",
        start: { diffLine: 1 },
        end: { diffLine: 1 },
        selectedText: "",
        contextBefore: "",
        contextAfter: "",
        diff: "",
      },
      pendingComments: [{ id: "comment-1", body: "Explain", createdAt: now }],
    };
    const failRun = vi.fn(async () => undefined);
    const reviewRepository = {
      recoverRunning: vi.fn(async () => undefined),
      claimPending: vi.fn(
        async (_workspacePath: string, _sessionId: string, _threadId: string, runId: string) => ({
          ...thread,
          submission: {
            status: "running" as const,
            runId,
            commentIds: ["comment-1"],
            startedAt: now,
          },
        }),
      ),
      agentSessionDirectory: vi.fn(() => "/cake/pi/review-sessions/review-1"),
      completeRun: vi.fn(async () => undefined),
      failRun,
    };
    let reviewSignal: AbortSignal | undefined;
    const runReview = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      reviewSignal = signal;
      return new Promise<never>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    });
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async () => runtime),
      reviewRepository,
      runReviewTurn: runReview as never,
      isTrusted: () => true,
    });
    await driver.openAgent({ target: { kind: "new", visibility: "project" } });
    driver.dispatch({
      type: "submit-review-thread",
      requestId: crypto.randomUUID(),
      sessionId: snapshot.sessionId,
      threadId: thread.id,
    });
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledOnce());

    driver[Symbol.dispose]();

    expect(reviewSignal?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(failRun).toHaveBeenCalledWith(
        "/project",
        snapshot.sessionId,
        thread.id,
        expect.any(String),
        "cancelled",
      ),
    );
  });

  it("opens a clean handoff and optionally starts its first instruction", async () => {
    const events: DesktopEvent[] = [];
    const source: CakeRuntime = {
      sessionId: "source",
      sessionFile: "/sessions/source.jsonl",
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId: "source",
        sessionFile: "/sessions/source.jsonl",
      })),
      currentConfiguration: vi.fn(() => ({
        provider: "openai",
        modelId: "gpt-test",
        thinkingLevel: "high" as const,
        fastMode: true,
      })),
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
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const target: CakeRuntime = {
      ...source,
      sessionId: "handoff",
      sessionFile: "/sessions/handoff.jsonl",
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      prompt: vi.fn(async () => undefined),
      applyConfiguration: vi.fn(async () => undefined),
    };
    const setSessionResolved = vi.fn(async () => undefined);
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async ({ sessionId }) => (sessionId === "handoff" ? target : source)),
      setSessionResolved,
    });
    await driver.openAgent({ target: { kind: "attach", sessionId: "source" } });
    vi.mocked(source.snapshot).mockImplementation(() => new Promise(() => undefined));

    const handoffId = crypto.randomUUID();
    driver.dispatch({
      type: "handoff-session",
      requestId: handoffId,
      sessionId: "source",
      entryId: "assistant-entry",
      prompt: "Implement it",
      resolveSource: true,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "complete", requestId: handoffId }),
    );

    expect(source.handoff).toHaveBeenCalledWith("assistant-entry");
    expect(source.snapshot).toHaveBeenCalledOnce();
    expect(source.currentConfiguration).toHaveBeenCalledOnce();
    expect(target.applyConfiguration).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-test",
      thinkingLevel: "high",
      fastMode: true,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session-snapshot",
        requestId: handoffId,
        snapshot: expect.objectContaining({ sessionId: "handoff" }),
      }),
    );
    expect(setSessionResolved).toHaveBeenCalledWith("source", true);
    expect(target.prompt).toHaveBeenCalledWith("Implement it", "prompt", []);
    driver[Symbol.dispose]();
  });

  it("syncs every live runtime's model catalog when models are refreshed", async () => {
    const refreshPrimary = vi.fn(async () => undefined);
    const refreshSecondary = vi.fn(async () => undefined);
    const primary: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(async () => undefined),
      applyConfiguration: vi.fn(async () => undefined),
      setPiSetting: vi.fn(async () => undefined),
      refreshModels: refreshPrimary,
      recordReviewRun: vi.fn(),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      handoff: vi.fn(async () => ({
        sessionId: "handoff",
        sessionFile: "/sessions/handoff.jsonl",
      })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const secondary: CakeRuntime = {
      ...primary,
      sessionId: "session-2",
      sessionFile: "/sessions/two.jsonl",
      refreshModels: refreshSecondary,
    };
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: () => undefined,
      createRuntime: vi.fn(async (options: CakeRuntimeOptions) =>
        options.sessionId === "session-2" ? secondary : primary,
      ),
    });
    await driver.openAgent({ target: { kind: "attach", sessionId: snapshot.sessionId } });
    await driver.openAgent({ target: { kind: "attach", sessionId: "session-2" } });
    await driver.refreshModels();
    expect(refreshPrimary).toHaveBeenCalledTimes(1);
    expect(refreshSecondary).toHaveBeenCalledTimes(1);
    driver[Symbol.dispose]();
  });
});
