import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect";
import { describe } from "vitest";
import * as projectSessions from "../../../src/domain/projectSessions";
import { getState } from "../../../src/domain/application";
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
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
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

const fakeRuntime = (
  options: CakeRuntimeOptions,
  prompt: () => Promise<void> = async () => undefined,
): CakeRuntime => ({
  sessionId: snapshot.sessionId,
  sessionFile: snapshot.sessionFile,
  streaming: false,
  snapshot: async () => snapshot,
  prompt: async () => {
    await prompt();
    options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: false });
  },
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
  hooks: {
    onCreateRuntime?(): void;
    onArchive?(): void;
    onRestore?(): void;
    onCatalog?(): void;
    catalogModifiedAt?(): string;
    onResolvedCatalog?(): void;
    onMigrateProject?(): void;
    onLocations?(): void;
    onRuntimeOptions?(newSession: boolean): void;
    prompt?(): Promise<void>;
    sessionExists?: boolean;
    resolvedOnDisk?: boolean;
    migrationComplete?: boolean;
  } = {},
) => {
  let resolvedOnDisk = hooks.resolvedOnDisk ?? false;
  const application = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const projection = yield* SubscriptionRef.make({ revision: 0, state: initial });
      return ApplicationState.of({
        initialize: () => Effect.succeed(SubscriptionRef.getUnsafe(projection).state),
        current: () => SubscriptionRef.get(projection).pipe(Effect.map((current) => current.state)),
        snapshot: () => SubscriptionRef.getUnsafe(projection).state,
        changes: () => SubscriptionRef.changes(projection),
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
    catalog: () => {
      hooks.onCatalog?.();
      return hooks.sessionExists === false || resolvedOnDisk
        ? Stream.empty
        : Stream.make({
            id: "session-1",
            title: "Active branch",
            created: "2026-01-01T00:00:00.000Z",
            modified: hooks.catalogModifiedAt?.() ?? "2026-01-02T00:00:00.000Z",
            messageCount: 2,
            resolved: false,
          });
    },
    catalogEntry: () =>
      hooks.sessionExists === false || resolvedOnDisk
        ? Effect.succeed(undefined)
        : Effect.succeed({
            id: "session-1",
            title: "Active branch",
            created: "2026-01-01T00:00:00.000Z",
            modified: hooks.catalogModifiedAt?.() ?? "2026-01-02T00:00:00.000Z",
            messageCount: 2,
            resolved: false,
          }),
    inspect: () =>
      Effect.succeed({
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
        sessionFile: snapshot.sessionFile,
        parts: snapshot.parts,
      }),
    createRuntime: (options) =>
      Effect.sync(() => {
        hooks.onCreateRuntime?.();
        return fakeRuntime(options, hooks.prompt);
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
  return Layer.mergeAll(
    application,
    SessionCatalogChanges.layer,
    makePiSessionsLayer(adapter),
    SubagentCoordinatorLive,
    makeProjectSessionEnvironmentLayer({
      locations: () => {
        hooks.onLocations?.();
        return Effect.succeed([
          {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved-sessions",
          },
        ]);
      },
      runtimeOptions: ({ location, sessionId, newSession }) =>
        Effect.sync(() => {
          hooks.onRuntimeOptions?.(newSession);
          return {
            profile: { _tag: "ProjectSession" as const },
            runtime: {
              cwd: location.workingDirectory,
              trusted: true,
              agentDir: "/agent",
              sessionDir: location.sessionDirectory,
              resolvedSessionDir: location.resolvedSessionDirectory,
              sessionId,
              newSession,
              requestUi: async () => undefined,
              fastMode: {
                get: () => initial.fastModeSessionIds.includes(sessionId),
                set: async () => undefined,
              },
            },
          };
        }),
      archive: () =>
        Effect.sync(() => {
          resolvedOnDisk = true;
          hooks.onArchive?.();
        }),
      restore: (_sessionId, location) =>
        Effect.sync(() => {
          resolvedOnDisk = false;
          hooks.onRestore?.();
          return location;
        }),
      forkToWorkingDirectory: () => Effect.succeed("forked"),
    }),
    Layer.succeed(
      SessionArchiveStorage,
      SessionArchiveStorage.of({
        resolve: () => Effect.succeed(false),
        restore: () => Effect.succeed(false),
        deleteResolved: () => Effect.void,
        delete: () => Effect.void,
        locate: () =>
          Effect.succeed(
            hooks.sessionExists === false ? undefined : resolvedOnDisk ? "resolved" : "active",
          ),
        resolved: () => {
          hooks.onResolvedCatalog?.();
          return hooks.sessionExists === false || !resolvedOnDisk
            ? Stream.empty
            : Stream.make({
                id: "session-1",
                title: "session-1",
                created: "2026-01-01T00:00:00.000Z",
                modified: "2026-01-02T00:00:00.000Z",
                messageCount: 0,
                resolved: true,
              });
        },
        resolvedEntry: () =>
          hooks.sessionExists === false || !resolvedOnDisk
            ? Effect.succeed(undefined)
            : Effect.succeed({
                id: "session-1",
                title: "session-1",
                created: "2026-01-01T00:00:00.000Z",
                modified: "2026-01-02T00:00:00.000Z",
                messageCount: 0,
                resolved: true,
              }),
        resolveProject: () => Effect.succeed(false),
        restoreProject: () => Effect.succeed(undefined),
        deleteResolvedProject: () => Effect.void,
        resolvedProjects: (projectPath) => {
          hooks.onResolvedCatalog?.();
          return hooks.sessionExists === false || !resolvedOnDisk
            ? Stream.empty
            : Stream.make({
                version: 1 as const,
                sessionId: "session-1",
                title: "session-1",
                projectPath,
                projectName: "Project",
                workingDirectory: "/project",
                activeRoot: "/sessions",
                resolvedRoot: "/resolved-sessions",
                createdAt: "2026-01-01T00:00:00.000Z",
                modifiedAt: "2026-01-02T00:00:00.000Z",
              });
        },
        projectMigrationComplete: () => Effect.succeed(hooks.migrationComplete ?? true),
        migrateProject: (projectPath) => {
          hooks.onMigrateProject?.();
          return hooks.sessionExists === false || !resolvedOnDisk
            ? Stream.empty
            : Stream.make({
                version: 1 as const,
                sessionId: "session-1",
                title: "session-1",
                projectPath,
                projectName: "Project",
                workingDirectory: "/project",
                activeRoot: "/sessions",
                resolvedRoot: "/resolved-sessions",
                createdAt: "2026-01-01T00:00:00.000Z",
                modifiedAt: "2026-01-02T00:00:00.000Z",
              });
        },
        resolvedProjectEntry: () =>
          hooks.sessionExists === false || !resolvedOnDisk
            ? Effect.succeed(undefined)
            : Effect.succeed({
                version: 1 as const,
                sessionId: "session-1",
                title: "session-1",
                projectPath: "/project",
                projectName: "Project",
                workingDirectory: "/project",
                activeRoot: "/sessions",
                resolvedRoot: "/resolved-sessions",
                createdAt: "2026-01-01T00:00:00.000Z",
                modifiedAt: "2026-01-02T00:00:00.000Z",
              }),
      }),
    ),
    Layer.succeed(
      Terminal,
      Terminal.of({
        open: () => Effect.die("Unexpected terminal open"),
        write: () => Effect.die("Unexpected terminal write"),
        resize: () => Effect.die("Unexpected terminal resize"),
        hasRunningProgram: () => Effect.die("Unexpected terminal status"),
        close: () => Effect.die("Unexpected terminal close"),
        closeSession: () => Effect.void,
        closeOwner: () => Effect.void,
        events: () => Stream.empty,
      }),
    ),
  );
};

describe("Project Sessions domain", () => {
  it.effect("loads resolved metadata without consulting Pi or project environments", () => {
    let piCatalogs = 0;
    let locations = 0;
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: true,
      });
      const first = yield* updates.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(first[0]?._tag, "Snapshot");
      assert.equal(piCatalogs, 0);
      assert.equal(locations, 0);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          resolvedOnDisk: true,
          onCatalog: () => piCatalogs++,
          onLocations: () => locations++,
        }),
      ),
    );
  });

  it.effect("lazily migrates legacy resolved metadata when its project is expanded", () => {
    let locations = 0;
    let migrations = 0;
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: true,
      });
      const first = yield* updates.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(first[0]?._tag, "Snapshot");
      assert.equal(locations, 1);
      assert.equal(migrations, 1);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          resolvedOnDisk: true,
          migrationComplete: false,
          onLocations: () => locations++,
          onMigrateProject: () => migrations++,
        }),
      ),
    );
  });

  it.effect("does not touch resolved storage for an active catalog stream", () => {
    let resolvedCatalogs = 0;
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      yield* updates.pipe(Stream.take(1), Stream.runDrain);
      assert.equal(resolvedCatalogs, 0);
    }).pipe(Effect.provide(makeLayer(undefined, { onResolvedCatalog: () => resolvedCatalogs++ })));
  });

  it.effect("updates one catalog entry without restarting its initial scan", () => {
    let catalogScans = 0;
    return Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const application = yield* ApplicationState;
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const ready = yield* Deferred.make<void>();
      const fiber = yield* updates.pipe(
        Stream.tap((update) =>
          update.revision === 1 ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* application.transact((state) => Effect.succeed({ ...state, trustedProjectPaths: [] }));
      yield* catalogs.publish({
        _tag: "ProjectSessionChanged",
        sessionId: "session-1",
        projectPath: "/project",
        workingDirectory: "/project",
        resolved: false,
      });
      const observed = Array.from(yield* Fiber.join(fiber));
      assert.deepEqual(
        observed.map((update) => update._tag),
        ["Snapshot", "Event"],
      );
      assert.deepEqual(
        observed.flatMap((update) => (update._tag === "Event" ? [update.event._tag] : [])),
        ["Upserted"],
      );
      assert.equal(catalogScans, 1);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          onCatalog: () => catalogScans++,
          catalogModifiedAt: (() => {
            let revision = 1;
            return () => `2026-01-0${revision++}T00:00:00.000Z`;
          })(),
        }),
      ),
    );
  });

  it.effect("moves a resolved session without restarting the active metadata stream", () => {
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const ready = yield* Deferred.make<void>();
      const fiber = yield* updates.pipe(
        Stream.tap((update) =>
          update.revision === 1 ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* projectSessions.resolve({
        sessionId: "session-1",
        workingDirectory: "/project",
      });
      const observed = Array.from(yield* Fiber.join(fiber));
      assert.deepEqual(observed[1], {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "Removed",
          sessionId: "session-1",
        },
      });
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("streams Project and Working Directory metadata above PiSessions", () =>
    Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const observed = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
      const first = observed[0];
      assert.equal(first?._tag, "Snapshot");
      const sessions = first?._tag === "Snapshot" ? first.sessions : [];
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

  it.effect("handoffs without constructing a destination runtime and copies Fast mode", () => {
    let runtimeConstructions = 0;
    return Effect.gen(function* () {
      const result = yield* projectSessions.handoff({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
      });
      assert.equal(result.sessionId, "handoff");
      assert.equal(runtimeConstructions, 1);
      const state = yield* getState();
      assert.deepEqual(state.fastModeSessionIds, ["session-1", "handoff"]);
    }).pipe(
      Effect.provide(
        makeLayer(
          {
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
            fastModeSessionIds: ["session-1"],
          },
          { onCreateRuntime: () => runtimeConstructions++ },
        ),
      ),
    );
  });

  it.effect("resolves a located idle session without constructing a Pi runtime", () => {
    let runtimeConstructions = 0;
    let archives = 0;
    return Effect.gen(function* () {
      yield* projectSessions.resolve({
        sessionId: "session-1",
        workingDirectory: "/project",
      });
      assert.equal(runtimeConstructions, 0);
      assert.equal(archives, 1);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          onCreateRuntime: () => runtimeConstructions++,
          onArchive: () => archives++,
        }),
      ),
    );
  });

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

  it.effect("observes a newly started runtime before its session file is discoverable", () => {
    let finishPrompt!: () => void;
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    return Effect.gen(function* () {
      yield* projectSessions.start({
        sessionId: "session-1",
        workingDirectory: "/project",
        text: "First message",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });

      const updates = yield* projectSessions.observe({
        sessionId: "session-1",
        workingDirectory: "/project",
      });
      const initial = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));

      assert.equal(initial[0]?._tag, "Snapshot");
      finishPrompt();
    }).pipe(
      Effect.ensuring(Effect.sync(() => finishPrompt?.())),
      Effect.provide(makeLayer(undefined, { sessionExists: false, prompt: () => prompt })),
    );
  });

  it.effect("never materializes a new Pi Session through observation", () => {
    const creationModes: boolean[] = [];
    return Effect.gen(function* () {
      const stream = yield* projectSessions.observe({
        sessionId: "session-1",
        workingDirectory: "/project",
      });
      yield* stream.pipe(Stream.take(1), Stream.runDrain);
      assert.deepEqual(creationModes, [false]);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          onRuntimeOptions: (newSession) => creationModes.push(newSession),
        }),
      ),
    );
  });

  it.effect("activates an unresolved session without constructing a Pi runtime", () => {
    let runtimeConstructions = 0;
    return Effect.gen(function* () {
      yield* projectSessions.open({ sessionId: "session-1" });
      assert.equal(runtimeConstructions, 0);
    }).pipe(
      Effect.provide(
        makeLayer(
          {
            ...defaultApplicationState(),
            projects: [
              {
                path: "/project",
                name: "Project",
                addedAt: "2026-01-01T00:00:00.000Z",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          { onCreateRuntime: () => runtimeConstructions++ },
        ),
      ),
    );
  });

  it.effect("previews a resolved session without restoring or constructing its runtime", () => {
    let runtimeConstructions = 0;
    let restores = 0;
    return Effect.gen(function* () {
      yield* projectSessions.open({ sessionId: "session-1" });
      assert.equal(runtimeConstructions, 0);
      assert.equal(restores, 0);

      const updates = yield* projectSessions.observe({ sessionId: "session-1" });
      const preview = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
      assert.equal(preview[0]?._tag, "Snapshot");
      const first = preview[0];
      if (first?._tag === "Snapshot")
        assert.deepEqual(first.snapshot.conversation.parts[0], {
          id: "user-message",
          kind: "text",
          role: "user",
          text: "Hello",
          status: "complete",
        });
      assert.equal(runtimeConstructions, 0);
      assert.equal(restores, 0);
    }).pipe(
      Effect.provide(
        makeLayer(
          {
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
          {
            onCreateRuntime: () => runtimeConstructions++,
            onRestore: () => restores++,
            resolvedOnDisk: true,
          },
        ),
      ),
    );
  });

  it.effect("restores a resolved session when a message is submitted", () => {
    let runtimeConstructions = 0;
    let restores = 0;
    return Effect.gen(function* () {
      yield* projectSessions.prompt({
        sessionId: "session-1",
        text: "Continue",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      assert.equal(restores, 1);
      assert.equal(runtimeConstructions, 1);
    }).pipe(
      Effect.provide(
        makeLayer(
          {
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
          {
            onCreateRuntime: () => runtimeConstructions++,
            onRestore: () => restores++,
            resolvedOnDisk: true,
          },
        ),
      ),
    );
  });

  it.effect("rejects an unresolved session that is missing from its Working Directory", () =>
    Effect.gen(function* () {
      const error = yield* projectSessions
        .open({ sessionId: "missing", workingDirectory: "/project" })
        .pipe(Effect.flip);
      assert.equal(error.operation, "open");
      assert.match(error.message, /could not find Project Session missing/);
    }).pipe(Effect.provide(makeLayer(undefined, { sessionExists: false }))),
  );
});
