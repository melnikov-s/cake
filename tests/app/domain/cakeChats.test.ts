import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as cakeChats from "../../../src/domain/cakeChats";
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
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { Terminal } from "../../../src/services/terminal/Terminal";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "cake-chat-1",
  sessionFile: "/cake/global/cake-chat-1.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { revision: 0, statuses: [], notifications: [], editorTextRevision: 0 },
  sessions: [],
  tree: [],
};

const makeLayer = () => {
  let state: ApplicationStateValue = defaultApplicationState();
  let created = 0;
  let archived = 0;
  const toolCounts: number[] = [];
  const terminal = Terminal.of({
    open: () => Effect.die("Unexpected terminal open"),
    write: () => Effect.die("Unexpected terminal write"),
    resize: () => Effect.die("Unexpected terminal resize"),
    hasRunningProgram: () => Effect.die("Unexpected terminal status"),
    close: () => Effect.die("Unexpected terminal close"),
    closeSession: () => Effect.void,
    closeOwner: () => Effect.void,
    events: () => Stream.empty,
  });
  const application = ApplicationState.of({
    initialize: () => Effect.succeed(state),
    current: () => Effect.succeed(state),
    snapshot: () => state,
    changes: () => Stream.make({ revision: 0, state }),
    refreshProjection: () => Effect.void,
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
    prompt: async () => {
      options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: false });
    },
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
    fork: async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl" }),
    handoff: async () => ({ sessionId: "handoff", sessionFile: "/handoff.jsonl" }),
    navigate: async () => undefined,
    dispose: () => undefined,
  });
  const adapter: PiSessionsAdapter = {
    list: () => Effect.succeed([]),
    inspect: () => Effect.succeed(snapshot),
    createRuntime: (options) =>
      Effect.sync(() => {
        created += 1;
        return runtime(options);
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
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
              invoke: (request, signal) => invoke(input.sessionId, request, signal),
            },
          },
        };
      }),
    archive: () =>
      Effect.sync(() => {
        archived += 1;
      }),
    restore: () => Effect.void,
    deleteResolved: () => Effect.void,
  });
  return {
    layer: Layer.mergeAll(
      Layer.succeed(ApplicationState, application),
      makePiSessionsLayer(adapter),
      environment,
      SubagentCoordinatorLive,
      Layer.succeed(Terminal, terminal),
    ),
    created: () => created,
    archived: () => archived,
    toolCounts: () => toolCounts,
  };
};

describe("Cake Chats domain", () => {
  it.effect("keeps a pending Cake Chat unmaterialized until its first prompt", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      yield* cakeChats.list();
      assert.equal(fixture.created(), 0);
      const turnId = yield* cakeChats.prompt({
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
      yield* cakeChats.open({ sessionId: "cake-chat-1", tools });
      yield* cakeChats.open({ sessionId: "cake-chat-2", tools: [] });
      assert.deepEqual(fixture.toolCounts(), [1, 0]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("archives only a settled materialized Cake Chat", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      yield* cakeChats.resolve({ sessionId: "cake-chat-1", tools: [] });
      assert.equal(fixture.archived(), 1);
    }).pipe(Effect.provide(fixture.layer));
  });
});
