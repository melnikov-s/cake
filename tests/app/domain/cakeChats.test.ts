import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as cakeChatMetadata from "../../../src/domain/cakeChatMetadata";
import * as cakeChatOperations from "../../../src/domain/cakeChatOperations";
import * as cakeChatContinuations from "../../../src/domain/cakeChatContinuations";
import * as cakeChatLifecycle from "../../../src/domain/cakeChatLifecycle";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application-data";
import { makeCakeChatEnvironmentLayer } from "../../../src/services/cake-chats/CakeChatEnvironment";
import { makePiSessionsLayer, type PiSessionsAdapter } from "../../../src/services/pi/PiSessions";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { Electron } from "../../../src/services/electron/Electron";
import { RendererRequestCoordinatorLive } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "cake-chat-1",
  sessionFile: "/cake/global/cake-chat-1.jsonl",
  parts: [
    {
      id: "user-message",
      kind: "text",
      role: "user",
      text: "Hello",
      status: "complete",
      renderAs: undefined,
    },
  ],
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

const makeLayer = (
  initial: ApplicationStateValue = defaultApplicationState(),
  options: { resolvedOnDisk?: boolean } = {},
) => {
  let state = initial;
  let resolvedOnDisk = options.resolvedOnDisk ?? false;
  let created = 0;
  let archived = 0;
  let restored = 0;
  const toolCounts: number[] = [];
  const operations: string[] = [];
  const terminal = Terminal.of({
    open: () => Effect.die("Unexpected terminal open"),
    write: () => Effect.die("Unexpected terminal write"),
    resize: () => Effect.die("Unexpected terminal resize"),
    runningProgramCount: () => Effect.die("Unexpected terminal status"),
    close: () => Effect.die("Unexpected terminal close"),
    closeWorkingDirectory: () => Effect.void,
    closeOwner: () => Effect.void,
    events: () => Stream.empty,
  });
  const application = ApplicationState.of({
    initialize: () => Effect.succeed(state),
    current: () => Effect.succeed(state),
    snapshot: () => state,
    changes: () => Stream.make({ revision: 0, state }),
    transact: (transition) =>
      transition(state).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            state = next;
          }),
        ),
      ),
  });
  const runtime = (options: CakeRuntimeOptions): CakeRuntime => ({
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    streaming: false,
    snapshot: async () => snapshot,
    listQueuedMessages: async () => ({ steering: [], followUp: [] }),
    clearQueue: async () => ({ steering: [], followUp: [] }),
    cancelSteering: async () => ({ steering: [], followUp: [] }),
    prompt: async () => {
      options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: false });
    },
    editMessage: async () => {
      operations.push("edit");
    },
    setUserMessageMarkdown: async () => undefined,
    compact: async () => {
      operations.push("compact");
    },
    abort: async () => {
      operations.push("abort");
    },
    setModel: async () => {
      operations.push("model");
    },
    setThinkingLevel: async () => {
      operations.push("thinking");
    },
    setFastMode: async () => {
      operations.push("fast");
    },
    applyConfiguration: async () => {
      operations.push("configuration");
    },
    setPiSetting: async () => {
      operations.push("setting");
    },
    recordReviewRun: () => undefined,
    login: async () => {
      operations.push("login");
    },
    logout: async () => {
      operations.push("logout");
    },
    rename: async () => undefined,
    fork: async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl" }),
    handoff: async () => ({ sessionId: "handoff", sessionFile: "/handoff.jsonl" }),
    navigate: async () => undefined,
    dispose: () => undefined,
  });
  const adapter: PiSessionsAdapter = {
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(snapshot),
    createRuntime: (options) =>
      Effect.sync(() => {
        created += 1;
        return runtime(options);
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
  const electron = Layer.mock(Electron, {
    sendTo: () => {},
    broadcast: () => {},
    requireRendererConnection: () => {
      throw new Error("Unexpected renderer event");
    },
    workspaceForConnection: () => undefined,
    associateWorkspace: () => {},
    forgetWorkspace: () => {},
    windowsForWorkspace: () => [],
    centerTrafficLights: () => {},
  });
  const rendererRequests = RendererRequestCoordinatorLive.pipe(Layer.provide(electron));
  const environment = makeCakeChatEnvironmentLayer({
    location: () =>
      Effect.succeed({
        workingDirectory: "/home/user",
        sessionDirectory: "/cake/global",
        resolvedSessionDirectory: "/cake/global-resolved",
      }),
    runtimeOptions: (input, invoke) =>
      Effect.sync(() => {
        toolCounts.push(input.tools.length);
        return {
          profile: { _tag: "CakeChatSession" },
          runtime: {
            cwd: "/home/user",
            trusted: true,
            agentDir: "/cake",
            sessionDir: "/cake/global",
            sessionId: input.sessionId,
            newSession: input.newSession,
            requestUi: async () => undefined,
            globalControl: {
              tools: [],
              invoke: (request, signal) =>
                Effect.runPromise(invoke(input.sessionId, request, signal)),
            },
          },
        };
      }),
    archive: () =>
      Effect.sync(() => {
        archived += 1;
        resolvedOnDisk = true;
      }),
    restore: () =>
      Effect.sync(() => {
        restored += 1;
        resolvedOnDisk = false;
      }),
    deleteResolved: () =>
      Effect.sync(() => {
        resolvedOnDisk = false;
      }),
  }).pipe(Layer.provide(rendererRequests));
  return {
    layer: Layer.mergeAll(
      Layer.succeed(ApplicationState, application),
      SessionCatalogChanges.layer,
      makePiSessionsLayer(adapter),
      Layer.succeed(
        SessionArchiveStorage,
        SessionArchiveStorage.of({
          resolve: () => Effect.succeed(false),
          restore: () => Effect.succeed(false),
          deleteResolved: () => Effect.void,
          delete: () => Effect.void,
          locate: () => Effect.succeed(resolvedOnDisk ? "resolved" : "active"),
          resolved: () => Stream.empty,
          resolvedEntry: () => Effect.succeed(undefined),
          resolveProject: () => Effect.succeed(false),
          restoreProject: () => Effect.succeed(undefined),
          deleteResolvedProject: () => Effect.void,
          resolvedProjects: () => Stream.empty,
          projectMigrationComplete: () => Effect.succeed(true),
          migrateProject: () => Stream.empty,
          resolvedProjectEntry: () => Effect.succeed(undefined),
        }),
      ),
      rendererRequests,
      environment,
      SubagentCoordinatorLive,
      Layer.succeed(Terminal, terminal),
    ),
    created: () => created,
    archived: () => archived,
    restored: () => restored,
    state: () => state,
    toolCounts: () => toolCounts,
    operations: () => operations,
  };
};

describe("Cake Chats domain", () => {
  it.effect("keeps a pending Cake Chat unmaterialized until its first prompt", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const updates = yield* cakeChatMetadata.observeCatalog({ resolved: false });
      yield* updates.pipe(Stream.take(1), Stream.runDrain);
      assert.equal(fixture.created(), 0);
      const turnId = yield* cakeChatOperations.prompt({
        sessionId: "cake-chat-1",
        text: "Find my task",
        attachments: [],
        renderUserMessageAsMarkdown: false,
        newSession: { tools: [] },
      });
      assert.match(turnId, /^[0-9a-f-]{36}$/);
      assert.equal(fixture.created(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("handoffs without constructing a destination runtime and copies Fast mode", () => {
    const fixture = makeLayer({
      ...defaultApplicationState(),
      fastModeSessionIds: ["cake-chat-1"],
    });
    return Effect.gen(function* () {
      const result = yield* cakeChatContinuations.handoff({
        target: { sessionId: "cake-chat-1", tools: [] },
        entryId: "assistant-entry",
      });
      assert.equal(result.sessionId, "handoff");
      assert.equal(fixture.created(), 1);
      assert.deepEqual(fixture.state().fastModeSessionIds, ["cake-chat-1", "handoff"]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("previews a resolved Cake Chat without restoring or constructing its runtime", () => {
    const fixture = makeLayer(defaultApplicationState(), { resolvedOnDisk: true });
    return Effect.gen(function* () {
      const opened = yield* cakeChatOperations.open({ sessionId: "cake-chat-1", tools: [] });
      assert.equal(opened.sessionId, "cake-chat-1");
      assert.deepEqual(opened.parts[0], {
        id: "user-message",
        kind: "text",
        role: "user",
        text: "Hello",
        status: "complete",
      });
      assert.equal(fixture.created(), 0);
      assert.equal(fixture.restored(), 0);

      const updates = yield* cakeChatOperations.observe({ sessionId: "cake-chat-1", tools: [] });
      const preview = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
      assert.equal(preview[0]?._tag, "Snapshot");
      assert.equal(fixture.created(), 0);
      assert.equal(fixture.restored(), 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores a resolved Cake Chat when a message is submitted", () => {
    const fixture = makeLayer(defaultApplicationState(), { resolvedOnDisk: true });
    return Effect.gen(function* () {
      yield* cakeChatOperations.prompt({
        sessionId: "cake-chat-1",
        text: "Continue",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      assert.equal(fixture.restored(), 1);
      assert.equal(fixture.created(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("routes matching conversation controls through one acquired Cake Chat runtime", () => {
    const fixture = makeLayer();
    const target = { sessionId: "cake-chat-1", tools: [] };
    return Effect.gen(function* () {
      yield* cakeChatOperations.compact(target, "Keep the architecture notes");
      yield* cakeChatOperations.editMessage({
        sessionId: target.sessionId,
        entryId: "user-message",
        text: "Updated",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      yield* cakeChatOperations.applyConfiguration(target, {
        provider: "fixture-provider",
        modelId: "fixture-model",
        thinkingLevel: "medium",
        fastMode: false,
      });
      yield* cakeChatOperations.setModel(target, "fixture-provider", "fixture-model");
      yield* cakeChatOperations.setThinkingLevel(target, "high");
      yield* cakeChatOperations.setFastMode(target, true);
      yield* cakeChatOperations.setPiSetting(target, { key: "retryEnabled", value: false });
      yield* cakeChatOperations.login(target, "fixture-provider", "api_key");
      yield* cakeChatOperations.logout(target, "fixture-provider");
      yield* cakeChatOperations.abort(target);

      assert.equal(fixture.created(), 1);
      assert.deepEqual(fixture.operations(), [
        "compact",
        "edit",
        "configuration",
        "model",
        "thinking",
        "fast",
        "setting",
        "login",
        "logout",
        "abort",
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("does not reuse curated tools across Cake Chat sessions", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const tools = [
        {
          command: "open-project",
          topic: "projects",
          summary: "Open one project",
          parameters: {},
        },
      ];
      yield* cakeChatOperations.open({ sessionId: "cake-chat-1", tools });
      yield* cakeChatOperations.open({ sessionId: "cake-chat-2", tools: [] });
      assert.deepEqual(fixture.toolCounts(), [1, 0]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("archives only a settled materialized Cake Chat", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      yield* cakeChatLifecycle.resolve({ sessionId: "cake-chat-1", tools: [] });
      assert.equal(fixture.archived(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });
});
