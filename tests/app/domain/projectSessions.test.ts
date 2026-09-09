import { ProjectSessionLifecycle } from "../../../src/services/project-sessions/ProjectSessionLifecycle";
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stream, SubscriptionRef } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, vi } from "vitest";
import * as projectSessions from "../../../src/domain/projectSessions";
import type { SessionCatalogUpdate } from "../../../src/domain/catalog-data";
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
import type { ProjectSessionLocation } from "../../../src/domain/project-session-data";
import { Electron } from "../../../src/services/electron/Electron";
import { PiModels } from "../../../src/services/pi/PiModels";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  SessionArchiveStorage,
  SessionArchiveStorageError,
} from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import type { SessionSnapshot, SessionSummary } from "../../../src/ipc/session-contract";
import type { WorktreeRecord } from "../../../src/domain/managed-worktree-data";

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
  onHandoff?: (destination?: {
    readonly workingDirectory: string;
    readonly sessionRoot: string;
  }) => void,
  onForkTitle?: (title: string) => void,
  onRename?: (name: string) => void,
  onOperation?: (operation: string) => void,
): CakeRuntime => ({
  sessionId: snapshot.sessionId,
  sessionFile: snapshot.sessionFile,
  streaming: false,
  snapshot: async () => snapshot,
  listQueuedMessages: async () => ({ steering: [], followUp: [] }),
  clearQueue: async () => ({ steering: [], followUp: [] }),
  cancelSteering: async () => ({ steering: [], followUp: [] }),
  prompt: async (_text, delivery) => {
    onOperation?.(delivery);
    await prompt();
    options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: false });
  },
  editMessage: async () => onOperation?.("edit"),
  setUserMessageMarkdown: async () => undefined,
  compact: async () => onOperation?.("compact"),
  abort: async () => onOperation?.("abort"),
  setModel: async () => onOperation?.("model"),
  setThinkingLevel: async () => onOperation?.("thinking"),
  setFastMode: async () => onOperation?.("fast"),
  applyConfiguration: async () => onOperation?.("configuration"),
  setPiSetting: async () => onOperation?.("setting"),
  recordReviewRun: () => undefined,
  login: async () => onOperation?.("login"),
  logout: async () => onOperation?.("logout"),
  rename: async (name) => onRename?.(name),
  fork: async (_entryId, title) => {
    onForkTitle?.(title);
    return { sessionId: "forked", sessionFile: "/sessions/forked.jsonl" };
  },
  handoff: async (_entryId, destination) => {
    onHandoff?.(destination);
    return { sessionId: "handoff", sessionFile: "/sessions/handoff.jsonl" };
  },
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
    onArchive?(sessionId: string): void;
    archiveErrorSessionId?: string;
    onLifecycleResolve?(sessionId: string, resolved: boolean): void;
    onRestore?(): void;
    onCatalog?(): void;
    catalog?(workingDirectory: string): Stream.Stream<SessionSummary, unknown>;
    catalogModifiedAt?(): string;
    catalogTitle?(): string;
    onRename?(name: string): void;
    onResolvedCatalog?(): void;
    onMigrateProject?(): void;
    onLocations?(options?: { readonly includeInactive?: boolean }): void;
    locations?: ReadonlyArray<ProjectSessionLocation>;
    onRuntimeOptions?(newSession: boolean): void;
    prompt?(): Promise<void>;
    onHandoff?(destination?: {
      readonly workingDirectory: string;
      readonly sessionRoot: string;
    }): void;
    onForkTitle?(title: string): void;
    onOperation?(operation: string): void;
    sessionExists?: boolean;
    resolvedOnDisk?: boolean;
    resolvedProjectEntries?: ReadonlyArray<{
      readonly sessionId: string;
      readonly modifiedAt: string;
      readonly title?: string;
    }>;
    migrationComplete?: boolean;
    worktreeRecords?: ReadonlyArray<WorktreeRecord>;
    onCleanupResolved?(): void;
    onRestoreResolved?(): void;
    onCloseWorkingDirectory?(): void;
    family?: {
      readonly familyId: string;
      readonly parentSessionId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly createdAt: string;
      readonly children: ReadonlyArray<{
        readonly sessionId: string;
        readonly requestId: string;
        readonly createdAt: string;
      }>;
    };
  } = {},
) => {
  const resolvedSessionIds = new Set(hooks.resolvedOnDisk ? ["session-1"] : []);
  const configuredInitial =
    initial.projects.length > 0
      ? initial
      : {
          ...initial,
          projects: [
            {
              path: hooks.locations?.[0]?.projectPath ?? "/project",
              name: hooks.locations?.[0]?.projectName ?? "Project",
              addedAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
  const application = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const projection = yield* SubscriptionRef.make({ revision: 0, state: configuredInitial });
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
    catalog: (query) => {
      hooks.onCatalog?.();
      if (hooks.catalog) return hooks.catalog(query.workingDirectory);
      return hooks.sessionExists === false || resolvedSessionIds.has("session-1")
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
      hooks.sessionExists === false || resolvedSessionIds.has("session-1")
        ? Effect.succeed(undefined)
        : Effect.succeed({
            id: "session-1",
            title: hooks.catalogTitle?.() ?? "Active branch",
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
        hooks.onRuntimeOptions?.(options.newSession ?? false);
        return fakeRuntime(
          options,
          hooks.prompt,
          hooks.onHandoff,
          hooks.onForkTitle,
          hooks.onRename,
          hooks.onOperation,
        );
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
  return Layer.mergeAll(
    application,
    SessionCatalogChanges.layer,
    Layer.mock(ProjectSessionLifecycle, {
      setProjectSessionResolved: (sessionId, resolved) =>
        Effect.sync(() => hooks.onLifecycleResolve?.(sessionId, resolved)),
    }),
    Layer.succeed(SessionFamilyStorage, {
      list: () => Effect.succeed(hooks.family ? [hooks.family] : []),
      familyForMember: (sessionId) =>
        Effect.succeed(
          hooks.family &&
            (hooks.family.parentSessionId === sessionId ||
              hooks.family.children.some((child) => child.sessionId === sessionId))
            ? hooks.family
            : undefined,
        ),
      addChild: () => Effect.die("Unexpected family child creation"),
      state: () => Effect.succeed({ families: [], transitions: [], turns: [] }),
      withMemberLock: (_id, effect) => effect,
      beginTransition: () => Effect.void,
      finishTransition: () => Effect.void,
      recordTurn: () => Effect.void,
      settleTurn: () => Effect.void,
      reportTurns: () => Effect.void,
      prepareReply: () => Effect.void,
      markNoticeAttempt: () => Effect.void,
      completeNotice: () => Effect.void,
      removeUnmaterializedChild: () => Effect.void,
    }),
    makePiSessionsLayer(adapter),
    SubagentCoordinatorLive,
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved-sessions",
    }),
    Layer.mock(ProjectAccess, {
      rememberSessionLocation: () => Effect.void,
      isAllowed: () => Effect.succeed(true),
    }),
    Layer.mock(ProjectSessionRuntimeHost, {
      runtimeIntegrations: () =>
        Effect.sync(() => {
          return {
            requestUi: async () => undefined,
            requestApplicationControl: async () => ({ ok: true }),
            emitExtensionUiIntent: () => undefined,
            persistArtifact: async () => {
              throw new Error("Unexpected artifact persistence");
            },
            requestArtifact: async () => undefined,
            generateInlineWidget: async () => {
              throw new Error("Unexpected widget generation");
            },
            listArtifacts: async () => [],
          };
        }),
      releaseSession: () => Effect.void,
    }),
    Layer.mock(PiModels, {}),
    Layer.mock(Electron, {
      openExternal: () => Effect.void,
      sendTo: vi.fn(),
      broadcast: vi.fn(),
      requireRendererConnection: vi.fn(),
      workspaceForConnection: vi.fn(),
      associateWorkspace: vi.fn(),
      forgetWorkspace: vi.fn(),
      windowsForWorkspace: () => [],
      centerTrafficLights: vi.fn(),
    }),
    Layer.mock(VsCodeServer, {
      enterProjectEditor: () => Effect.void,
      openProjectLocation: (_workingDirectory, location) =>
        Effect.succeed({ status: "completed" as const, value: location }),
      runProjectScript: (_workingDirectory, _source, input) =>
        Effect.succeed({ status: "completed" as const, value: input }),
      backToAgentForWindow: () => false,
    }),
    Layer.mock(SubagentEnvironment, {
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory,
          agentDirectory: "/agent",
          sessionDirectory: "/subagents",
          trusted: true,
        }),
    }),
    Layer.succeed(
      SessionArchiveStorage,
      SessionArchiveStorage.of({
        resolve: () => Effect.succeed(false),
        restore: () => Effect.succeed(false),
        deleteResolved: () => Effect.void,
        delete: () => Effect.void,
        locate: (sessionId) =>
          Effect.succeed(
            hooks.sessionExists === false
              ? undefined
              : resolvedSessionIds.has(sessionId)
                ? "resolved"
                : "active",
          ),
        resolved: () => {
          hooks.onResolvedCatalog?.();
          return hooks.sessionExists === false || resolvedSessionIds.size === 0
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
        resolvedEntry: (sessionId) => {
          const entry = hooks.resolvedProjectEntries?.find(
            (candidate) => candidate.sessionId === sessionId,
          );
          const resolved =
            resolvedSessionIds.has(sessionId) ||
            hooks.resolvedProjectEntries?.some((candidate) => candidate.sessionId === sessionId);
          return hooks.sessionExists === false || !resolved
            ? Effect.succeed(undefined)
            : Effect.succeed({
                id: sessionId,
                title: entry?.title ?? sessionId,
                created: "2026-01-01T00:00:00.000Z",
                modified: entry?.modifiedAt ?? "2026-01-02T00:00:00.000Z",
                messageCount: 0,
                resolved: true,
              });
        },
        resolveProject: (sessionId) =>
          hooks.archiveErrorSessionId === sessionId
            ? Effect.fail(
                new SessionArchiveStorageError({
                  operation: "resolveProject",
                  sessionId,
                  message: `Cannot archive ${sessionId}`,
                }),
              )
            : Effect.sync(() => {
                resolvedSessionIds.add(sessionId);
                hooks.onArchive?.(sessionId);
                return true;
              }),
        restoreProject: (sessionId) =>
          Effect.sync(() => {
            resolvedSessionIds.delete(sessionId);
            hooks.onRestore?.();
            return undefined;
          }),
        deleteResolvedProject: () => Effect.void,
        resolvedProjects: (projectPath) => {
          hooks.onResolvedCatalog?.();
          const entries = hooks.resolvedProjectEntries ?? [
            { sessionId: "session-1", modifiedAt: "2026-01-02T00:00:00.000Z" },
          ];
          return hooks.sessionExists === false || resolvedSessionIds.size === 0
            ? Stream.empty
            : Stream.fromIterable(
                entries.map((entry) => ({
                  version: 1 as const,
                  sessionId: entry.sessionId,
                  projectPath,
                  projectName: "Project",
                  workingDirectory: "/project",
                  activeRoot: "/sessions",
                  resolvedRoot: "/resolved-sessions",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  modifiedAt: entry.modifiedAt,
                })),
              );
        },
        projectMigrationComplete: () => Effect.succeed(hooks.migrationComplete ?? true),
        migrateProject: (projectPath) => {
          hooks.onMigrateProject?.();
          return hooks.sessionExists === false || resolvedSessionIds.size === 0
            ? Stream.empty
            : Stream.make({
                version: 1 as const,
                sessionId: "session-1",
                projectPath,
                projectName: "Project",
                workingDirectory: "/project",
                activeRoot: "/sessions",
                resolvedRoot: "/resolved-sessions",
                createdAt: "2026-01-01T00:00:00.000Z",
                modifiedAt: "2026-01-02T00:00:00.000Z",
              });
        },
        resolvedProjectEntry: (sessionId) =>
          hooks.sessionExists === false || !resolvedSessionIds.has(sessionId)
            ? Effect.succeed(undefined)
            : Effect.succeed({
                version: 1 as const,
                sessionId: "session-1",
                projectPath: hooks.locations?.[0]?.projectPath ?? "/project",
                projectName: hooks.locations?.[0]?.projectName ?? "Project",
                workingDirectory: hooks.locations?.[0]?.workingDirectory ?? "/project",
                activeRoot: "/sessions",
                resolvedRoot: "/resolved-sessions",
                createdAt: "2026-01-01T00:00:00.000Z",
                modifiedAt: "2026-01-02T00:00:00.000Z",
              }),
      }),
    ),
    Layer.mock(ManagedWorktrees, {
      records: () => {
        hooks.onLocations?.();
        return Effect.succeed(
          hooks.worktreeRecords ??
            hooks.locations
              ?.filter((location) => location.workingDirectory !== location.projectPath)
              .map((location) => ({
                projectPath: location.projectPath,
                worktreePath: location.workingDirectory,
                branch:
                  location.managedWorktree?.branch ?? `agent/${location.worktreeName ?? "test"}`,
                baseBranch: location.managedWorktree?.baseBranch ?? "main",
                state: location.managedWorktree?.state ?? ("active" as const),
                createdAt: location.managedWorktree?.createdAt ?? "2026-01-01T00:00:00.000Z",
              })) ??
            [],
        );
      },
      cleanupResolved: () =>
        Effect.sync(() => {
          hooks.onCleanupResolved?.();
        }),
      restoreResolved: () =>
        Effect.sync(() => {
          hooks.onRestoreResolved?.();
          return undefined;
        }),
    }),
    Layer.succeed(
      Terminal,
      Terminal.of({
        open: () => Effect.die("Unexpected terminal open"),
        write: () => Effect.die("Unexpected terminal write"),
        resize: () => Effect.die("Unexpected terminal resize"),
        runningProgramCount: () => Effect.die("Unexpected terminal status"),
        close: () => Effect.die("Unexpected terminal close"),
        closeWorkingDirectory: () =>
          Effect.sync(() => {
            hooks.onCloseWorkingDirectory?.();
          }),
        closeOwner: () => Effect.void,
        events: () => Stream.empty,
      }),
    ),
  );
};

describe("Project Sessions domain", () => {
  it.effect("moves active sessions through authoritative custom workflow policy", () =>
    Effect.gen(function* () {
      const workflow = yield* projectSessions.moveWorkflowSession({
        projectPath: "/project",
        sessionId: "session-1",
        workingDirectory: "/project",
        destination: {
          _tag: "Custom",
          statusId: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
        },
      });
      assert.deepEqual(workflow.assignments, [
        {
          sessionId: "session-1",
          statusId: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
        },
      ]);
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
              workflow: {
                columns: [
                  {
                    id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
                    name: "Review",
                    color: "violet",
                  },
                ],
                assignments: [],
                sessionDetails: [],
              },
            },
          ],
        }),
      ),
    ),
  );

  it.effect("restores a resolved session before assigning its custom status", () => {
    let restores = 0;
    return Effect.gen(function* () {
      const workflow = yield* projectSessions.moveWorkflowSession({
        projectPath: "/project",
        sessionId: "session-1",
        workingDirectory: "/project",
        destination: {
          _tag: "Custom",
          statusId: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
        },
      });
      assert.equal(restores, 1);
      assert.equal(workflow.assignments[0]?.statusId, "b925b5dd-9661-4f1a-9f40-406be3c96c27");
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
                workflow: {
                  columns: [
                    {
                      id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
                      name: "Review",
                      color: "violet",
                    },
                  ],
                  assignments: [],
                  sessionDetails: [],
                },
              },
            ],
          },
          { resolvedOnDisk: true, onRestore: () => restores++ },
        ),
      ),
    );
  });

  it.effect("rejects Draft resolution and missing custom statuses through the domain", () =>
    Effect.gen(function* () {
      const missingStatus = yield* Effect.flip(
        projectSessions.moveWorkflowSession({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          destination: {
            _tag: "Custom",
            statusId: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
          },
        }),
      );
      assert.equal(missingStatus.message, "That custom status no longer exists");
      const draftResolution = yield* Effect.flip(
        projectSessions.moveWorkflowSession({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          destination: { _tag: "Resolved" },
        }),
      );
      assert.equal(draftResolution.message, "Activate a Draft before resolving it");
      const directResolution = yield* Effect.flip(
        projectSessions.resolve({ sessionId: "session-1", workingDirectory: "/project" }),
      );
      assert.equal(directResolution.message, "Activate a Draft before resolving it");
    }).pipe(Effect.provide(makeLayer(undefined, { sessionExists: false }))),
  );

  it.effect("rejects independent Session Family child lifecycle transitions", () => {
    const family = {
      familyId: "family-1",
      parentSessionId: "parent-1",
      projectPath: "/project",
      workingDirectory: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
      children: [
        {
          sessionId: "session-1",
          requestId: "request-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    return Effect.gen(function* () {
      const resolveError = yield* Effect.flip(
        projectSessions.moveWorkflowSession({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          destination: { _tag: "Resolved" },
        }),
      );
      assert.equal(
        resolveError.message,
        "Resolve or restore this Session Family from its parent card",
      );
      const restoreError = yield* Effect.flip(
        projectSessions.moveWorkflowSession({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          destination: { _tag: "Active" },
        }),
      );
      assert.equal(
        restoreError.message,
        "Resolve or restore this Session Family from its parent card",
      );
      const directResolve = yield* Effect.flip(
        projectSessions.resolve({ sessionId: "session-1", workingDirectory: "/project" }),
      );
      assert.equal(directResolve.message, "Only the Session Family parent can resolve the family");
      const directRestore = yield* Effect.flip(
        projectSessions.restore({ sessionId: "session-1", workingDirectory: "/project" }),
      );
      assert.equal(directRestore.message, "Only the Session Family parent can restore the family");
    }).pipe(Effect.provide(makeLayer(undefined, { family, resolvedOnDisk: true })));
  });

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

  it.effect("bounds existing archive titles before catalog serialization", () => {
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: true,
      });
      const first = yield* updates.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(first[0]?._tag, "Snapshot");
      if (first[0]?._tag !== "Snapshot") return;
      assert.equal(first[0].sessions.length, 2);
      assert.equal(
        first[0].sessions.find((item) => item.sessionId === "long")?.title,
        "x".repeat(144),
      );
      assert.equal(first[0].sessions.find((item) => item.sessionId === "normal")?.title, "Normal");
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          resolvedOnDisk: true,
          resolvedProjectEntries: [
            { sessionId: "long", title: "x".repeat(500), modifiedAt: "2026-01-02" },
            { sessionId: "normal", title: "Normal", modifiedAt: "2026-01-01" },
          ],
        }),
      ),
    );
  });

  it.effect("loads every resolved metadata record in one stable snapshot", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `session-${index}`,
      modifiedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: true,
      });
      const first = yield* updates.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(first.length, 1);
      assert.equal(first[0]?._tag, "Snapshot");
      if (first[0]?._tag !== "Snapshot") return;
      assert.equal(first[0].sessions.length, 12);
      assert.equal(first[0].sessions[0]?.sessionId, "session-11");
      assert.equal(first[0].sessions[11]?.sessionId, "session-0");
      assert.equal(first[0].hasMore, undefined);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, { resolvedOnDisk: true, resolvedProjectEntries: entries }),
      ),
    );
  });

  it.effect("migrates legacy resolved metadata when its project catalog initializes", () => {
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

  it.effect("publishes project-root and worktree metadata in one initial update", () =>
    Effect.gen(function* () {
      const releaseWorktree = yield* Deferred.make<void>();
      const rootScanned = yield* Deferred.make<void>();
      const session = (id: string): SessionSummary => ({
        id,
        title: id,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 0,
        resolved: false,
      });
      const locations: ReadonlyArray<ProjectSessionLocation> = [
        {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
        },
        {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/worktree",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
        },
      ];
      const layer = makeLayer(undefined, {
        locations,
        catalog: (workingDirectory) =>
          workingDirectory === "/project"
            ? Stream.make(session("root-session")).pipe(
                Stream.ensuring(Deferred.succeed(rootScanned, undefined)),
              )
            : Stream.fromEffect(
                Deferred.await(releaseWorktree).pipe(Effect.as(session("worktree-session"))),
              ),
      });

      yield* Effect.gen(function* () {
        const updates = yield* projectSessions.observeCatalog({
          projectPath: "/project",
          resolved: false,
        });
        const published = yield* Queue.unbounded<SessionCatalogUpdate>();
        const firstUpdate = yield* updates.pipe(
          Stream.take(1),
          Stream.runForEach((update) => Queue.offer(published, update)),
          Effect.forkChild,
        );

        yield* Deferred.await(rootScanned);
        yield* TestClock.adjust("16 millis");
        assert.equal(yield* Queue.size(published), 0);

        yield* Deferred.succeed(releaseWorktree, undefined);
        yield* Fiber.join(firstUpdate);
        const observed = yield* Queue.take(published);
        assert.deepEqual(
          observed._tag === "Snapshot"
            ? observed.sessions.map(({ sessionId, workingDirectory }) => ({
                sessionId,
                workingDirectory,
              }))
            : [],
          [
            { sessionId: "root-session", workingDirectory: "/project" },
            { sessionId: "worktree-session", workingDirectory: "/worktree" },
          ],
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes the complete active catalog in one initial snapshot", () => {
    const sessions = Array.from({ length: 150 }, (_, index): SessionSummary => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 0,
      resolved: false,
    }));
    return Effect.gen(function* () {
      const updates = yield* projectSessions.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const observed = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
      assert.equal(observed[0]?._tag, "Snapshot");
      if (observed[0]?._tag !== "Snapshot") return;
      assert.equal(observed[0].sessions.length, sessions.length);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          catalog: () => Stream.fromIterable(sessions),
        }),
      ),
    );
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

  it.effect("handoffs into another Working Directory", () => {
    let handoffDestination:
      | { readonly workingDirectory: string; readonly sessionRoot: string }
      | undefined;
    return Effect.gen(function* () {
      const result = yield* projectSessions.handoff({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
        destinationWorkingDirectory: "/project-worktree",
      });

      assert.equal(result.sessionId, "handoff");
      assert.deepEqual(handoffDestination, {
        workingDirectory: "/project-worktree",
        sessionRoot: "/sessions",
      });
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          locations: [
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/project",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
            },
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/project-worktree",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
            },
          ],
          onHandoff: (destination) => {
            handoffDestination = destination;
          },
        }),
      ),
    );
  });

  it.effect("gives forks the next numbered copy title", () => {
    let forkTitle: string | undefined;
    const catalogEntry = (id: string, title: string): SessionSummary => ({
      id,
      title,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 2,
      resolved: false,
    });

    return Effect.gen(function* () {
      yield* projectSessions.fork({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
      });

      assert.equal(forkTitle, "Active branch (3)");
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          catalog: () =>
            Stream.fromIterable([
              catalogEntry("session-1", "Active branch"),
              catalogEntry("fork-1", "Active branch (1)"),
              catalogEntry("fork-2", "Active branch (2)"),
            ]),
          onForkTitle: (title) => {
            forkTitle = title;
          },
        }),
      ),
    );
  });

  it.effect(
    "forks a resolved session into an active copy while keeping its source resolved",
    () => {
      let runtimeConstructions = 0;
      let restores = 0;
      let archives = 0;
      return Effect.gen(function* () {
        const target = { sessionId: "session-1", workingDirectory: "/project" };
        const result = yield* projectSessions.fork({
          target,
          entryId: "assistant-entry",
        });
        const source = yield* projectSessions.inspect(target);

        assert.equal(result.sessionId, "forked");
        assert.equal(source.resolved, true);
        assert.equal(runtimeConstructions, 1);
        assert.equal(restores, 1);
        assert.equal(archives, 1);
      }).pipe(
        Effect.provide(
          makeLayer(defaultApplicationState(), {
            resolvedOnDisk: true,
            onCreateRuntime: () => runtimeConstructions++,
            onRestore: () => restores++,
            onArchive: () => archives++,
          }),
        ),
      );
    },
  );

  it.effect(
    "handoffs a resolved session into an active copy while keeping its source resolved",
    () => {
      let runtimeConstructions = 0;
      let restores = 0;
      let archives = 0;
      return Effect.gen(function* () {
        const target = { sessionId: "session-1", workingDirectory: "/project" };
        const result = yield* projectSessions.handoff({
          target,
          entryId: "assistant-entry",
        });
        const source = yield* projectSessions.inspect(target);

        assert.equal(result.sessionId, "handoff");
        assert.equal(source.resolved, true);
        assert.equal(runtimeConstructions, 1);
        assert.equal(restores, 1);
        assert.equal(archives, 1);
      }).pipe(
        Effect.provide(
          makeLayer(defaultApplicationState(), {
            resolvedOnDisk: true,
            onCreateRuntime: () => runtimeConstructions++,
            onRestore: () => restores++,
            onArchive: () => archives++,
          }),
        ),
      );
    },
  );

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

  it.effect(
    "resolves only the sessions authoritatively discovered in one Working Directory",
    () => {
      const archived: string[] = [];
      const session = (id: string): SessionSummary => ({
        id,
        title: id,
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-02T00:00:00.000Z",
        messageCount: 1,
        resolved: false,
      });
      return Effect.gen(function* () {
        const result = yield* projectSessions.resolveWorkingDirectory("/worktree");
        assert.equal(result.projectPath, "/project");
        assert.deepEqual(result.resolvedSessionIds, ["worktree-1", "worktree-2"]);
        assert.deepEqual(result.failures, []);
        assert.deepEqual(archived, ["worktree-1", "worktree-2"]);
      }).pipe(
        Effect.provide(
          makeLayer(defaultApplicationState(), {
            locations: [
              {
                projectPath: "/project",
                projectName: "Project",
                workingDirectory: "/worktree",
                sessionDirectory: "/worktree-sessions",
                resolvedSessionDirectory: "/resolved-sessions",
              },
              {
                projectPath: "/other",
                projectName: "Other",
                workingDirectory: "/other",
                sessionDirectory: "/other-sessions",
                resolvedSessionDirectory: "/resolved-sessions",
              },
            ],
            catalog: (workingDirectory) =>
              workingDirectory === "/worktree"
                ? Stream.fromIterable([session("worktree-1"), session("worktree-2")])
                : Stream.make(session("other-1")),
            onArchive: (sessionId) => archived.push(sessionId),
          }),
        ),
      );
    },
  );

  it.effect("resolves a Session Family once through its parent", () => {
    const lifecycleCalls: Array<[string, boolean]> = [];
    const family = {
      familyId: "family-1",
      parentSessionId: "parent",
      projectPath: "/project",
      workingDirectory: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
      children: [
        {
          sessionId: "child",
          requestId: "request-1",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    const session = (id: string): SessionSummary => ({
      id,
      title: id,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 1,
      resolved: false,
    });
    return Effect.gen(function* () {
      const result = yield* projectSessions.resolveWorkingDirectory("/project");
      assert.deepEqual(result.resolvedSessionIds, ["parent", "child"]);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(lifecycleCalls, [["parent", true]]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family,
          catalog: () => Stream.fromIterable([session("parent"), session("child")]),
          onLifecycleResolve: (sessionId, resolved) => lifecycleCalls.push([sessionId, resolved]),
        }),
      ),
    );
  });

  it.effect("reports partial Working Directory resolution failures and continues", () => {
    const archived: string[] = [];
    const session = (id: string): SessionSummary => ({
      id,
      title: id,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 1,
      resolved: false,
    });
    return Effect.gen(function* () {
      const result = yield* projectSessions.resolveWorkingDirectory("/project");
      assert.deepEqual(result.resolvedSessionIds, ["session-1"]);
      assert.deepEqual(result.failures, [
        { sessionIds: ["session-2"], message: "Cannot archive session-2" },
      ]);
      assert.deepEqual(archived, ["session-1"]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          catalog: () => Stream.fromIterable([session("session-1"), session("session-2")]),
          archiveErrorSessionId: "session-2",
          onArchive: (sessionId) => archived.push(sessionId),
        }),
      ),
    );
  });

  it.effect("retires a landed Managed Worktree after its final session is resolved", () => {
    let cleanups = 0;
    let terminalClosures = 0;
    const worktree: WorktreeRecord = {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/finished",
      baseBranch: "main",
      state: "landed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    return Effect.gen(function* () {
      yield* projectSessions.resolve({
        sessionId: "session-1",
        workingDirectory: worktree.worktreePath,
      });
      assert.equal(cleanups, 1);
      assert.equal(terminalClosures, 1);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          locations: [
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: worktree.worktreePath,
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
              managedWorktree: worktree,
            },
          ],
          worktreeRecords: [worktree],
          onCleanupResolved: () => cleanups++,
          onCloseWorkingDirectory: () => terminalClosures++,
        }),
      ),
    );
  });

  it.effect("keeps a landed Managed Worktree while another session remains active", () => {
    let cleanups = 0;
    const worktree: WorktreeRecord = {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/shared",
      baseBranch: "main",
      state: "landed",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    return Effect.gen(function* () {
      yield* projectSessions.resolve({
        sessionId: "session-1",
        workingDirectory: worktree.worktreePath,
      });
      assert.equal(cleanups, 0);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          locations: [
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: worktree.worktreePath,
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
              managedWorktree: worktree,
            },
          ],
          catalog: () =>
            Stream.make({
              id: "session-2",
              title: "Still active",
              created: "2026-01-01T00:00:00.000Z",
              modified: "2026-01-02T00:00:00.000Z",
              messageCount: 1,
              resolved: false,
            }),
          worktreeRecords: [worktree],
          onCleanupResolved: () => cleanups++,
        }),
      ),
    );
  });

  it.effect("recreates a resolved Managed Worktree before restoring its session", () => {
    const events: string[] = [];
    const worktree: WorktreeRecord = {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/finished",
      baseBranch: "main",
      state: "resolved",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    return Effect.gen(function* () {
      yield* projectSessions.restore({
        sessionId: "session-1",
        workingDirectory: worktree.worktreePath,
      });
      assert.deepEqual(events, ["worktree", "session"]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          resolvedOnDisk: true,
          locations: [
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: worktree.worktreePath,
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
              managedWorktree: worktree,
            },
          ],
          worktreeRecords: [worktree],
          onRestoreResolved: () => events.push("worktree"),
          onRestore: () => events.push("session"),
        }),
      ),
    );
  });

  it.effect("resolves a session from an inactive Managed Worktree location", () => {
    let archives = 0;
    return Effect.gen(function* () {
      yield* projectSessions.resolve({
        sessionId: "session-1",
        workingDirectory: "/discarded-worktree",
      });
      assert.equal(archives, 1);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          locations: [
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/discarded-worktree",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
              managedWorktree: {
                projectPath: "/project",
                worktreePath: "/discarded-worktree",
                branch: "agent/discarded",
                baseBranch: "main",
                state: "discarded",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
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

  it.effect(
    "routes matching conversation controls through one acquired Project Session runtime",
    () => {
      const operations: string[] = [];
      let runtimeConstructions = 0;
      const target = { sessionId: "session-1" };
      return Effect.gen(function* () {
        yield* projectSessions.compact(target, "Keep the architecture notes");
        yield* projectSessions.editMessage({
          ...target,
          entryId: "user-message",
          text: "Updated",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        });
        yield* projectSessions.applyConfiguration(target, {
          provider: "fixture-provider",
          modelId: "fixture-model",
          thinkingLevel: "medium",
          fastMode: false,
        });
        yield* projectSessions.setModel(target, "fixture-provider", "fixture-model");
        yield* projectSessions.setThinkingLevel(target, "high");
        yield* projectSessions.setFastMode(target, true);
        yield* projectSessions.setPiSetting(target, { key: "retryEnabled", value: false });
        yield* projectSessions.login(target, "fixture-provider", "api_key");
        yield* projectSessions.logout(target, "fixture-provider");
        yield* projectSessions.abort(target);

        assert.equal(runtimeConstructions, 1);
        assert.deepEqual(operations, [
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
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            onCreateRuntime: () => runtimeConstructions++,
            onOperation: (operation) => operations.push(operation),
          }),
        ),
      );
    },
  );

  it.effect("publishes an authoritative catalog update when a new session starts", () =>
    Effect.gen(function* () {
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

      yield* projectSessions.start({
        sessionId: "session-1",
        workingDirectory: "/project",
        text: "First message",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });

      const observed = Array.from(yield* Fiber.join(fiber));
      assert.equal(observed[1]?._tag, "Event");
      assert.equal(observed[1]?._tag === "Event" ? observed[1].event._tag : undefined, "Upserted");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("publishes a renamed title before the active turn settles", () => {
    let title = "Active branch";
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

      yield* projectSessions.rename({ sessionId: "session-1" }, "Renamed while running");

      const observed = Array.from(yield* Fiber.join(fiber));
      const renamed = observed[1];
      assert.equal(renamed?._tag, "Event");
      assert.equal(
        renamed?._tag === "Event" && renamed.event._tag === "Upserted"
          ? renamed.event.session.title
          : undefined,
        "Renamed while running",
      );
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          catalogTitle: () => title,
          onRename: (name) => {
            title = name;
          },
        }),
      ),
    );
  });

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
