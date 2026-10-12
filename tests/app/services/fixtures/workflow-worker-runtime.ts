import { Deferred, Effect, Layer, Queue, Stream } from "effect";
import type {
  ConversationSnapshot,
  SessionUsage,
  UiPart,
} from "../../../../src/contracts/conversations/session-contract";
import { makeCakeSessionRuntimesLayer } from "../../../../src/services/pi/CakeSessionRuntimes";
import { makePiModels } from "../../../../src/services/pi/PiModels";
import { PiModels } from "../../../../src/services/pi/PiModels";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../../../../src/services/pi/runtime/cake-session-runtime";
import { WorkflowWorkersLive } from "../../../../src/services/pi/live/WorkflowWorkersLive";
import { makeSubagentEnvironmentLayer } from "../../../../src/services/subagents/SubagentEnvironment";
import type { ExplicitCakeModelSelection } from "../../../../src/contracts/model-presets/cake-model-selection";

export const model: ExplicitCakeModelSelection = {
  provider: "test",
  modelId: "worker",
  thinkingLevel: "high",
  fastMode: false,
};
const snapshotBase: ConversationSnapshot = {
  workspacePath: "/project",
  sessionId: "worker",
  sessionFile: "/private/worker.jsonl",
  parts: [],
  thinkingLevel: "high",
  availableThinkingLevels: ["high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
  models: [],
};
export const usage = (turns: number): SessionUsage => ({
  tokens: { input: turns * 10, output: turns * 2, cacheRead: 0, cacheWrite: 0, total: turns * 12 },
  cost: turns * 0.01,
});

export interface TestTurn {
  readonly text: string;
  readonly finish: (answer?: string) => Effect.Effect<void>;
  readonly part: (part: UiPart) => Effect.Effect<void>;
}

/** Fake only the Promise-based Pi runtime and model catalog; retain real scoped runtime/turn handling. */
export const makeWorkerFixture = Effect.fn("WorkflowWorkersTest.fixture")(function* (
  options: {
    readonly answers?: ReadonlyArray<string>;
    readonly projectPath?: string;
    readonly agentPath?: string;
    readonly unavailable?: boolean;
    readonly delayedRelease?: boolean;
  } = {},
) {
  const started = yield* Queue.unbounded<TestTurn>();
  const releaseStarted = yield* Deferred.make<void>();
  const releaseGate = yield* Deferred.make<void>();
  const constructed: CakeSessionRuntimeOptions[] = [];
  const configurations: ExplicitCakeModelSelection[] = [];
  const retained = new Map<string, ConversationSnapshot>();
  const calls = { prompts: 0, aborts: 0, releases: 0, notifications: 0 };
  const runtime = (input: CakeSessionRuntimeOptions): CakeSessionRuntime => {
    const sessionId = input.sessionId ?? crypto.randomUUID();
    let parts: UiPart[] = [];
    let streaming = false;
    let gate: Deferred.Deferred<void> | undefined;
    let configuration = model;
    let active: string[] = [];
    let turns = 0;
    const snapshot = (): ConversationSnapshot => ({
      ...snapshotBase,
      workspacePath: input.cwd,
      sessionId,
      sessionFile: `/private/${sessionId}.jsonl`,
      parts,
      streaming,
      thinkingLevel: configuration.thinkingLevel,
      fastMode: configuration.fastMode,
      model: { provider: configuration.provider, id: configuration.modelId, name: "Worker" },
      usage: usage(turns),
    });
    const emit = (part: UiPart) => {
      const index = parts.findIndex((entry) => entry.id === part.id);
      if (index < 0) parts = [...parts, part];
      else parts = parts.map((entry) => (entry.id === part.id ? part : entry));
      input.onEvent({ type: "part-updated", sessionId, part });
    };
    return {
      sessionId,
      sessionFile: `/private/${sessionId}.jsonl`,
      get streaming() {
        return streaming;
      },
      executingTurnIds: () => active,
      getReviewParentContext: () => ({
        sessionId,
        sessionFile: `/private/${sessionId}.jsonl`,
        systemPrompt: "worker",
        activeTools: input.tools ?? [],
      }),
      snapshot: async () => snapshot(),
      prompt: async (text, _delivery, _attachments, _markdown, turnId) => {
        turns += 1;
        calls.prompts += 1;
        active = turnId ? [turnId] : [];
        streaming = true;
        emit({ kind: "text", id: `user-${turns}`, role: "user", text, status: "complete" });
        const turnGate = Deferred.makeUnsafe<void>();
        gate = turnGate;
        const turn: TestTurn = {
          text,
          finish: (answer = "answer") =>
            Effect.sync(() => {
              emit({
                kind: "text",
                id: `answer-${turns}`,
                role: "assistant",
                text: answer,
                status: "complete",
              });
              if (turnId) input.onTurnResult?.(turnId, { stopReason: "stop", text: answer });
            }).pipe(Effect.andThen(Deferred.succeed(turnGate, undefined)), Effect.asVoid),
          part: (part) => Effect.sync(() => emit(part)),
        };
        await Effect.runPromise(Queue.offer(started, turn));
        const answer = options.answers?.[turns - 1];
        if (answer !== undefined) await Effect.runPromise(turn.finish(answer));
        await Effect.runPromise(Deferred.await(gate));
        streaming = false;
        active = [];
        input.onEvent({ type: "streaming", sessionId, streaming: false });
        retained.set(sessionId, snapshot());
      },
      abort: async () => {
        calls.aborts += 1;
        if (gate) await Effect.runPromise(Deferred.succeed(gate, undefined));
      },
      dispose: async () => {
        await Effect.runPromise(Deferred.succeed(releaseStarted, undefined));
        if (options.delayedRelease) await Effect.runPromise(Deferred.await(releaseGate));
        calls.releases += 1;
        retained.set(sessionId, snapshot());
      },
      applyConfiguration: async (value) => {
        configuration = value;
        configurations.push(value);
      },
      setModel: async (provider, modelId) => {
        configuration = { ...configuration, provider, modelId };
      },
      setThinkingLevel: async (thinkingLevel) => {
        configuration = { ...configuration, thinkingLevel };
      },
      setFastMode: async (fastMode) => {
        configuration = { ...configuration, fastMode };
      },
      setPiSetting: async () => undefined,
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
      setUserMessageMarkdown: async () => undefined,
      compact: async () => undefined,
      rename: async () => undefined,
      navigate: async () => undefined,
      recordReviewRun: () => undefined,
      notifySubagentCompletion: async () => {
        calls.notifications += 1;
      },
      queueCommand: async () => {
        throw new Error("Unexpected queueCommand");
      },
      inspectSession: async () => {
        throw new Error("Unexpected inspectSession");
      },
      fork: async () => {
        throw new Error("Unexpected fork");
      },
      toolCompact: async () => {
        throw new Error("Unexpected toolCompact");
      },
    };
  };
  const runtimes = makeCakeSessionRuntimesLayer({
    createRuntime: (input) =>
      Effect.sync(() => {
        constructed.push(input);
        return runtime(input);
      }),
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: (target) =>
      Effect.sync(() => {
        const snapshot = retained.get(target.sessionId);
        return snapshot
          ? {
              workspacePath: target.workingDirectory,
              sessionId: target.sessionId,
              sessionFile: snapshot.sessionFile,
              parts: snapshot.parts,
            }
          : undefined;
      }),
    changelog: () => Effect.succeed("test"),
  });
  const models = Layer.succeed(
    PiModels,
    makePiModels({
      loadCatalog: () =>
        Effect.succeed(
          ["worker", "alternate"].map((id) => ({
            provider: "test",
            providerName: "Test",
            id,
            name: id,
            reasoning: true,
            supportedThinkingLevels: ["off", "high"],
            fastMode: true,
            input: ["text"],
            authenticated: true,
            available: !options.unavailable,
            authTypes: [],
          })),
        ),
      loadNonChatCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      login: () => Effect.void,
      logout: () => Effect.void,
      complete: () => Effect.die("Unexpected completion"),
    }),
  );
  const environment = makeSubagentEnvironmentLayer({
    location: (workingDirectory) =>
      Effect.succeed({
        workingDirectory,
        agentDirectory: options.agentPath ?? "/agent",
        sessionDirectory: "/private",
        trusted: true,
      }),
  });
  return {
    layer: WorkflowWorkersLive.pipe(Layer.provide([runtimes, models, environment])),
    started,
    constructed,
    configurations,
    calls,
    retained,
    releaseStarted,
    releaseGate,
  };
});
