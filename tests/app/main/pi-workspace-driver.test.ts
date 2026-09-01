import { describe, expect, it, vi } from "vitest";
import type { CakeRuntime } from "../../../src/services/pi/runtime/cake-runtime";
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
});
