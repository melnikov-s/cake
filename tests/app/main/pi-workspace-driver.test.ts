import { describe, expect, it, vi } from "vitest";
import type { CakeRuntime, CakeRuntimeOptions } from "../../../src/agent/cake-runtime";
import type { ReviewTurnOptions } from "../../../src/agent/sidecar-runtime";
import type { DesktopEvent } from "../../../src/ipc/desktop-ipc";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { NotGitRepositoryError } from "../../../src/main/git-changes";
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
  it("creates a temporary chat's Pi session only with its first prompt", async () => {
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
      setFastMode: vi.fn(async () => undefined),
      setPiSetting: vi.fn(async () => undefined),
      recordReviewRun: vi.fn(),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createRuntime = vi.fn(async () => runtime);
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const requestId = crypto.randomUUID();

    driver.dispatch({
      type: "prompt",
      requestId,
      sessionId: snapshot.sessionId,
      text: "First message",
      delivery: "prompt",
      attachments: [],
      newSession: {
        path: "/project",
        configuration: {
          provider: "openai",
          modelId: "gpt-5.6",
          thinkingLevel: "high",
          fastMode: true,
        },
      },
    });

    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId }));
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ newSession: true, sessionId: snapshot.sessionId }),
    );
    expect(runtime.applyConfiguration).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
      fastMode: true,
    });
    expect(runtime.prompt).toHaveBeenCalledWith("First message", "prompt", []);
    driver[Symbol.dispose]();
  });

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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const parent = runtime(
      "parent",
      vi.fn(async () => undefined),
    );
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

    const spawned = await control.spawn(
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
    expect(child.snapshot).toHaveBeenCalledTimes(snapshotCalls);

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
    expect(emit).toHaveBeenCalledWith({
      type: "session-background-work",
      sessionId: parent.sessionId,
      active: false,
    });
    expect(child.dispose).toHaveBeenCalledOnce();
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

  it("treats a workspace outside Git as having no session changes", async () => {
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async () => runtime),
      collectWorkingChanges: async () => {
        throw new NotGitRepositoryError("/project");
      },
    });
    const openId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));

    const inspectId = crypto.randomUUID();
    driver.dispatch({
      type: "inspect-changes",
      requestId: inspectId,
      sessionId: snapshot.sessionId,
    });

    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "changes-snapshot",
        requestId: inspectId,
        workspacePath: "/project",
        sessionId: snapshot.sessionId,
        files: [],
      }),
    );
    expect(events).toContainEqual({ type: "complete", requestId: inspectId });
    expect(events.some((event) => event.type === "fatal" && event.requestId === inspectId)).toBe(
      false,
    );
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
    const openId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));
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
    const openId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));
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

  it("opens a dormant session before renaming it", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: "session-2",
      sessionFile: "/sessions/two.jsonl",
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId: "session-2",
        sessionFile: "/sessions/two.jsonl",
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createRuntime = vi.fn(async () => runtime);
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const operationId = crypto.randomUUID();

    driver.dispatch({
      type: "rename-session",
      requestId: operationId,
      sessionId: "session-2",
      name: "Renamed",
    });

    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "complete", requestId: operationId }),
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ newSession: false, sessionId: "session-2" }),
    );
    expect(runtime.rename).toHaveBeenCalledWith("Renamed");
    driver[Symbol.dispose]();
  });

  it("opens a dormant session before sending it a prompt", async () => {
    const events: DesktopEvent[] = [];
    const runtime: CakeRuntime = {
      sessionId: "session-2",
      sessionFile: "/sessions/two.jsonl",
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId: "session-2",
        sessionFile: "/sessions/two.jsonl",
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createRuntime = vi.fn(async () => runtime);
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime,
    });
    const operationId = crypto.randomUUID();

    driver.dispatch({
      type: "prompt",
      requestId: operationId,
      sessionId: "session-2",
      text: "Commit the work",
      delivery: "prompt",
      attachments: [],
    });

    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "complete", requestId: operationId }),
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ newSession: false, sessionId: "session-2" }),
    );
    expect(runtime.prompt).toHaveBeenCalledWith("Commit the work", "prompt", []);
    driver[Symbol.dispose]();
  });

  it("opens a fork through Pi's session history", async () => {
    const events: DesktopEvent[] = [];
    const runtime = (sessionId: string): CakeRuntime => ({
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      snapshot: vi.fn(async () => ({
        ...snapshot,
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    const parent = runtime("session-1");
    const child = runtime("fork");
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async ({ sessionId }) => (sessionId === "fork" ? child : parent)),
    });
    const openId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));

    const forkId = crypto.randomUUID();
    driver.dispatch({
      type: "fork-session",
      requestId: forkId,
      sessionId: "session-1",
      entryId: "entry",
    });
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
        options?.onEvent({
          type: "part-updated",
          sessionId: snapshot.sessionId,
          part: { id: "user-1", kind: "text", role: "user", text: "hello", status: "complete" },
        });
        options?.onEvent({
          type: "extension-ui",
          sessionId: snapshot.sessionId,
          event: { kind: "status", key: "fixture", text: "running" },
        });
        await options?.requestUi({ kind: "confirm", title: "Continue?", message: "Confirm" });
        promptSettled += 1;
      }),
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createRuntime = vi.fn(async (next: CakeRuntimeOptions) => {
      options = next;
      return runtime;
    });
    const openExternal = vi.fn(async () => undefined);
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime,
      openExternal,
      isTrusted: () => true,
    });
    const openId = crypto.randomUUID();

    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "complete" && event.requestId === openId)).toBe(
        true,
      ),
    );
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        trusted: true,
        agentDir: piPaths.agentDir,
        sessionDir: piPaths.sessionDir,
      }),
    );
    await options?.openExternal?.("https://auth.example.test/");
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/");
    expect(events).toContainEqual({ type: "session-snapshot", requestId: openId, snapshot });

    const changelogId = crypto.randomUUID();
    driver.dispatch({
      type: "get-changelog",
      requestId: changelogId,
      sessionId: snapshot.sessionId,
    });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "complete" && event.requestId === changelogId),
      ).toBe(true),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "changelog-snapshot",
        requestId: changelogId,
        workspacePath: "/project",
        sessionId: snapshot.sessionId,
        markdown: expect.stringContaining("0.84.0"),
      }),
    );

    const settingId = crypto.randomUUID();
    driver.dispatch({
      type: "set-pi-setting",
      requestId: settingId,
      sessionId: snapshot.sessionId,
      update: { key: "autoCompact", value: false },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "complete", requestId: settingId }),
    );
    expect(runtime.setPiSetting).toHaveBeenCalledWith({ key: "autoCompact", value: false });

    const promptId = crypto.randomUUID();
    driver.dispatch({
      type: "prompt",
      requestId: promptId,
      sessionId: snapshot.sessionId,
      text: "hello",
      delivery: "prompt",
      attachments: [],
    });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "ui-request" && event.requestId === promptId),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "session-snapshot" && event.requestId === undefined),
      ).toBe(true),
    );
    expect(promptSettled).toBe(0);
    expect(events).toContainEqual({
      type: "extension-ui",
      sessionId: snapshot.sessionId,
      event: { kind: "status", key: "fixture", text: "running" },
    });
    const request = events.find(
      (event): event is Extract<DesktopEvent, { type: "ui-request" }> =>
        event.type === "ui-request" && event.requestId === promptId,
    )!;
    driver.dispatch({
      type: "respond-ui",
      requestId: promptId,
      sessionId: snapshot.sessionId,
      uiRequestId: request.uiRequestId,
      value: "true",
      cancelled: false,
    });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "complete" && event.requestId === promptId),
      ).toBe(true),
    );

    const pendingId = crypto.randomUUID();
    driver.dispatch({
      type: "prompt",
      requestId: pendingId,
      sessionId: snapshot.sessionId,
      text: "pending",
      delivery: "prompt",
      attachments: [],
    });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "ui-request" && event.requestId === pendingId),
      ).toBe(true),
    );
    driver[Symbol.dispose]();
    await vi.waitFor(() => expect(promptSettled).toBe(2));
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("generates widgets in a separate session and compile-repairs them before returning source", async () => {
    const events: DesktopEvent[] = [];
    let options: CakeRuntimeOptions | undefined;
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const runWidgetGeneration = vi.fn(async () => ({
      sessionId: "generation-1",
      sessionFile: "/widgets/generation-1.jsonl",
      response: "```cake-react\nexport default () => <Broken />\n```",
    }));
    const runWidgetRepair = vi.fn(async () => ({
      sessionId: "repair-1",
      sessionFile: "/widgets/repair-1.jsonl",
      response: "```cake-react\nexport default () => <strong>Fixed</strong>\n```",
    }));
    const compileWidget = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not resolve Broken"))
      .mockResolvedValue({ token: crypto.randomUUID(), document: "<!doctype html>" });
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async (next) => {
        options = next;
        return runtime;
      }),
      runWidgetGeneration,
      runWidgetRepair,
      compileWidget,
    });
    const openId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "complete", requestId: openId }));

    const result = await options!.generateInlineWidget!({
      brief: "Show a comparison",
      data: [1, 2],
      fallback: "Comparison",
    });

    expect(result).toEqual({
      language: "react",
      source: "export default () => <strong>Fixed</strong>",
      generationSessionId: "generation-1",
    });
    expect(runWidgetGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionDir: "/cake/pi/widget-sessions",
        brief: "Show a comparison",
      }),
    );
    expect(runWidgetRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostic: "Could not resolve Broken",
        source: "export default () => <Broken />",
      }),
    );
    expect(compileWidget).toHaveBeenCalledTimes(2);
    driver[Symbol.dispose]();
  });

  it("persists, emits, correlates, and terminally settles artifact requests", async () => {
    const events: DesktopEvent[] = [];
    let options: CakeRuntimeOptions | undefined;
    let response: unknown = "pending";
    const requestSpec = {
      protocol: "cake.request/v1" as const,
      id: "form-1",
      title: "Answer",
      responseSchema: { type: "object" as const },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }],
        submitLabel: "Send",
      },
      fallback: { markdown: "Answer" },
    };
    const artifact = {
      protocol: "cake.artifact/v1" as const,
      id: requestSpec.id,
      sessionId: snapshot.sessionId,
      revision: 1,
      kind: "request" as const,
      payload: { request: requestSpec },
      fallback: requestSpec.fallback,
      interaction: { mode: "request" as const, responseSchema: requestSpec.responseSchema },
    };
    const repository = {
      upsert: vi.fn(async (workspacePath: string, next: unknown) => ({
        artifact: next as typeof artifact,
        workspacePath,
        digest: "a".repeat(64),
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      })),
      get: vi.fn(async () => undefined),
      linkSession: vi.fn(async () => undefined),
      listSession: vi.fn(async () => []),
    };
    const runtime: CakeRuntime = {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => {
        const record = await options!.persistArtifact!(artifact);
        response = await options!.requestArtifact!(record, new AbortController().signal);
      }),
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
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      artifactRepository: repository,
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async (next) => {
        options = next;
        return runtime;
      }),
      isTrusted: () => true,
    });
    const openId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: openId,
      path: "/project",
      newSession: true,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "complete" && event.requestId === openId)).toBe(
        true,
      ),
    );
    const operationId = crypto.randomUUID();
    driver.dispatch({
      type: "prompt",
      requestId: operationId,
      sessionId: snapshot.sessionId,
      text: "request",
      delivery: "prompt",
      attachments: [],
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "artifact-requested")).toBe(true),
    );
    const request = events.find(
      (event): event is Extract<DesktopEvent, { type: "artifact-requested" }> =>
        event.type === "artifact-requested",
    )!;
    expect(events.some((event) => event.type === "artifact-updated")).toBe(true);
    // Reopening the session replays the still-pending request so a freshly
    // attached renderer can answer it.
    const replayOpenId = crypto.randomUUID();
    driver.dispatch({
      type: "open-workspace",
      requestId: replayOpenId,
      path: "/project",
      newSession: false,
      sessionId: snapshot.sessionId,
    });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "complete" && event.requestId === replayOpenId),
      ).toBe(true),
    );
    const replays = events.filter(
      (event): event is Extract<DesktopEvent, { type: "artifact-requested" }> =>
        event.type === "artifact-requested" &&
        event.artifactRequestId === request.artifactRequestId,
    );
    expect(replays.length).toBe(2);
    expect(replays[1]!.record.artifact.id).toBe(request.record.artifact.id);
    driver.dispatch({
      type: "respond-artifact",
      requestId: operationId,
      sessionId: snapshot.sessionId,
      artifactRequestId: request.artifactRequestId,
      value: { answer: "yes" },
      cancelled: false,
    });
    await vi.waitFor(() => expect(response).toEqual({ answer: "yes" }));
    driver.dispatch({
      type: "respond-artifact",
      requestId: operationId,
      sessionId: snapshot.sessionId,
      artifactRequestId: request.artifactRequestId,
      value: { answer: "late" },
      cancelled: false,
    });
    expect(response).toEqual({ answer: "yes" });
    driver[Symbol.dispose]();
  });

  it("dispatches refresh-models to the active runtime and emits completion", async () => {
    const events: DesktopEvent[] = [];
    const refreshModels = vi.fn(async () => undefined);
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
      refreshModels,
      recordReviewRun: vi.fn(),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" })),
      navigate: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const driver = new PiWorkspaceDriver({
      ...piPaths,
      workspacePath: "/project",
      emit: (event) => events.push(event),
      createRuntime: vi.fn(async () => runtime),
    });
    await driver.openAgent({ target: { kind: "attach", sessionId: snapshot.sessionId } });
    const operationId = crypto.randomUUID();
    driver.dispatch({
      type: "refresh-models",
      requestId: operationId,
      sessionId: snapshot.sessionId,
    });
    await vi.waitFor(() => expect(refreshModels).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "complete", requestId: operationId }),
    );
    driver[Symbol.dispose]();
  });
});
