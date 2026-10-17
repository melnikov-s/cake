import { Effect, Layer, Ref } from "effect";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import type { CakeSessionRuntimeAcquireOptions } from "../../../src/services/pi/CakeSessionRuntimes";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-session-runtime";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";

export const makeRuntimeRecoveryStorageTestLayer = (
  initialRecords: ReadonlyArray<RuntimeRecoveryRecord> = [],
) =>
  Layer.effect(
    RuntimeRecoveryStorage,
    Effect.gen(function* () {
      const records = yield* Ref.make(initialRecords);
      return RuntimeRecoveryStorage.of({
        list: Effect.fn("RuntimeRecoveryStorage.Test.list")(() => Ref.get(records)),
        get: Effect.fn("RuntimeRecoveryStorage.Test.get")((sessionId) =>
          Ref.get(records).pipe(
            Effect.map((current) => current.find((record) => record.sessionId === sessionId)),
          ),
        ),
        update: Effect.fn("RuntimeRecoveryStorage.Test.update")((record) =>
          Ref.update(records, (current) => [
            ...current.filter((item) => item.sessionId !== record.sessionId),
            record,
          ]),
        ),
        remove: Effect.fn("RuntimeRecoveryStorage.Test.remove")((sessionId) =>
          Ref.update(records, (current) => current.filter((item) => item.sessionId !== sessionId)),
        ),
      });
    }),
  );

export const snapshot: ConversationSnapshot = {
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

export const options = (overrides: Partial<CakeSessionRuntimeAcquireOptions["runtime"]> = {}) =>
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
  }) satisfies CakeSessionRuntimeAcquireOptions;

export function fakeRuntime(
  runtimeOptions: CakeSessionRuntimeOptions,
  onDispose: () => void | Promise<void>,
): CakeSessionRuntime {
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
    pendingMessages: async () => ({ items: [] }),
    reorderPendingMessage: async () => ({ items: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    cancelSteering: async () => ({ steering: [], followUp: [] }),
    removeQueuedMessage: async () => ({ steering: [], followUp: [] }),
    steerQueuedMessage: async () => ({ steering: [], followUp: [] }),
    sendQueuedMessageNow: async () => ({
      queued: { steering: [], followUp: [] },
      abortedTurnIds: [],
    }),
    prompt: async () => runtimeOptions.onInitialTranscriptPersisted?.(),
    setUserMessageMarkdown: async () => undefined,
    queueCommand: async () => {
      throw new Error("Unexpected queueCommand");
    },
    inspectSession: async () => {
      throw new Error("Unexpected inspectSession");
    },
    compact: async () => undefined,
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: async () => undefined,
    applyConfiguration: async () => undefined,
    setPiSetting: async () => undefined,
    recordReviewRun: () => undefined,
    rename: async () => undefined,
    fork: async () => ({
      sessionId: "fork",
      sessionFile: "/sessions/fork.jsonl",
      artifactPointers: [],
    }),
    toolCompact: async () => ({
      sessionId: "toolCompact",
      sessionFile: "/sessions/toolCompact.jsonl",
    }),
    navigate: async () => undefined,
    dispose: onDispose,
  };
}
