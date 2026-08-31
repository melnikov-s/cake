import { describe, expect, it, vi } from "vitest";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
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
