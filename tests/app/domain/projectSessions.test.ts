import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect";
import { describe } from "vitest";
import * as projectSessions from "../../../src/domain/projectSessions";
import { refreshProjection } from "../../../src/domain/application";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application-data";
import { makePiSessionsLayer, type PiSessionsAdapter } from "../../../src/services/pi/PiSessions";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
import { makeProjectSessionEnvironmentLayer } from "../../../src/services/project-sessions/ProjectSessionEnvironment";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";

const snapshot: SessionSnapshot = {
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
  sessions: [],
  tree: [],
};

const fakeRuntime = (options: CakeRuntimeOptions): CakeRuntime => ({
  sessionId: snapshot.sessionId,
  sessionFile: snapshot.sessionFile,
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
  fork: async () => ({ sessionId: "forked", sessionFile: "/sessions/forked.jsonl" }),
  handoff: async () => ({ sessionId: "handoff", sessionFile: "/sessions/handoff.jsonl" }),
  navigate: async () => undefined,
  dispose: () => undefined,
});

const makeLayer = (
  initial: ApplicationStateValue = {
    ...defaultApplicationState(),
    projects: [
      {
        path: "/project",
        name: "Project",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    trustedProjectPaths: ["/project"],
  },
) => {
  const application = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const projection = yield* SubscriptionRef.make({ revision: 0, state: initial });
      return ApplicationState.of({
        initialize: () => Effect.succeed(SubscriptionRef.getUnsafe(projection).state),
        current: () => SubscriptionRef.get(projection).pipe(Effect.map((current) => current.state)),
        unsafeCurrent: () => SubscriptionRef.getUnsafe(projection).state,
        changes: () => SubscriptionRef.changes(projection),
        refreshProjection: () =>
          SubscriptionRef.update(projection, (current) => ({
            revision: current.revision + 1,
            state: current.state,
          })),
        transact: (transition) =>
          SubscriptionRef.updateAndGetEffect(projection, (current) =>
            transition(current.state).pipe(
              Effect.map((state) => ({ revision: current.revision + 1, state })),
            ),
          ).pipe(Effect.map((current) => current.state)),
      });
    }),
  );
  const adapter: PiSessionsAdapter = {
    list: () =>
      Effect.succeed([
        {
          id: "session-1",
          title: "Active branch",
          created: "2026-01-01T00:00:00.000Z",
          modified: "2026-01-02T00:00:00.000Z",
          messageCount: 2,
          resolved: false,
        },
      ]),
    inspect: () =>
      Effect.succeed({
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
        sessionFile: snapshot.sessionFile,
        parts: snapshot.parts,
      }),
    createRuntime: (options) => Effect.succeed(fakeRuntime(options)),
    changelog: () => Effect.succeed("# Changelog"),
  };
  return Layer.mergeAll(
    application,
    makePiSessionsLayer(adapter),
    SubagentCoordinatorLive,
    makeProjectSessionEnvironmentLayer({
      locations: () =>
        Effect.succeed([
          {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved-sessions",
          },
        ]),
      runtimeOptions: ({ location, sessionId, newSession }) =>
        Effect.succeed({
          profile: { _tag: "ProjectSession" },
          runtime: {
            cwd: location.workingDirectory,
            trusted: true,
            agentDir: "/agent",
            sessionDir: location.sessionDirectory,
            resolvedSessionDir: location.resolvedSessionDirectory,
            sessionId,
            newSession,
            requestUi: async () => undefined,
          },
        }),
      archive: () => Effect.void,
      restore: (_sessionId, location) => Effect.succeed(location),
      forkToWorkingDirectory: () => Effect.succeed("forked"),
    }),
  );
};

describe("Project Sessions domain", () => {
  it.effect("observes a current catalog Snapshot followed by ordered replacement Events", () =>
    Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog();
      const ready = yield* Deferred.make<void>();
      const fiber = yield* updates.pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* refreshProjection();
      const observed = Array.from(yield* Fiber.join(fiber));
      assert.deepEqual(
        observed.map((update) => update._tag),
        ["Snapshot", "Event"],
      );
      assert.ok(observed[1]!.revision > observed[0]!.revision);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("lists Project and Working Directory associations above PiSessions", () =>
    Effect.gen(function* () {
      const sessions = yield* projectSessions.list();
      assert.deepEqual(
        sessions.map(({ sessionId, projectPath, workingDirectory }) => ({
          sessionId,
          projectPath,
          workingDirectory,
        })),
        [{ sessionId: "session-1", projectPath: "/project", workingDirectory: "/project" }],
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("emits a Cake snapshot and returns an accepted Turn ID", () =>
    Effect.gen(function* () {
      const stream = yield* projectSessions.observe({ sessionId: "session-1" });
      const initial = yield* stream.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(initial[0]?._tag, "Snapshot");
      const turnId = yield* projectSessions.prompt({
        sessionId: "session-1",
        text: "Implement it",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      assert.match(turnId, /^[0-9a-f-]{36}$/);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("opens an untrusted Working Directory with local executable resources disabled", () =>
    Effect.gen(function* () {
      const opened = yield* projectSessions.open({ sessionId: "session-1" });
      assert.equal(opened.sessionId, "session-1");
    }).pipe(
      Effect.provide(
        makeLayer({
          ...defaultApplicationState(),
          projects: [
            {
              path: "/project",
              name: "Project",
              addedAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    ),
  );
});
