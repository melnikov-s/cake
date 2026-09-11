import type { PiSessionAcquireOptions } from "../../../src/services/pi/PiSessions";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
export const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
};

export const options = (overrides: Partial<PiSessionAcquireOptions["runtime"]> = {}) =>
  ({
    profile: { _tag: "ProjectSession" },
    runtime: {
      cwd: "/project",
      trusted: true,
      agentDir: "/agent",
      sessionDir: "/sessions",
      sessionId: "session-1",
      requestUi: async () => undefined,
      ...overrides,
    },
  }) satisfies PiSessionAcquireOptions;

export function fakeRuntime(
  runtimeOptions: CakeRuntimeOptions,
  onDispose: () => void | Promise<void>,
): CakeRuntime {
  return {
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    streaming: false,
    snapshot: async () => {
      runtimeOptions.onEvent({
        type: "streaming",
        sessionId: snapshot.sessionId,
        streaming: true,
      });
      return snapshot;
    },
    listQueuedMessages: async () => ({ steering: [], followUp: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    cancelSteering: async () => ({ steering: [], followUp: [] }),
    removeQueuedMessage: async () => ({ steering: [], followUp: [] }),
    steerQueuedMessage: async () => ({ steering: [], followUp: [] }),
    prompt: async () => undefined,
    setUserMessageMarkdown: async () => undefined,
    compact: async () => undefined,
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: async () => undefined,
    applyConfiguration: async () => undefined,
    setPiSetting: async () => undefined,
    recordReviewRun: () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    rename: async () => undefined,
    fork: async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" }),
    toolCompact: async () => ({
      sessionId: "toolCompact",
      sessionFile: "/sessions/toolCompact.jsonl",
    }),
    navigate: async () => undefined,
    dispose: onDispose,
  };
}
