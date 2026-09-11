import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as cakeChatMetadata from "../../../src/domain/cake-chats/cakeChatMetadata";
import * as cakeChatOperations from "../../../src/domain/cake-chats/cakeChatOperations";
import * as cakeChatContinuations from "../../../src/domain/cake-chats/cakeChatContinuations";
import * as cakeChatLifecycle from "../../../src/domain/cake-chats/cakeChatLifecycle";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application/application-data";
import type { CakeChatRuntimeConfiguration } from "../../../src/domain/cake-chats/cakeChatRuntime";
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
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";

const configuration: CakeChatRuntimeConfiguration = {
  location: {
    workingDirectory: "/home/user",
    sessionDirectory: "/cake/global",
    resolvedSessionDirectory: "/cake/global-resolved",
  },
  agentDirectory: "/cake",
};

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
  const acquiredRuntimeOptions: CakeRuntimeOptions[] = [];
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
    toolCompact: async () => ({
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
    }),
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
        acquiredRuntimeOptions.push(options);
        toolCounts.push(options.globalControl?.tools.length ?? 0);
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
  return {
    layer: Layer.mergeAll(
      Layer.succeed(ApplicationState, application),
      SessionCatalogChanges.layer,
      makePiSessionsLayer(adapter),
      Layer.succeed(
        SessionArchiveStorage,
        SessionArchiveStorage.of({
          resolve: () =>
            Effect.sync(() => {
              archived += 1;
              resolvedOnDisk = true;
              return true;
            }),
          restore: () =>
            Effect.sync(() => {
              restored += 1;
              resolvedOnDisk = false;
              return true;
            }),
          deleteResolved: () =>
            Effect.sync(() => {
              resolvedOnDisk = false;
            }),
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
      SubagentCoordinatorLive,
      Layer.mock(SubagentEnvironment, {
        location: () => Effect.die("Unexpected Subagent Environment location"),
      }),
      Layer.succeed(Terminal, terminal),
    ),
    created: () => created,
    archived: () => archived,
    restored: () => restored,
    state: () => state,
    toolCounts: () => toolCounts,
    runtimeOptions: () => acquiredRuntimeOptions,
    operations: () => operations,
  };
};

describe("Cake Chats domain", () => {
  it.effect("keeps a pending Cake Chat unmaterialized until its first prompt", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const updates = yield* cakeChatMetadata.observeCatalog(
        { resolved: false },
        configuration.location,
      );
      yield* updates.pipe(Stream.take(1), Stream.runDrain);
      assert.equal(fixture.created(), 0);
      const turnId = yield* cakeChatOperations.prompt(
        {
          sessionId: "cake-chat-1",
          tools: [],
          text: "Find my task",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          newSession: {},
        },
        configuration,
      );
      assert.match(turnId, /^[0-9a-f-]{36}$/);
      assert.equal(fixture.created(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("tool-compacts in the session tree without changing identity or Fast mode", () => {
    const fixture = makeLayer({
      ...defaultApplicationState(),
      fastModeSessionIds: ["cake-chat-1"],
    });
    return Effect.gen(function* () {
      const result = yield* cakeChatContinuations.toolCompact({
        target: { sessionId: "cake-chat-1", tools: [] },
        entryId: "assistant-entry",
        configuration,
      });
      assert.equal(result.sessionId, "cake-chat-1");
      assert.equal(fixture.created(), 1);
      assert.deepEqual(fixture.state().fastModeSessionIds, ["cake-chat-1"]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("previews a resolved Cake Chat without restoring or constructing its runtime", () => {
    const fixture = makeLayer(defaultApplicationState(), { resolvedOnDisk: true });
    return Effect.gen(function* () {
      const opened = yield* cakeChatOperations.open(
        { sessionId: "cake-chat-1", tools: [] },
        configuration,
      );
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

      const updates = yield* cakeChatOperations.observe(
        { sessionId: "cake-chat-1", tools: [] },
        configuration,
      );
      const preview = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
      assert.equal(preview[0]?._tag, "Snapshot");
      assert.equal(fixture.created(), 0);
      assert.equal(fixture.restored(), 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores a resolved Cake Chat when a message is submitted", () => {
    const fixture = makeLayer(defaultApplicationState(), { resolvedOnDisk: true });
    return Effect.gen(function* () {
      yield* cakeChatOperations.prompt(
        {
          sessionId: "cake-chat-1",
          tools: [],
          text: "Continue",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        configuration,
      );
      assert.equal(fixture.restored(), 1);
      assert.equal(fixture.created(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("routes matching conversation controls through one acquired Cake Chat runtime", () => {
    const fixture = makeLayer();
    const target = { sessionId: "cake-chat-1", tools: [] };
    return Effect.gen(function* () {
      yield* cakeChatOperations.compact(target, "Keep the architecture notes", configuration);
      yield* cakeChatOperations.editMessage(
        {
          sessionId: target.sessionId,
          tools: target.tools,
          entryId: "user-message",
          text: "Updated",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        configuration,
      );
      yield* cakeChatOperations.applyConfiguration(
        target,
        {
          provider: "fixture-provider",
          modelId: "fixture-model",
          thinkingLevel: "medium",
          fastMode: false,
        },
        configuration,
      );
      yield* cakeChatOperations.setModel(
        target,
        "fixture-provider",
        "fixture-model",
        configuration,
      );
      yield* cakeChatOperations.setThinkingLevel(target, "high", configuration);
      yield* cakeChatOperations.setFastMode(target, true, configuration);
      yield* cakeChatOperations.setPiSetting(
        target,
        { key: "retryEnabled", value: false },
        configuration,
      );
      yield* cakeChatOperations.login(target, "fixture-provider", "api_key", configuration);
      yield* cakeChatOperations.logout(target, "fixture-provider", configuration);
      yield* cakeChatOperations.abort(target, configuration);

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
      yield* cakeChatOperations.open({ sessionId: "cake-chat-1", tools }, configuration);
      yield* cakeChatOperations.open({ sessionId: "cake-chat-2", tools: [] }, configuration);
      assert.deepEqual(fixture.toolCounts(), [1, 0]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("keeps curated tools when a Cake Chat runtime is reacquired", () => {
    const fixture = makeLayer();
    const tools = [
      {
        command: "open-project",
        topic: "projects",
        summary: "Open one project",
        parameters: {},
      },
    ];
    return Effect.gen(function* () {
      yield* Effect.scoped(
        cakeChatOperations.open({ sessionId: "cake-chat-1", tools }, configuration),
      );
      yield* Effect.scoped(
        cakeChatOperations.prompt(
          {
            sessionId: "cake-chat-1",
            tools,
            text: "Continue",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          configuration,
        ),
      );
      assert.deepEqual(fixture.toolCounts(), [1, 1]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("composes Cake Chat runtime capability policy in the domain", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      yield* cakeChatOperations.open(
        {
          sessionId: "cake-chat-1",
          tools: [
            {
              command: "open-project",
              topic: "projects",
              summary: "Open one project",
              parameters: { type: "object", properties: { path: { type: "string" } } },
              examples: [{ input: { path: "/repo" }, description: "Open a repository" }],
            },
          ],
        },
        configuration,
      );
      const [options] = fixture.runtimeOptions();
      assert.ok(options);
      assert.equal(options.cwd, "/home/user");
      assert.equal(options.trusted, true);
      assert.equal(options.agentDir, "/cake");
      assert.equal(options.sessionDir, "/cake/global");
      assert.equal(options.resolvedSessionDir, "/cake/global-resolved");
      assert.deepEqual(options.slashCommands, ["compact", "model", "toolcompact"]);
      assert.equal(options.currentSessionControl?.resolved(), false);
      assert.ok(options.agentControl);
      assert.deepEqual(options.globalControl?.tools[0]?.parameters, {
        type: "object",
        properties: { path: { type: "string" } },
      });
      assert.deepEqual(options.modelPresets?.(), { presets: [], defaultPresetId: undefined });
      const fastMode = options.fastMode;
      assert.equal(fastMode?.get(), false);
      if (!fastMode) return assert.fail("Expected Fast mode controls");
      yield* Effect.promise(() => fastMode.set(true));
      assert.deepEqual(fixture.state().fastModeSessionIds, ["cake-chat-1"]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("archives only a settled materialized Cake Chat", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      yield* cakeChatLifecycle.resolve({ sessionId: "cake-chat-1", tools: [] }, configuration);
      assert.equal(fixture.archived(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });
});
