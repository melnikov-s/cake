import {
  makeSubagentStorageTestLayer,
  subagentHistoryFixture,
} from "../helpers/subagentStorageFixture";
import { makeRuntimeRecoveryStorageTestLayer } from "../helpers/piRuntimeFixture";
import assert from "node:assert/strict";
import { toJsonValue } from "../../../src/utils/to-json-value";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { coordinationStorageHarness } from "../helpers/coordinationStorageHarness";
import { RuntimeRecoveryStorage } from "../../../src/services/storage/RuntimeRecoveryStorage";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { FileSystem, Path } from "effect";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import {
  cakeWorkspaceSessionDirectory,
  streamWorkspaceSessions,
} from "../../../src/services/pi/runtime/session-discovery";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema, Stream, SubscriptionRef } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, vi } from "vitest";
import * as projectSessionMetadata from "../../../src/domain/project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../../../src/domain/project-sessions/projectSessionOperations";
import * as projectSessionContinuations from "../../../src/domain/project-sessions/projectSessionContinuations";
import * as projectSessionUserLifecycle from "../../../src/domain/project-sessions/projectSessionUserLifecycle";
import { projectSessionHandlers } from "../../../src/ipc/server/ProjectSessionHandlers";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import * as projectTodoResolution from "../../../src/domain/projects/projectTodoResolution";
import * as projectTodoAssociations from "../../../src/domain/projects/projectTodoAssociations";
import * as projectSessionLifecycle from "../../../src/domain/project-sessions/projectSessionLifecycle";
import { ProjectTodoReports } from "../../../src/services/projects/ProjectTodoReports";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { TurnCanceledError } from "../../../src/services/pi/runtime/RuntimeTurnCompletion";
import { createCakeSessionRuntimeContinuations } from "../../../src/services/pi/runtime/cake-session-runtime-continuations";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ResolutionRejected,
  ResolutionCleanupFailed,
} from "../../../src/contracts/project-sessions/project-session-resolution";
import * as projectSessionLocations from "../../../src/domain/project-sessions/projectSessionLocations";
import { SessionCatalog } from "../../../src/renderer/models/SessionCatalog";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import type { SessionCatalogUpdate } from "../../../src/contracts/application/catalog-data";
import {
  ArtifactDigest,
  type ArtifactLink,
  type ArtifactLinkTarget,
} from "../../../src/contracts/artifacts/artifact-lineage";
import type { ArtifactPointer } from "../../../src/contracts/artifacts/artifact-contract";
import { getState } from "../../../src/domain/application/application";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/contracts/application/application-data";
import {
  makeCakeSessionRuntimesLayer,
  CakeSessionRuntimes,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-session-runtime";
import type {
  ProjectSessionLocation,
  ProjectSessionSummary,
} from "../../../src/contracts/project-sessions/project-session-data";
import { Electron } from "../../../src/services/electron/Electron";
import { PiModels } from "../../../src/services/pi/PiModels";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { sessionDirectoryPath } from "../../../src/services/storage/session-files";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ArtifactGarbageCollector } from "../../../src/services/artifacts/ArtifactGarbageCollector";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ArtifactStorageError } from "../../../src/contracts/storage/artifact-storage-errors";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import {
  SessionArchiveStorage,
  SessionArchiveStorageError,
} from "../../../src/services/storage/SessionArchiveStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionFamilyStorageError } from "../../../src/contracts/storage/session-family-storage-errors";
import {
  SubagentCoordinatorLive,
  SubagentCoordinator,
} from "../../../src/services/subagents/SubagentCoordinator";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ManagedWorktreeError } from "../../../src/contracts/worktrees/managed-worktrees-errors";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../../src/services/session-catalogs/SessionCatalogChanges";
import type {
  ConversationSnapshot,
  PiSessionSummary,
} from "../../../src/contracts/conversations/session-contract";
import type { ConversationUpdate } from "../../../src/contracts/conversations/conversation-data";
import { SubagentHandleId as subagentsHandleId } from "../../../src/contracts/subagents/subagent-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";

const snapshot: ConversationSnapshot = {
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
    {
      id: "compacted-tool",
      kind: "tool",
      name: "read",
      input: "README.md",
      output: "historical result",
      state: "success",
      origin: "compacted",
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
  options: CakeSessionRuntimeOptions,
  prompt: () => Promise<void> = async () => undefined,
  onToolCompact?: () => void,
  onForkTitle?: (title: string) => void,
  onRename?: (name: string) => void,
  onOperation?: (operation: string) => void,
  forkArtifactPointers: ReadonlyArray<ArtifactPointer> = [],
  onDispose?: () => void,
): CakeSessionRuntime => ({
  sessionId: options.sessionId ?? snapshot.sessionId,
  sessionFile: `/sessions/${options.sessionId ?? snapshot.sessionId}.jsonl`,
  streaming: false,
  snapshot: async () => ({
    ...snapshot,
    workspacePath: options.cwd,
    sessionId: options.sessionId ?? snapshot.sessionId,
    sessionFile: `/sessions/${options.sessionId ?? snapshot.sessionId}.jsonl`,
  }),
  listQueuedMessages: async () => {
    onOperation?.("list-queue");
    return { steering: [], followUp: [] };
  },
  pendingMessages: async () => ({ items: [] }),
  reorderPendingMessage: async () => ({ items: [] }),
  clearQueue: async () => {
    onOperation?.("clear-queue");
    return { steering: [], followUp: [] };
  },
  cancelSteering: async () => {
    onOperation?.("cancel-steering");
    return { steering: [], followUp: [] };
  },
  removeQueuedMessage: async () => {
    onOperation?.("remove-queued");
    return { steering: [], followUp: [] };
  },
  steerQueuedMessage: async () => {
    onOperation?.("steer-queued");
    return { steering: [], followUp: [] };
  },
  sendQueuedMessageNow: async () => ({
    queued: { steering: [], followUp: [] },
    abortedTurnIds: [],
  }),
  prompt: async (_text, delivery) => {
    onOperation?.(delivery);
    options.onInitialTranscriptPersisted?.();
    await prompt();
    options.onEvent({ type: "streaming", sessionId: snapshot.sessionId, streaming: false });
  },
  editMessage: async () => onOperation?.("edit"),
  setUserMessageMarkdown: async () => undefined,
  queueCommand: async () => {
    throw new Error("Unexpected queueCommand");
  },
  inspectSession: async () => {
    throw new Error("Unexpected inspectSession");
  },
  compact: async () => onOperation?.("compact"),
  abort: async () => onOperation?.("abort"),
  setModel: async () => onOperation?.("model"),
  setThinkingLevel: async () => onOperation?.("thinking"),
  setFastMode: async () => onOperation?.("fast"),
  applyConfiguration: async () => onOperation?.("configuration"),
  setPiSetting: async () => onOperation?.("setting"),
  recordReviewRun: () => undefined,
  rename: async (name) => onRename?.(name),
  fork: async (_entryId, title) => {
    onForkTitle?.(title);
    return {
      sessionId: "forked",
      sessionFile: "/sessions/forked.jsonl",
      artifactPointers: forkArtifactPointers,
    };
  },
  toolCompact: async () => {
    onToolCompact?.();
    return { sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile };
  },
  navigate: async () => undefined,
  dispose: () => onDispose?.(),
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
    onDeleteArchive?(sessionId: string): void;
    archiveDeleteErrorSessionId?: string;
    onRestore?(sessionId: string): void;
    onCatalog?(workingDirectory: string): void;
    onSessionIds?(): void;
    onCatalogChange?(change: SessionCatalogChange): void;
    sessionIds?(workingDirectory: string): Stream.Stream<string, unknown>;
    catalog?(
      workingDirectory: string,
      excludedSessionIds?: ReadonlyArray<string>,
    ): Stream.Stream<PiSessionSummary, unknown>;
    catalogEntry?: CakeSessionRuntimesAdapter["catalogEntry"];
    locate?: SessionArchiveStorage["Service"]["locate"];
    resolvedCatalog?(
      workingDirectory: string,
    ): Stream.Stream<PiSessionSummary, SessionArchiveStorageError>;
    catalogModifiedAt?(): string;
    catalogTitle?(): string;
    onRename?(name: string): void;
    onResolvedCatalog?(workingDirectory: string): void;
    onMigrateProject?(): void;
    onLocations?(options?: { readonly includeInactive?: boolean }): void;
    locations?: ReadonlyArray<ProjectSessionLocation>;
    onRuntimeOptions?(newSession: boolean): void;
    runtime?(options: CakeSessionRuntimeOptions): CakeSessionRuntime;
    createRuntime?: CakeSessionRuntimesAdapter["createRuntime"];
    prompt?(): Promise<void>;
    onToolCompact?(): void;
    onForkTitle?(title: string): void;
    forkArtifactPointers?: ReadonlyArray<ArtifactPointer>;
    onInheritFork?(
      sourceWorkingDirectory: string,
      sourceSessionId: string,
      destinationWorkingDirectory: string,
      destinationSessionId: string,
      pointers: ReadonlyArray<ArtifactPointer>,
    ): void;
    onArtifactLink?(link: ArtifactLink): void;
    onOperation?(operation: string): void;
    onInspect?(): void;
    onDispose?(): void;
    sessionExists?: boolean;
    resolvedOnDisk?: boolean;
    resolvedProjectEntries?: ReadonlyArray<{
      readonly sessionId: string;
      readonly modifiedAt: string;
      readonly title?: string;
    }>;
    migrationComplete?: boolean;
    worktreeRecords?: ReadonlyArray<WorktreeRecord>;
    deferredWorktreeSetup?: Effect.Effect<void, ManagedWorktreeError>;
    onCleanupResolved?(): void;
    cleanupFailure?: boolean;
    onRestoreResolved?(): void;
    onCloseWorkingDirectory?(): void;
    onRemoveFamilyProject?(projectPath: string): void;
    familyRemovalError?: boolean;
    onRemoveArtifactTarget?(target: ArtifactLinkTarget): void;
    artifactRemovalFails?(target: ArtifactLinkTarget): boolean;
    onArtifactGarbageCollection?(): void;
    initialResolvedSessionIds?: ReadonlyArray<string>;
    family?: {
      readonly familyId: string;
      readonly parentSessionId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly createdAt: string;
      readonly children: ReadonlyArray<{
        readonly sessionId: string;
        readonly parentSessionId?: string;
        readonly requestId: string;
        readonly workingDirectory?: string;
        readonly managedWorktreePath?: string;
        readonly createdAt: string;
      }>;
    };
  } = {},
) => {
  const resolvedSessionIds = new Set([
    ...(hooks.resolvedOnDisk ? ["session-1"] : []),
    ...(hooks.initialResolvedSessionIds ?? []),
  ]);
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
  const family = hooks.family
    ? {
        ...hooks.family,
        children: hooks.family.children.map((child) => ({
          ...child,
          parentSessionId: child.parentSessionId ?? hooks.family?.parentSessionId ?? "",
          workingDirectory: child.workingDirectory ?? hooks.family?.workingDirectory ?? "",
        })),
      }
    : undefined;
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
  const adapter: CakeSessionRuntimesAdapter = {
    sessionIds: (query) => {
      hooks.onSessionIds?.();
      if (hooks.sessionIds)
        return hooks
          .sessionIds(query.workingDirectory)
          .pipe(Stream.filter((id) => !query.excludedSessionIds?.includes(id)));
      if (hooks.catalog)
        return hooks.catalog(query.workingDirectory).pipe(
          Stream.map((item) => item.id),
          Stream.filter((id) => !query.excludedSessionIds?.includes(id)),
        );
      return hooks.sessionExists === false || query.excludedSessionIds?.includes("session-1")
        ? Stream.empty
        : Stream.make("session-1");
    },
    catalog: (query) => {
      hooks.onCatalog?.(query.workingDirectory);
      if (hooks.catalog)
        return hooks
          .catalog(query.workingDirectory, query.excludedSessionIds)
          .pipe(Stream.filter((item) => !query.excludedSessionIds?.includes(item.id)));
      return hooks.sessionExists === false || query.excludedSessionIds?.includes("session-1")
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
    catalogEntry: (query, sessionId) =>
      hooks.catalogEntry
        ? hooks.catalogEntry(query, sessionId)
        : hooks.sessionExists === false
          ? Effect.succeed(undefined)
          : Effect.succeed({
              id: sessionId,
              title: hooks.catalogTitle?.() ?? "Active branch",
              created: "2026-01-01T00:00:00.000Z",
              modified: hooks.catalogModifiedAt?.() ?? "2026-01-02T00:00:00.000Z",
              messageCount: 2,
              resolved: false,
            }),
    inspect: (target) =>
      Effect.sync(() => {
        hooks.onInspect?.();
        return {
          workspacePath: target.workingDirectory,
          sessionId: target.sessionId,
          sessionFile: `/sessions/${target.sessionId}.jsonl`,
          parts: snapshot.parts,
        };
      }),
    createRuntime: (options) =>
      hooks.createRuntime?.(options) ??
      Effect.sync(() => {
        hooks.onCreateRuntime?.();
        hooks.onRuntimeOptions?.(options.newSession ?? false);
        if (hooks.runtime) return hooks.runtime(options);
        return fakeRuntime(
          options,
          hooks.prompt,
          hooks.onToolCompact,
          hooks.onForkTitle,
          hooks.onRename,
          hooks.onOperation,
          hooks.forkArtifactPointers,
          hooks.onDispose,
        );
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
  const catalogChanges = hooks.onCatalogChange
    ? Layer.succeed(
        SessionCatalogChanges,
        SessionCatalogChanges.of({
          publish: (change) => Effect.sync(() => hooks.onCatalogChange?.(change)),
          initialThenChanges: (initial) => initial,
        }),
      )
    : SessionCatalogChanges.layer;
  return Layer.mergeAll(
    Layer.mock(TaskInputStorage, {
      resolve: (_sessionId, attachments) => Effect.succeed(attachments),
      isRecipient: () => Effect.succeed(false),
    }),
    WorkflowTestLive,
    application,
    catalogChanges,
    Layer.succeed(SessionFamilyStorage, {
      deferPassiveNotice: () => Effect.void,
      markPassiveNoticeAdmission: () => Effect.void,
      recordBoardDelivery: () => Effect.void,
      updateBoardDelivery: () => Effect.void,
      setBoardDeliveryPaused: () => Effect.void,
      recordCompletion: () => Effect.void,
      updateCompletion: () => Effect.void,
      list: () => Effect.succeed(family ? [family] : []),
      familyForMember: (sessionId) =>
        Effect.succeed(
          family &&
            (family.parentSessionId === sessionId ||
              family.children.some((child) => child.sessionId === sessionId))
            ? family
            : undefined,
        ),
      addChild: () => Effect.die("Unexpected family child creation"),
      state: () =>
        Effect.succeed({
          families: family ? [family] : [],
          turns: [],
          spawnedSessions: [],
        }),
      withMemberLock: (_id, effect) => effect,
      withCreationLock: (_key, effect) => effect,
      recordTurn: () => Effect.void,
      registerSpawn: () => Effect.void,
      recordReport: () => Effect.void,
      settleTurn: () => Effect.void,
      pendingResponseRequest: () => Effect.succeed(undefined),
      prepareResponse: () => Effect.succeed(false),
      confirmResponse: () => Effect.void,
      markNoticeAttempt: () => Effect.void,
      completeNotice: () => Effect.void,
      digestNotice: () => Effect.void,
      recordLaunchReport: () => Effect.void,
      removeDigest: () => Effect.void,
      saveUpdateBatch: () => Effect.void,
      closeUpdateBatch: () => Effect.void,
      deferReferenceNotice: () => Effect.void,
      markReferenceAdmissions: () => Effect.void,
      acknowledgeReports: () => Effect.void,
      withNoticeDelivery: (effect) => effect,
      withdrawNotices: () => Effect.void,
      removeUnmaterializedChild: () => Effect.void,
      removeProject: (projectPath) =>
        hooks.familyRemovalError
          ? Effect.fail(
              new SessionFamilyStorageError({
                operation: "removeProject",
                message: `Cannot remove families for ${projectPath}`,
              }),
            )
          : Effect.sync(() => hooks.onRemoveFamilyProject?.(projectPath)),
    }),
    makeCakeSessionRuntimesLayer(adapter).pipe(
      Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer()),
    ),
    SubagentCoordinatorLive.pipe(Layer.provideMerge(makeSubagentStorageTestLayer())),
    Layer.mock(RendererRequestCoordinator, {}),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved-sessions",
    }),
    Layer.mock(ProjectAccess, {
      rememberSessionLocation: () => Effect.void,
      forgetSessionLocation: () => Effect.void,
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
            requestInterview: async () => undefined,
            generateInlineWidget: async () => {
              throw new Error("Unexpected widget generation");
            },
          };
        }),
      releaseSession: () => Effect.void,
    }),
    Layer.mock(PiModels, {}),
    Layer.mock(Electron, {
      requireRendererConnection: vi.fn(),
      windowsForWorkspace: () => [],
      centerTrafficLights: vi.fn(),
    }),
    Layer.mock(VsCodeServer, {
      runProjectScript: (_workingDirectory, _source, input) =>
        Effect.succeed({ status: "completed" as const, value: input }),
      leaseFor: () => undefined,
    }),
    Layer.mock(SubagentEnvironment, {
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory: workingDirectory ?? "/home",
          agentDirectory: "/agent",
          sessionDirectory: "/subagents",
          trusted: true,
        }),
    }),
    Layer.mock(ArtifactGarbageCollector, {
      request: () => Effect.sync(() => hooks.onArtifactGarbageCollection?.()),
    }),
    Layer.mock(ArtifactStorage, {
      catalog: () => Effect.succeed({ lineages: [], links: [] }),
      read: (lineageId, artifactRevision) =>
        Effect.sync(() => {
          const pointer = hooks.forkArtifactPointers?.find(
            (candidate) =>
              candidate.lineageId === lineageId && candidate.revision === artifactRevision,
          );
          if (!pointer || artifactRevision === undefined) return undefined;
          return {
            lineageId,
            metadata: {
              revision: artifactRevision,
              digest: Schema.decodeUnknownSync(ArtifactDigest)(pointer.digest),
              kind: "markdown" as const,
              publishedAt: new Date(0).toISOString(),
              publishedBySessionId: "session-1",
              workingDirectory: "/project",
            },
            snapshot: {
              protocol: "cake.artifact/v1" as const,
              id: pointer.lineageId,
              sessionId: "session-1",
              revision: pointer.revision,
              kind: "markdown" as const,
              payload: { markdown: "Historical artifact" },
              fallback: { markdown: "Historical artifact" },
            },
          };
        }),
      putLink: (link) =>
        Effect.sync(() => {
          hooks.onArtifactLink?.(link);
          hooks.onInheritFork?.(
            "/project",
            "session-1",
            "/project",
            link.target.type === "session" ? link.target.sessionId : "family",
            hooks.forkArtifactPointers ?? [],
          );
        }),
      removeTargetLinks: (target) =>
        hooks.artifactRemovalFails?.(target)
          ? Effect.fail(
              new ArtifactStorageError({
                operation: "removeTargetLinks",
                message: "Cannot remove artifact links",
              }),
            )
          : Effect.sync(() => hooks.onRemoveArtifactTarget?.(target)),
    }),
    Layer.mock(ReviewStorage, {
      agentSessionDirectory: () => "/reviews/agent",
      reviewContextPath: () => "/reviews/context.md",
      discussionParentContextPath: () => "/reviews/discussion.md",
      listDiscussionRecords: () => Effect.succeed([]),
      deleteSession: () => Effect.void,
    }),
    Layer.succeed(
      SessionArchiveStorage,
      SessionArchiveStorage.of({
        relocate: () => Effect.void,
        resolve: () => Effect.succeed(false),
        restore: () => Effect.succeed(false),
        deleteResolved: () => Effect.void,
        deleteAuxiliary: (sessionId) => Effect.sync(() => hooks.onDeleteArchive?.(sessionId)),
        delete: (sessionId) =>
          hooks.archiveDeleteErrorSessionId === sessionId
            ? Effect.fail(
                new SessionArchiveStorageError({
                  operation: "delete",
                  sessionId,
                  message: `Cannot delete ${sessionId}`,
                }),
              )
            : Effect.sync(() => hooks.onDeleteArchive?.(sessionId)),
        locate: (sessionId, location) =>
          hooks.locate
            ? hooks.locate(sessionId, location)
            : Effect.succeed(
                hooks.sessionExists === false
                  ? undefined
                  : resolvedSessionIds.has(sessionId)
                    ? "resolved"
                    : "active",
              ),
        resolutionSnapshot: () =>
          Effect.succeed({
            version: 1 as const,
            directories: {
              [sessionDirectoryPath({
                workingDirectory: hooks.family?.workingDirectory ?? "/project",
                root: "/sessions",
              })]: [
                ...resolvedSessionIds,
                ...(hooks.resolvedProjectEntries ?? []).map((entry) => entry.sessionId),
              ],
            },
          }),
        recordedResolvedIds: () => Effect.succeed(new Set(resolvedSessionIds)),
        resolvedIds: () =>
          Effect.succeed(
            new Set([
              ...resolvedSessionIds,
              ...(hooks.resolvedProjectEntries ?? []).map((entry) => entry.sessionId),
            ]),
          ),
        resolved: (location) => {
          hooks.onResolvedCatalog?.(location.cwd);
          if (hooks.resolvedCatalog) return hooks.resolvedCatalog(location.cwd);
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
            if (resolvedSessionIds.delete(sessionId)) hooks.onRestore?.(sessionId);
            return undefined;
          }),
        deleteResolvedProject: (sessionId) =>
          hooks.archiveDeleteErrorSessionId === sessionId
            ? Effect.fail(
                new SessionArchiveStorageError({
                  operation: "deleteResolvedProject",
                  sessionId,
                  message: `Cannot delete ${sessionId}`,
                }),
              )
            : Effect.sync(() => {
                resolvedSessionIds.delete(sessionId);
                hooks.onDeleteArchive?.(sessionId);
              }),
        resolvedProjects: (projectPath) => {
          hooks.onResolvedCatalog?.(projectPath);
          const entries = hooks.resolvedProjectEntries ?? [
            { sessionId: "session-1", modifiedAt: "2026-01-02T00:00:00.000Z" },
          ];
          return hooks.sessionExists === false || resolvedSessionIds.size === 0
            ? Stream.empty
            : Stream.fromIterable(
                entries.map((entry) => ({
                  version: 2 as const,
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
                version: 2 as const,
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
                version: 2 as const,
                sessionId,
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
      awaitSetup: () => hooks.deferredWorktreeSetup ?? Effect.void,
      cleanupResolved: () =>
        hooks.cleanupFailure
          ? Effect.fail(
              new ManagedWorktreeError({
                operation: "cleanupResolved",
                message: "Checkout cleanup failed",
              }),
            )
          : Effect.sync(() => {
              hooks.onCleanupResolved?.();
              return true;
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

const nestedFamily = {
  familyId: "nested-family",
  parentSessionId: "parent",
  projectPath: "/project",
  workingDirectory: "/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  children: [
    {
      sessionId: "child",
      parentSessionId: "parent",
      requestId: "child-request",
      workingDirectory: "/child-tree",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      sessionId: "grandchild",
      parentSessionId: "child",
      requestId: "grandchild-request",
      workingDirectory: "/grandchild-tree",
      createdAt: "2026-01-01T00:00:02.000Z",
    },
  ],
};
const nestedFamilyIds = ["parent", "child", "grandchild"];
const sessionSummary = (id: string): PiSessionSummary => ({
  id,
  title: id,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-02T00:00:00.000Z",
  messageCount: 1,
  resolved: false,
});

describe("Project Sessions domain", () => {
  it.effect.each([false, true])(
    "exact-ID recovery preserves family routing, root-owned resolution and user metadata (resolved=%s)",
    (resolved) => {
      const state = {
        ...defaultApplicationState(),
        projects: [
          {
            path: "/project",
            name: "Project",
            addedAt: "2026-01-01",
            lastOpenedAt: "2026-01-01",
            workflow: {
              labels: [
                {
                  id: "10000000-0000-4000-8000-000000000001",
                  name: "Review",
                  color: "blue" as const,
                },
              ],
              assignments: [
                { sessionId: "child", labelIds: ["10000000-0000-4000-8000-000000000001"] },
              ],
              sessionDetails: [],
            },
          },
        ],
        trustedProjectPaths: ["/project"],
        unreadSessionIds: ["child"],
      };
      return Effect.gen(function* () {
        const application = yield* ApplicationState;
        const before = application.snapshot();
        const recovered = yield* projectSessionMetadata.lookup({ sessionId: "child" });
        assert.equal(recovered.familyId, "family");
        assert.equal(recovered.familyParentSessionId, "parent");
        assert.equal(recovered.familyDepth, 1);
        assert.equal(recovered.workingDirectory, "/retired-worktree");
        assert.equal(recovered.resolved, resolved);
        assert.equal(recovered.unread, true);
        assert.deepEqual(application.snapshot(), before);
      }).pipe(
        Effect.provide(
          makeLayer(state, {
            family: {
              familyId: "family",
              parentSessionId: "parent",
              projectPath: "/project",
              workingDirectory: "/project",
              createdAt: "2026-01-01",
              children: [
                {
                  sessionId: "child",
                  requestId: "request",
                  createdAt: "2026-01-01",
                  workingDirectory: "/retired-worktree",
                },
              ],
            },
            initialResolvedSessionIds: resolved ? ["parent"] : [],
            onCreateRuntime: () => {
              throw new Error("Lookup must not acquire a runtime");
            },
          }),
        ),
      );
    },
  );
  it.effect.each([false, true])(
    "publishes a new attachment worktree session at initial persistence and reconstructs it after completion (caller disconnected=%s)",
    (disconnect) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const persist = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const disposed = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const appeared = yield* Deferred.make<ProjectSessionSummary>();
        let durable = false;
        let returned = false;
        let streaming = false;
        let scans = 0;
        const attachment = {
          kind: "input" as const,
          id: "10000000-0000-4000-8000-000000000001",
          name: "notes.txt",
          mimeType: "text/plain",
          byteLength: 18,
        };
        const worktree: WorktreeRecord = {
          projectPath: "/project",
          worktreePath: "/worktree",
          branch: "agent/attachment-task",
          baseBranch: "main",
          createdAt: "2026-01-01",
          state: "active",
        };
        let item = sessionSummary("session-1");
        const layer = makeLayer(undefined, {
          worktreeRecords: [worktree],
          onCatalog: () => scans++,
          onRename: (title) => {
            item = { ...item, title };
          },
          catalog: (cwd) => (cwd === "/worktree" && durable ? Stream.make(item) : Stream.empty),
          catalogEntry: (query, id) =>
            Effect.succeed(
              durable && query.workingDirectory === "/worktree" && id === item.id
                ? item
                : undefined,
            ),
          locate: (id, location) =>
            Effect.succeed(
              durable && location.cwd === "/worktree" && id === item.id ? "active" : undefined,
            ),
          runtime: (options) => ({
            ...fakeRuntime(options, undefined, undefined, undefined, (title) => {
              item = { ...item, title };
            }),
            dispose: () => {
              Deferred.doneUnsafe(disposed, Effect.void);
            },
            get streaming() {
              return streaming;
            },
            prompt: async (_text, _delivery, attachments) => {
              assert.deepEqual(attachments, [attachment]);
              await Effect.runPromise(
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(persist);
                  durable = true;
                  streaming = true;
                  options.onInitialTranscriptPersisted?.();
                  yield* Deferred.await(finish);
                  streaming = false;
                }),
              );
            },
          }),
        });
        yield* Effect.gen(function* () {
          const updates = yield* projectSessionMetadata.observeCatalog({
            projectPath: "/project",
            resolved: false,
          });
          yield* updates.pipe(
            Stream.runForEach((update) => {
              if (update._tag === "Snapshot") {
                assert.deepEqual(update.sessions, []);
                return Deferred.succeed(ready, undefined);
              }
              if (update.event._tag === "Upserted")
                return Deferred.succeed(appeared, update.event.session);
              // Settlement durably marks the finished turn unread on the cheap activity event.
              if (
                update.event._tag === "ActivityChanged" &&
                !update.event.running &&
                update.event.unread &&
                durable
              ) {
                assert.equal(update.event.workingStartedAt, null);
                return Deferred.succeed(settled, undefined);
              }
              return Effect.void;
            }),
            Effect.forkChild,
          );
          yield* Deferred.await(ready);
          const creation = yield* projectSessionOperations
            .start({
              sessionId: item.id,
              workingDirectory: "/worktree",
              text: "Read the attachment",
              attachments: [attachment],
              renderUserMessageAsMarkdown: false,
            })
            .pipe(
              Effect.scoped,
              Effect.tap(() =>
                Effect.sync(() => {
                  returned = true;
                }),
              ),
              Effect.forkChild,
            );
          yield* Deferred.await(entered);
          assert.equal(returned, false);
          assert.equal(durable, false);
          if (disconnect) yield* Fiber.interrupt(creation);
          yield* Deferred.succeed(persist, undefined);
          if (!disconnect) yield* Fiber.join(creation);
          const first = yield* Deferred.await(appeared);
          assert.equal(first.workingDirectory, "/worktree");
          assert.equal(first.projectPath, "/project");
          assert.equal(first.worktreeName, "attachment-task");
          assert.equal(first.running, true);
          assert.equal(first.workingStartedAt, 0); // Effect test clock at prompt acceptance.
          assert.equal(scans, 2); // One initial metadata scan per registered location, never a retry scan.
          yield* projectSessionMetadata.open({ sessionId: item.id });
          yield* projectSessionOperations
            .rename({ sessionId: item.id }, "Attachment task")
            .pipe(Effect.scoped);
          yield* Deferred.succeed(finish, undefined);
          yield* Deferred.await(settled);
          yield* Deferred.await(disposed);
          const reconstructed = yield* (yield* projectSessionMetadata.observeCatalog({
            projectPath: "/project",
            resolved: false,
          })).pipe(Stream.take(1), Stream.runCollect);
          assert.equal(reconstructed[0]?._tag, "Snapshot");
          assert.deepEqual(
            reconstructed[0]?._tag === "Snapshot"
              ? reconstructed[0].sessions.map((s) => [s.sessionId, s.workingDirectory, s.running])
              : [],
            [[item.id, "/worktree", false]],
          );
          assert.equal(
            reconstructed[0]?._tag === "Snapshot" ? reconstructed[0].sessions[0]?.unread : false,
            true,
          );
          const recovered = yield* projectSessionMetadata.lookup({
            sessionId: item.id,
            workingDirectory: "/project",
          });
          assert.equal(recovered.workingDirectory, "/worktree");
          assert.equal(recovered.running, false);
          assert.equal(recovered.workingStartedAt, undefined);
          assert.equal(recovered.title, "Attachment task");
          const unknown = yield* projectSessionMetadata
            .lookup({ sessionId: "missing" })
            .pipe(Effect.exit);
          assert.equal(unknown._tag, "Failure");
        }).pipe(Effect.provide(layer));
      }),
  );
  it.effect(
    "includes committed IDs and typed cleanup failures in a mixed Working Directory result",
    () => {
      const changes: SessionCatalogChange[] = [];
      return Effect.gen(function* () {
        const sessions = yield* CakeSessionRuntimes;
        const result = yield* projectSessionLifecycle.resolveWorkingDirectory("/project").pipe(
          Effect.provideService(CakeSessionRuntimes, {
            ...sessions,
            currentStatus: ({ sessionId }) =>
              Effect.succeed(
                sessionId === "busy"
                  ? { streaming: true, pending: false, persisted: true }
                  : undefined,
              ),
          }),
        );
        assert.deepEqual(result.resolvedSessionIds, nestedFamilyIds);
        assert.deepEqual(
          result.failures.map((failure) => failure.sessionIds),
          [["busy"], ["io-failure"]],
        );
        assert.equal(result.cleanupFailures.length, 1);
        assert.deepEqual(result.cleanupFailures[0]?.resolvedSessionIds, nestedFamilyIds);
        assert.deepEqual(result.cleanupFailures[0]?.cleanupFailures, [
          { workingDirectory: "/grandchild-tree", message: "Checkout cleanup failed" },
        ]);
        assert.deepEqual(changes, [
          {
            _tag: "ProjectSessionsTransitioned",
            sessions: [{ sessionId: "parent", workingDirectory: "/project" }],
            projectPath: "/project",
            resolved: true,
          },
        ]);
        const failure = yield* projectSessionLifecycle
          .resolve({ sessionId: "io-failure" })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ProjectSessionError");
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            family: nestedFamily,
            sessionIds: (cwd) =>
              cwd === "/project" ? Stream.make("busy", "parent", "io-failure") : Stream.empty,
            worktreeRecords: [
              {
                projectPath: "/project",
                worktreePath: "/grandchild-tree",
                branch: "agent/grandchild",
                baseBranch: "main",
                state: "landed",
                createdAt: "2026-01-01",
              },
            ],
            cleanupFailure: true,
            archiveErrorSessionId: "io-failure",
            catalog: (cwd) =>
              Stream.make(sessionSummary(cwd === "/grandchild-tree" ? "grandchild" : "parent")),
            onCatalogChange: (change) => changes.push(change),
          }),
        ),
      );
    },
  );

  it.effect(
    "rejects deferred standalone resolution under the admission lock after family promotion",
    () =>
      Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let promoted = false;
        let locked = false;
        const fiber = yield* projectSessionLifecycle
          .resolveDeferredStandalone({ sessionId: "parent" })
          .pipe(
            Effect.provideService(SessionFamilyStorage, {
              ...storage,
              withMemberLock: (_id, effect) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  locked = true;
                  return yield* effect;
                }),
              familyForMember: (id) => {
                assert.equal(locked, true, "membership is checked inside admission");
                return promoted ? storage.familyForMember(id) : Effect.succeed(undefined);
              },
            }),
            Effect.result,
            Effect.forkChild,
          );
        yield* Deferred.await(entered);
        promoted = true;
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.ok(result.failure instanceof ResolutionRejected);
          assert.deepEqual(result.failure.sessionIds, ["parent"]);
        }
        for (const id of nestedFamilyIds)
          assert.equal((yield* projectSessionMetadata.inspect({ sessionId: id })).resolved, false);
      }).pipe(Effect.provide(makeLayer(undefined, { family: nestedFamily }))),
  );

  it.effect("resolves a still-standalone deferred request after its turn settles", () =>
    Effect.gen(function* () {
      const sessions = yield* CakeSessionRuntimes;
      for (const status of [
        { streaming: true, pending: false, persisted: true },
        { streaming: false, pending: true, persisted: true },
        { streaming: false, pending: false, persisted: false },
      ]) {
        const failure = yield* projectSessionLifecycle
          .resolveDeferredStandalone({ sessionId: "session-1" })
          .pipe(
            Effect.provideService(CakeSessionRuntimes, {
              ...sessions,
              currentStatus: () => Effect.succeed(status),
            }),
            Effect.flip,
          );
        assert.ok(failure instanceof ResolutionRejected);
      }
      assert.equal(
        yield* projectSessionLifecycle.resolveDeferredStandalone({ sessionId: "session-1" }),
        undefined,
      );
      assert.equal(
        (yield* projectSessionMetadata.inspect({ sessionId: "session-1" })).resolved,
        true,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "queues a local final report at settlement without acquiring a notification recipient",
    () =>
      Effect.gen(function* () {
        const queue = yield* ProjectTodoReports;
        const options = yield* acquireOptions({
          sessionId: "session-1",
          newSession: false,
          location: {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved-sessions",
          },
        });
        assert.ok(options.onTurnSettled);
        yield* options.onTurnSettled({
          sessionId: "session-1",
          turnId: "local-turn",
          outcome: "complete",
          result: {
            stopReason: "stop",
            text: "Located the startup bottleneck; verification is pending.",
          },
        });
        const batches = yield* queue.reports().pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(batches.flat(), [
          {
            projectPath: "/project",
            sessionId: "session-1",
            text: "Located the startup bottleneck; verification is pending.",
          },
        ]);
      }).pipe(Effect.provide(Layer.merge(makeLayer(), ProjectTodoReports.layer))),
  );

  it.effect.each([
    { deferred: true, cleanupFailure: false, promoted: false },
    { deferred: true, cleanupFailure: true, promoted: false },
    { deferred: false, cleanupFailure: true, promoted: false },
    { deferred: true, cleanupFailure: false, promoted: true },
  ])(
    "preserves real lifecycle outcomes through runtime callbacks and continuations (%j)",
    (scenario) => {
      const archived: string[] = [];
      return Effect.gen(function* () {
        const families = yield* SessionFamilyStorage;
        let promoted = false;
        const options = yield* acquireOptions({
          sessionId: "parent",
          newSession: false,
          location: {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/tree",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved-sessions",
          },
        }).pipe(
          Effect.provideService(SessionFamilyStorage, {
            ...families,
            familyForMember: (id) =>
              promoted ? families.familyForMember(id) : Effect.succeed(undefined),
          }),
        );
        let streaming = scenario.deferred;
        const notices: Array<{ title: string; detail: string }> = [];
        const actions: string[] = [];
        const manager = SessionManager.inMemory("/tree");
        const continuation = createCakeSessionRuntimeContinuations({
          options: {
            ...options.runtime,
            cwd: "/tree",
            agentDir: "/agent",
            sessionDir: "/sessions",
            requestUi: async () => undefined,
            onEvent: () => undefined,
          },
          session: {
            sessionManager: manager,
            setSessionName: (name) => manager.appendSessionInfo(name),
            sessionFile: undefined,
            get isStreaming() {
              return streaming;
            },
            navigateTree: async () => ({ cancelled: false }),
            model: undefined,
            thinkingLevel: "off",
          },
          sessionId: "parent",
          isDisposed: () => false,
          emitSnapshot: async () => undefined,
          emitNotice: (notice) => {
            notices.push(notice);
          },
          drainReloads: () => undefined,
          handleSettledTurn: async () => undefined,
          reportAgentAction: async (action) => {
            actions.push(action);
          },
        });
        const receipt = yield* Effect.promise(() => continuation.setResolved(true));
        if (scenario.deferred) {
          assert.deepEqual(archived, []);
          promoted = scenario.promoted;
          streaming = false;
          yield* Effect.promise(() => continuation.finishSettledTurn());
        }
        assert.deepEqual(archived, scenario.promoted ? [] : ["parent"]);
        assert.deepEqual(actions, scenario.promoted ? [] : ["resolve"]);
        if (scenario.promoted) {
          assert.equal(notices[0]?.title, "Could not resolve session");
          assert.match(notices[0]?.detail ?? "", /family member/);
        } else if (scenario.cleanupFailure && scenario.deferred) {
          assert.equal(notices[0]?.title, "Session resolved; Working Directory cleanup failed");
          assert.match(notices[0]?.detail ?? "", /Resolved sessions: parent/);
          assert.match(notices[0]?.detail ?? "", /\/tree: Checkout cleanup failed/);
        } else {
          assert.deepEqual(notices, []);
          if (scenario.cleanupFailure)
            assert.deepEqual(receipt, {
              sessionId: "parent",
              resolved: true,
              resolveOnSettle: false,
              cleanupFailures: [{ workingDirectory: "/tree", message: "Checkout cleanup failed" }],
            });
        }
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            family: scenario.promoted ? { ...nestedFamily, workingDirectory: "/tree" } : undefined,
            catalog: () => Stream.make(sessionSummary("parent")),
            cleanupFailure: scenario.cleanupFailure,
            onArchive: (id) => archived.push(id),
            worktreeRecords: [
              {
                projectPath: "/project",
                worktreePath: "/tree",
                branch: "agent/test",
                baseBranch: "main",
                state: "landed",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ),
      );
    },
  );

  it.effect(
    "publishes a committed resolution despite caller interruption during finalization",
    () => {
      const changes: SessionCatalogChange[] = [];
      return Effect.gen(function* () {
        const archive = yield* SessionArchiveStorage;
        const committed = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const fiber = yield* projectSessionLifecycle.resolve({ sessionId: "session-1" }).pipe(
          Effect.provideService(SessionArchiveStorage, {
            ...archive,
            resolveProject: (...args) =>
              archive.resolveProject(...args).pipe(
                Effect.tap(() => Deferred.succeed(committed, undefined)),
                Effect.tap(() => Deferred.await(finish)),
              ),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(committed);
        fiber.interruptUnsafe();
        yield* Deferred.succeed(finish, undefined);
        const exit = yield* Fiber.await(fiber);
        assert.equal(exit._tag, "Failure");
        assert.ok(
          changes.some(
            (change) => change._tag === "ProjectSessionStatusChanged" && change.resolved,
          ),
        );
        assert.equal(
          (yield* projectSessionMetadata.inspect({ sessionId: "session-1" })).resolved,
          true,
        );
      }).pipe(
        Effect.provide(makeLayer(undefined, { onCatalogChange: (change) => changes.push(change) })),
      );
    },
  );

  it.effect(
    "keeps long checkout cleanup interruptible without rolling back committed resolution",
    () =>
      Effect.gen(function* () {
        const worktrees = yield* ManagedWorktrees;
        const cleaning = yield* Deferred.make<void>();
        const fiber = yield* projectSessionLifecycle.resolve({ sessionId: "parent" }).pipe(
          Effect.provideService(ManagedWorktrees, {
            ...worktrees,
            cleanupResolved: () =>
              Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(cleaning);
        yield* Fiber.interrupt(fiber);
        assert.equal((yield* Fiber.await(fiber))._tag, "Failure");
        for (const id of nestedFamilyIds)
          assert.equal((yield* projectSessionMetadata.inspect({ sessionId: id })).resolved, true);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            family: nestedFamily,
            catalog: (cwd) =>
              Stream.make(sessionSummary(cwd === "/grandchild-tree" ? "grandchild" : "parent")),
            worktreeRecords: [
              {
                projectPath: "/project",
                worktreePath: "/grandchild-tree",
                branch: "agent/grandchild",
                baseBranch: "main",
                state: "landed",
                createdAt: "2026-01-01",
              },
            ],
          }),
        ),
      ),
  );

  it.effect("refuses an undelivered family outcome before committing", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const state = yield* storage.state();
      const failure = yield* projectSessionLifecycle.resolve({ sessionId: "parent" }).pipe(
        Effect.provideService(SessionFamilyStorage, {
          ...storage,
          state: () =>
            Effect.succeed({
              ...state,
              turns: [
                {
                  sessionId: "child",
                  senderSessionId: "parent",
                  turnId: "turn",
                  threadId: "nested-family",
                  requestMessageId: "request",
                  reported: false,
                },
              ],
            }),
        }),
        Effect.flip,
      );
      assert.ok(failure instanceof ResolutionRejected);
      assert.deepEqual(failure.sessionIds, nestedFamilyIds);
      assert.equal(
        (yield* projectSessionMetadata.inspect({ sessionId: "parent" })).resolved,
        false,
      );
    }).pipe(Effect.provide(makeLayer(undefined, { family: nestedFamily }))),
  );

  it.effect(
    "projects metadata-only resolution into both catalog lanes while Pi files stay discoverable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cake-resolution-catalog-" });
        const cwd = path.join(root, "project");
        const sessionDirectory = path.join(root, "sessions");
        const resolvedSessionDirectory = path.join(root, "old-archives");
        const directory = cakeWorkspaceSessionDirectory(cwd, sessionDirectory);
        yield* fs.makeDirectory(directory, { recursive: true });
        const files: string[] = [];
        for (const id of ["session-1", "session-2"]) {
          const file = path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
          files.push(file);
          yield* fs.writeFileString(
            file,
            [
              { type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
              {
                type: "message",
                id: "user",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: { role: "user", content: id, timestamp: 1 },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
        }
        const [sessionFile] = files;
        assert.ok(sessionFile);
        const original = yield* fs.readFileString(sessionFile);
        yield* Effect.gen(function* () {
          const archive = yield* SessionArchiveStorage;
          yield* Effect.gen(function* () {
            const model = SessionCatalog.create({});
            const received = yield* Queue.unbounded<SessionCatalogUpdate>();
            for (const resolved of [false, true]) {
              const query = { projectPath: cwd, resolved };
              const updates = yield* projectSessionMetadata.observeCatalog(query);
              yield* updates.pipe(
                Stream.runForEach((update) =>
                  Effect.sync(() => applySessionCatalogGroupUpdate(model, query, update)).pipe(
                    Effect.andThen(Queue.offer(received, update)),
                  ),
                ),
                Effect.forkScoped,
              );
            }
            yield* Queue.take(received);
            yield* Queue.take(received);
            assert.equal(model.find("session-1")?.resolved, false);
            assert.equal(model.find("session-2")?.resolved, false);
            yield* projectSessionLifecycle.resolve({
              sessionId: "session-1",
              workingDirectory: cwd,
            });
            yield* Queue.take(received);
            yield* Queue.take(received);
            assert.equal(model.find("session-1")?.resolved, true);
            assert.equal(model.find("session-2")?.resolved, false);
            // The file remains present: a late active notification must not
            // reintroduce it into the active lane.
            yield* (yield* SessionCatalogChanges).publish({
              _tag: "ProjectSessionChanged",
              sessionId: "session-1",
              projectPath: cwd,
              workingDirectory: cwd,
              resolved: false,
            });
            yield* Queue.take(received);
            yield* Queue.take(received);
            assert.equal(model.find("session-1")?.resolved, true);
            assert.equal(yield* fs.readFileString(sessionFile), original);
            assert.deepEqual(
              (yield* streamWorkspaceSessions(cwd, sessionDirectory).pipe(Stream.runCollect))
                .map((item) => item.id)
                .sort(),
              ["session-1", "session-2"],
            );
            // A fresh initial listing must use the persisted index, not old file placement.
            const fresh = yield* projectSessionMetadata.observeCatalog({
              projectPath: cwd,
              resolved: false,
            });
            const [initial] = yield* fresh.pipe(Stream.take(1), Stream.runCollect);
            assert.equal(initial?._tag, "Snapshot");
            if (initial?._tag === "Snapshot")
              assert.deepEqual(
                initial.sessions.map((item) => item.sessionId),
                ["session-2"],
              );
            yield* projectSessionLifecycle.restore({
              sessionId: "session-1",
              workingDirectory: cwd,
            });
            yield* Queue.take(received);
            yield* Queue.take(received);
            assert.equal(model.find("session-1")?.resolved, false);
            yield* (yield* SessionCatalogChanges).publish({
              _tag: "ProjectSessionChanged",
              sessionId: "session-1",
              projectPath: cwd,
              workingDirectory: cwd,
              resolved: true,
            });
            yield* Queue.take(received);
            yield* Queue.take(received);
            assert.equal(model.find("session-1")?.resolved, false);
            assert.equal(yield* fs.readFileString(sessionFile), original);
          }).pipe(
            Effect.provideService(SessionArchiveStorage, archive),
            Effect.provideService(ProjectSessionConfiguration, {
              agentDirectory: path.join(root, "agent"),
              sessionDirectory,
              resolvedSessionDirectory,
            }),
            Effect.provide(
              makeLayer(defaultApplicationState(), {
                locations: [
                  {
                    projectPath: cwd,
                    projectName: "Project",
                    workingDirectory: cwd,
                    sessionDirectory,
                    resolvedSessionDirectory,
                  },
                ],
                catalog: () => streamWorkspaceSessions(cwd, sessionDirectory),
              }),
            ),
          );
        }).pipe(
          Effect.provide(
            makeSessionArchiveStorageLive(path.join(root, "metadata"), {
              activeRoot: sessionDirectory,
              resolvedRoot: resolvedSessionDirectory,
            }),
          ),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
  it.effect(
    "projects parent-only resolve and restore through both catalog lanes for the whole nested family",
    () => {
      const archived: string[] = [];
      const restored: string[] = [];
      return Effect.gen(function* () {
        const model = SessionCatalog.create({});
        const received = yield* Queue.unbounded<SessionCatalogUpdate>();
        for (const resolved of [false, true]) {
          const query = { projectPath: "/project", resolved };
          const updates = yield* projectSessionMetadata.observeCatalog(query);
          yield* updates.pipe(
            Stream.runForEach((update) =>
              Effect.sync(() => applySessionCatalogGroupUpdate(model, query, update)).pipe(
                Effect.andThen(Queue.offer(received, update)),
              ),
            ),
            Effect.forkScoped,
          );
        }
        yield* Queue.take(received);
        yield* Queue.take(received);
        const assertFamily = (resolved: boolean) => {
          for (const id of nestedFamilyIds) assert.equal(model.find(id)?.resolved, resolved, id);
          assert.equal(model.find("unrelated")?.resolved, false);
        };
        assertFamily(false);
        assert.equal(model.find("grandchild")?.familyParentSessionId, "child");
        const childUpdates = yield* Queue.unbounded<ConversationUpdate>();
        const childStream = yield* projectSessionOperations.observeConversation({
          sessionId: "grandchild",
        });
        yield* childStream.pipe(
          Stream.runForEach((update) => Queue.offer(childUpdates, update)),
          Effect.forkScoped,
        );
        const childInitial = yield* Queue.take(childUpdates);
        assert.equal(childInitial._tag, "Preview");
        assert.equal((yield* Queue.take(childUpdates))._tag, "Snapshot");
        if (childInitial._tag === "Preview")
          assert.equal(childInitial.snapshot.sessionId, "grandchild");

        yield* projectSessionLifecycle.resolve({ sessionId: "parent" });
        yield* Queue.take(received);
        yield* Queue.take(received);
        assertFamily(true);
        const childResolved = yield* Queue.take(childUpdates);
        assert.equal(childResolved._tag, "Preview");
        assert.deepEqual(archived, ["parent"]);
        for (const id of nestedFamilyIds)
          assert.equal((yield* projectSessionMetadata.inspect({ sessionId: id })).resolved, true);

        // A late child runtime notification must not reintroduce an active child.
        yield* (yield* SessionCatalogChanges).publish({
          _tag: "ProjectSessionChanged",
          sessionId: "grandchild",
          projectPath: "/project",
          workingDirectory: "/grandchild-tree",
          resolved: false,
        });
        yield* Queue.take(received);
        yield* Queue.take(received);
        assertFamily(true);

        // Notifications invalidate projections; their payload is not another
        // resolution authority, even if it describes an older root transition.
        yield* (yield* SessionCatalogChanges).publish({
          _tag: "ProjectSessionsTransitioned",
          sessions: [{ sessionId: "parent", workingDirectory: "/project" }],
          projectPath: "/project",
          resolved: false,
        });
        yield* Queue.take(received);
        yield* Queue.take(received);
        assertFamily(true);

        yield* projectSessionLifecycle.restore({ sessionId: "parent" });
        yield* Queue.take(received);
        yield* Queue.take(received);
        assertFamily(false);
        const childRestored = yield* Queue.take(childUpdates);
        assert.equal(childRestored._tag, "Preview");
        assert.equal((yield* Queue.take(childUpdates))._tag, "Snapshot");
        if (childRestored._tag === "Preview")
          assert.equal(childRestored.snapshot.sessionId, "grandchild");
        assert.deepEqual(restored, ["parent"]);
        for (const id of nestedFamilyIds)
          assert.equal((yield* projectSessionMetadata.inspect({ sessionId: id })).resolved, false);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            family: nestedFamily,
            catalog: (cwd) =>
              Stream.fromIterable(
                cwd === "/project"
                  ? [
                      sessionSummary("parent"),
                      { ...sessionSummary("unrelated"), parentSessionId: "parent" },
                    ]
                  : [],
              ),
            onArchive: (id) => archived.push(id),
            onRestore: (id) => restored.push(id),
          }),
        ),
      );
    },
  );

  it.effect("rejects lifecycle actions addressed to a family child", () =>
    Effect.gen(function* () {
      for (const action of [projectSessionLifecycle.resolve, projectSessionLifecycle.restore]) {
        const failure = yield* action({ sessionId: "child" }).pipe(Effect.flip);
        assert.match(failure.message, /only session family parent parent/i);
        assert.equal(
          failure._tag,
          action === projectSessionLifecycle.resolve ? "ResolutionRejected" : "ProjectSessionError",
        );
      }
    }).pipe(Effect.provide(makeLayer(undefined, { family: nestedFamily }))),
  );

  it.effect("checks descendant activity before changing the root authority", () =>
    Effect.gen(function* () {
      const sessions = yield* CakeSessionRuntimes;
      for (const status of [
        { streaming: true, pending: false, persisted: true },
        { streaming: false, pending: true, persisted: true },
      ]) {
        const failure = yield* projectSessionLifecycle.resolve({ sessionId: "parent" }).pipe(
          Effect.provideService(CakeSessionRuntimes, {
            ...sessions,
            currentStatus: (target) =>
              Effect.succeed(target.sessionId === "grandchild" ? status : undefined),
          }),
          Effect.flip,
        );
        assert.ok(failure instanceof ResolutionRejected);
        assert.deepEqual(failure.sessionIds, ["grandchild"]);
        assert.match(failure.message, /turn is active or input is pending/);
        for (const id of nestedFamilyIds)
          assert.equal((yield* projectSessionMetadata.inspect({ sessionId: id })).resolved, false);
      }
    }).pipe(Effect.provide(makeLayer(undefined, { family: nestedFamily }))),
  );

  it.effect(
    "keeps the entire family resolved and publishes its authority even when checkout cleanup fails",
    () => {
      const changes: SessionCatalogChange[] = [];
      const cleanupAttempts: string[] = [];
      return Effect.gen(function* () {
        const worktrees = yield* ManagedWorktrees;
        const failure = yield* projectSessionLifecycle.resolve({ sessionId: "parent" }).pipe(
          Effect.provideService(ManagedWorktrees, {
            ...worktrees,
            cleanupResolved: (cwd, options) =>
              Effect.sync(() => cleanupAttempts.push(cwd)).pipe(
                Effect.andThen(worktrees.cleanupResolved(cwd, options)),
              ),
          }),
          Effect.flip,
        );
        assert.deepEqual(cleanupAttempts, ["/grandchild-tree"]);
        assert.ok(failure instanceof ResolutionCleanupFailed);
        assert.deepEqual(failure.resolvedSessionIds, nestedFamilyIds);
        assert.deepEqual(failure.cleanupFailures, [
          { workingDirectory: "/grandchild-tree", message: "Checkout cleanup failed" },
        ]);
        assert.match(failure.message, /Checkout cleanup failed/);
        assert.deepEqual(changes, [
          {
            _tag: "ProjectSessionsTransitioned",
            sessions: [{ sessionId: "parent", workingDirectory: "/project" }],
            projectPath: "/project",
            resolved: true,
          },
        ]);
        const model = SessionCatalog.create({});
        for (const resolved of [false, true]) {
          const query = { projectPath: "/project", resolved };
          const stream = yield* projectSessionMetadata.observeCatalog(query);
          const [initial] = yield* stream.pipe(Stream.take(1), Stream.runCollect);
          assert.ok(initial);
          applySessionCatalogGroupUpdate(model, query, initial);
        }
        for (const id of nestedFamilyIds) assert.equal(model.find(id)?.resolved, true, id);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            family: nestedFamily,
            cleanupFailure: true,
            onCatalogChange: (change) => changes.push(change),
            worktreeRecords: [
              {
                projectPath: "/project",
                worktreePath: "/grandchild-tree",
                branch: "agent/grandchild",
                baseBranch: "main",
                state: "landed",
                createdAt: "2026-01-01",
              },
            ],
            catalog: (cwd) =>
              cwd === "/grandchild-tree"
                ? Stream.make(sessionSummary("grandchild"))
                : Stream.make(sessionSummary("parent")),
          }),
        ),
      );
    },
  );

  for (const rootResolved of [false, true]) {
    it.effect(
      `derives every descendant from the root when stored namespaces disagree (root resolved: ${rootResolved})`,
      () =>
        Effect.gen(function* () {
          const model = SessionCatalog.create({});
          for (const resolved of [false, true]) {
            const query = { projectPath: "/project", resolved };
            const updates = yield* projectSessionMetadata.observeCatalog(query);
            const [initial] = yield* updates.pipe(Stream.take(1), Stream.runCollect);
            assert.ok(initial);
            applySessionCatalogGroupUpdate(model, query, initial);
          }
          for (const id of nestedFamilyIds) {
            assert.equal(model.find(id)?.resolved, rootResolved, id);
            assert.equal(
              (yield* projectSessionMetadata.inspect({ sessionId: id })).resolved,
              rootResolved,
            );
          }
          // Opening a physically active descendant of an archived root stays read-only.
          if (rootResolved) {
            const updates = yield* projectSessionOperations.observeConversation({
              sessionId: "grandchild",
            });
            const [initial] = yield* updates.pipe(Stream.take(1), Stream.runCollect);
            assert.equal(initial?._tag, "Preview");
            if (initial?._tag === "Preview") assert.equal(initial.snapshot.sessionId, "grandchild");
          }
        }).pipe(
          Effect.provide(
            makeLayer(undefined, {
              family: nestedFamily,
              initialResolvedSessionIds: rootResolved ? ["parent"] : ["child", "grandchild"],
              catalog: () => Stream.make(sessionSummary("parent")),
              resolvedProjectEntries: (rootResolved ? ["parent"] : ["child", "grandchild"]).map(
                (sessionId) => ({ sessionId, modifiedAt: "2026-01-02T00:00:00.000Z" }),
              ),
            }),
          ),
        ),
    );
  }

  it.effect("assigns ordered labels to active sessions", () =>
    Effect.gen(function* () {
      const labelId = "b925b5dd-9661-4f1a-9f40-406be3c96c27";
      const workflow = yield* projectSessionLifecycle.setWorkflowSessionLabels({
        projectPath: "/project",
        sessionId: "session-1",
        workingDirectory: "/project",
        labelIds: [labelId],
      });
      assert.deepEqual(workflow.assignments, [{ sessionId: "session-1", labelIds: [labelId] }]);
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
                labels: [
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

  it.effect("rejects label changes for resolved sessions", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        projectSessionLifecycle.setWorkflowSessionLabels({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          labelIds: [],
        }),
      );
      assert.equal(failure.message, "Only active sessions can have their labels changed");
    }).pipe(Effect.provide(makeLayer(undefined, { resolvedOnDisk: true }))),
  );

  it.effect("rejects unknown labels and Draft label changes through the domain", () =>
    Effect.gen(function* () {
      const missingLabel = yield* Effect.flip(
        projectSessionLifecycle.setWorkflowSessionLabels({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          labelIds: ["b925b5dd-9661-4f1a-9f40-406be3c96c27"],
        }),
      );
      assert.equal(missingLabel.message, "A selected label no longer exists");
      const draftLabels = yield* Effect.flip(
        projectSessionLifecycle.setWorkflowSessionLabels({
          projectPath: "/project",
          sessionId: "session-1",
          workingDirectory: "/project",
          labelIds: [],
        }),
      );
      assert.equal(draftLabels.message, "Only active sessions can have their labels changed");
      const directResolution = yield* Effect.flip(
        projectSessionLifecycle.resolve({ sessionId: "session-1", workingDirectory: "/project" }),
      );
      assert.equal(directResolution.message, "Activate a Draft before resolving it");
    }).pipe(Effect.provide(makeLayer(undefined, { sessionExists: false }))),
  );

  it.effect(
    "UI resolve completes linked to-dos and cancels passive context without agent turns; restore preserves completion",
    () => {
      const transitions: string[] = [];
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const noticeId = "49300a23-59d8-4dd5-b680-0e8694240a79";
        yield* storage.recordBoardDelivery({
          boardId: "family-board",
          sequences: [1],
          through: 1,
          recipientSessionId: "session-1",
          turnId: noticeId,
          status: "deferred",
        });
        yield* storage.deferPassiveNotice({
          id: noticeId,
          recipientSessionId: "session-1",
          text: "Optional review.",
          crossSession: {
            version: 1,
            messageId: noticeId,
            threadId: noticeId,
            sequence: 1,
            expectsResponse: false,
            resultDelivery: "ignore",
            sender: { sessionId: "session-2", title: "Review", kind: "project-session" },
          },
        });
        const item = yield* projectTodos.create("/project", {
          title: "Review report",
          description: "Review report.",
          status: "Awaiting review",
          associations: [{ kind: "session", sessionId: "session-1", title: "Session one" }],
        });
        yield* projectSessionHandlers["projectSessions.resolve"]({
          sessionId: "session-1",
          userInitiated: true,
        });
        let current = yield* projectTodos.list("/project");
        assert.equal(current.items[0]?.state, "done");
        assert.equal(current.items.filter((item) => item.state === "open").length, 0);
        assert.deepEqual(
          current.pending.map((change) => change._tag),
          ["SessionState", "ItemState"],
        );
        assert.ok(current.pending[0]?._tag === "SessionState" && current.pending[0].resolved);
        const receipt = current.sequence;
        yield* projectSessionUserLifecycle.setResolved({ sessionId: "session-1" }, true);
        assert.equal((yield* projectTodos.list("/project")).sequence, receipt);
        assert.equal((yield* projectTodos.read("/project", item.id)).revision, 1);
        yield* projectSessionUserLifecycle.setResolved({ sessionId: "session-1" }, false);
        current = yield* projectTodos.list("/project");
        assert.equal(current.items[0]?.state, "done");
        assert.ok(
          current.pending.some(
            (change) =>
              change._tag === "SessionState" &&
              change.sessionId === "session-1" &&
              !change.resolved,
          ),
        );
        assert.deepEqual(transitions, ["resolve:session-1", "restore:session-1"]);
        assert.equal((yield* storage.state()).boardDeliveries?.[0]?.status, "canceled");
        assert.equal((yield* storage.state()).passiveNotices?.[0]?.text, "");
        assert.equal((yield* storage.state()).passiveNotices?.[0]?.delivered, true);
      }).pipe(
        Effect.provide(
          Layer.merge(
            makeLayer(undefined, {
              onArchive: (id) => transitions.push(`resolve:${id}`),
              onRestore: (id) => transitions.push(`restore:${id}`),
              onCreateRuntime: () =>
                assert.fail("Resolution must not start or wake an agent for acknowledgment"),
            }),
            familyStorageHarness().layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "sessions.resolve native RPC completes multiple linked sessions only when all resolve; sources do not veto",
    () =>
      Effect.gen(function* () {
        const associations = [
          { kind: "session" as const, sessionId: "session-1", title: "First implementation" },
          { kind: "session" as const, sessionId: "session-2", title: "Second implementation" },
        ];
        const item = yield* projectTodos.create("/project", {
          title: "Combined implementation",
          description: "Combined implementation.",
          status: "In progress",
          associations,
        });
        const mixed = yield* projectTodos.create("/project", {
          title: "Discuss report",
          description: "Discuss report.",
          status: "Awaiting review",
          associations: [
            ...associations,
            {
              kind: "source",
              ref: "cake://session/session-1?message=report",
              title: "Investigator report",
            },
          ],
        });
        yield* projectSessionHandlers["projectSessions.resolve"]({
          sessionId: "session-1",
          userInitiated: false,
        });
        assert.equal((yield* projectTodos.read("/project", item.id)).state, "open");
        yield* projectSessionHandlers["projectSessions.resolve"]({
          sessionId: "session-2",
          userInitiated: false,
        });
        assert.equal((yield* projectTodos.read("/project", item.id)).state, "done");
        assert.equal((yield* projectTodos.read("/project", mixed.id)).state, "done");
        assert.equal(
          (yield* projectTodos.list("/project")).items.filter((item) => item.state === "open")
            .length,
          0,
        );
        yield* projectSessionLifecycle.restore({ sessionId: "session-1" });
        assert.equal((yield* projectTodos.read("/project", item.id)).state, "done");
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "done does not resolve a family; root resolution completes linked parent and child work",
    () => {
      const family = {
        familyId: "linked-family",
        parentSessionId: "parent-1",
        projectPath: "/project",
        workingDirectory: "/project",
        createdAt: "2026-01-01T00:00:00.000Z",
        children: [
          { sessionId: "session-1", requestId: "child-1", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      };
      return Effect.gen(function* () {
        const item = yield* projectTodos.create("/project", {
          title: "Family implementation",
          description: "Family implementation.",
          status: "Report available; still open",
          associations: [
            { kind: "session", sessionId: "parent-1", title: "Parent" },
            { kind: "session", sessionId: "session-1", title: "Child implementation" },
          ],
        });
        yield* projectTodos.mutateUser("/project", {
          _tag: "SetState",
          id: item.id,
          expectedRevision: 0,
          state: "done",
        });
        assert.equal(
          (yield* projectSessionMetadata.lookup({ sessionId: "parent-1" })).resolved,
          false,
        );
        yield* projectTodos.mutateUser("/project", {
          _tag: "SetState",
          id: item.id,
          expectedRevision: 1,
          state: "open",
        });
        yield* projectSessionLifecycle.resolve({ sessionId: "parent-1" });
        assert.equal((yield* projectTodos.read("/project", item.id)).state, "done");
        yield* projectSessionLifecycle.restore({ sessionId: "parent-1" });
        assert.equal((yield* projectTodos.read("/project", item.id)).state, "done");
      }).pipe(Effect.provide(makeLayer(undefined, { family })));
    },
  );

  it.effect(
    "canonicalizes launched session suffixes and keeps optional useful non-session links",
    () => {
      const sessionId = "86778ccd-a805-4ff4-8767-93b5a558842c";
      return Effect.gen(function* () {
        const item = yield* projectTodoAssociations.create("/project", {
          title: "Startup",
          description: "Find the startup bottleneck.",
          associations: [
            { kind: "session", sessionId: "a558842c", title: "Implementation" },
            { kind: "source", ref: "cake://artifact/startup@r2", title: "Design" },
            { kind: "source", ref: "https://example.com/report", title: "Reference" },
            { kind: "source", ref: "docs/startup.md#L2", title: "Notes" },
          ],
        });
        assert.equal(
          item.associations[0]?.kind === "session" && item.associations[0].sessionId,
          sessionId,
        );
        assert.equal(item.associations.length, 4);
      }).pipe(Effect.provide(makeLayer(undefined, { sessionIds: () => Stream.make(sessionId) })));
    },
  );

  it.effect(
    "late creation/association to resolved sessions persists done immediately and returns the current revision",
    () => {
      const sessionId = "86778ccd-a805-4ff4-8767-93b5a558842c";
      return Effect.gen(function* () {
        const created = yield* projectTodoAssociations.create("/project", {
          title: "Already implemented",
          description: "Track the implementation.",
          associations: [{ kind: "session", sessionId: "a558842c", title: "Work" }],
        });
        assert.equal(created.state, "done");
        assert.equal(
          created.associations[0]?.kind === "session" && created.associations[0].sessionId,
          sessionId,
        );
        const unlinked = yield* projectTodos.create("/project", {
          title: "Discussion",
          description: "Discuss the design.",
        });
        const updated = yield* projectTodoAssociations.update("/project", {
          id: unlinked.id,
          expectedRevision: 0,
          associations: [{ kind: "session", sessionId, title: "Work" }],
        });
        assert.equal(updated.state, "done");
        assert.equal(updated.revision, 1);
        assert.equal(
          (yield* projectTodos.list("/project")).items.filter((item) => item.state === "open")
            .length,
          0,
        );
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            initialResolvedSessionIds: [sessionId],
            sessionIds: () => Stream.make(sessionId),
          }),
        ),
      );
    },
  );

  it.effect(
    "session resolution completes linked items before checkout cleanup errors, without a runtime",
    () =>
      Effect.gen(function* () {
        const item = yield* projectTodos.create("/project", {
          title: "Implementation",
          description: "Finish implementation.",
          associations: [{ kind: "session", sessionId: "session-1", title: "Work" }],
        });
        const result = yield* projectSessionHandlers["projectSessions.resolve"]({
          sessionId: "session-1",
          workingDirectory: "/tree",
          userInitiated: false,
        }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal((yield* projectTodos.read("/project", item.id)).state, "done");
        yield* projectTodoResolution.initialize();
        assert.equal((yield* projectTodos.read("/project", item.id)).revision, 1);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            cleanupFailure: true,
            sessionIds: () => Stream.make("session-1"),
            worktreeRecords: [
              {
                projectPath: "/project",
                worktreePath: "/tree",
                branch: "agent/work",
                baseBranch: "main",
                state: "landed",
                createdAt: "2026-01-01",
              },
            ],
            locations: [
              {
                projectPath: "/project",
                projectName: "Project",
                workingDirectory: "/tree",
                sessionDirectory: "/sessions",
                resolvedSessionDirectory: "/resolved-sessions",
              },
            ],
            onCreateRuntime: () => {
              throw new Error("Must not acquire a runtime");
            },
          }),
        ),
      ),
  );

  it.effect("rejects session and source associations belonging to another project", () =>
    Effect.gen(function* () {
      for (const association of [
        { kind: "session" as const, sessionId: "session-1", title: "Other project session" },
        {
          kind: "source" as const,
          ref: "cake://session/session-1?message=report",
          title: "Other project report",
        },
      ]) {
        const failure = yield* projectTodoAssociations
          .create("/other", {
            title: "Wrong project",
            description: "Wrong project.",
            status: "",
            associations: [association],
          })
          .pipe(Effect.flip);
        assert.match(failure.message, /must belong to this Project Chat.s project/);
      }
      assert.deepEqual((yield* projectTodos.list("/project")).items, []);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("blocked user resolution leaves no Project Chat lifecycle delta", () =>
    Effect.gen(function* () {
      const failure = yield* projectSessionUserLifecycle
        .setResolved({ sessionId: "session-1" }, true)
        .pipe(Effect.result);
      assert.equal(failure._tag, "Failure");
      assert.deepEqual((yield* projectTodos.list("/project")).pending, []);
    }).pipe(Effect.provide(makeLayer(undefined, { archiveErrorSessionId: "session-1" }))),
  );

  it.effect("rejects child lifecycle requests instead of routing them to the parent", () => {
    const transitions: string[] = [];
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
      const failure = yield* projectSessionLifecycle
        .resolve({ sessionId: "session-1", workingDirectory: "/project" })
        .pipe(Effect.flip);
      assert.match(failure.message, /only session family parent parent-1/i);
      assert.deepEqual(transitions, []);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          family,
          onArchive: (sessionId) => transitions.push(`resolve:${sessionId}`),
          onRestore: (sessionId) => transitions.push(`restore:${sessionId}`),
        }),
      ),
    );
  });

  it.effect("loads resolved metadata without consulting Pi or project environments", () => {
    let piCatalogs = 0;
    let locations = 0;
    return Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
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

  it.effect("familyCatalogReadsSharedMetadataOnce", () => {
    let locationReads = 0;
    let familyReads = 0;
    const families = ["one", "two"].map((suffix) => ({
      familyId: `family-${suffix}`,
      parentSessionId: `parent-${suffix}`,
      projectPath: "/project",
      workingDirectory: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
      children: [
        {
          sessionId: `child-${suffix}`,
          parentSessionId: `parent-${suffix}`,
          requestId: `request-${suffix}`,
          workingDirectory: "/project",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const observe = projectSessionMetadata
        .observeCatalog({
          projectPath: "/project",
          resolved: false,
        })
        .pipe(Effect.flatMap((updates) => updates.pipe(Stream.take(1), Stream.runCollect)));
      const first = yield* observe.pipe(
        Effect.provideService(SessionFamilyStorage, {
          ...storage,
          state: () =>
            Effect.sync(() => {
              familyReads++;
              return { families, turns: [], spawnedSessions: [] };
            }),
          list: () => Effect.die("Catalog must use the shared family snapshot"),
          familyForMember: () => Effect.die("Known family roots need no rediscovery"),
        }),
      );
      assert.equal(first[0]?._tag, "Snapshot");
      if (first[0]?._tag !== "Snapshot") return;
      assert.deepEqual(
        first[0].sessions.map((item) => item.sessionId),
        ["parent-one", "child-one", "parent-two", "child-two"],
      );
      assert.equal(first[0].sessions[1]?.familyParentSessionId, "parent-one");
      assert.equal(first[0].sessions[1]?.familyDepth, 1);
      assert.equal(familyReads, 1);
      assert.equal(locationReads, 1);
      // A later request must reload authoritative state, not reuse a global cache.
      yield* observe.pipe(
        Effect.provideService(SessionFamilyStorage, {
          ...storage,
          state: () =>
            Effect.sync(() => {
              familyReads++;
              return { families: [], turns: [], spawnedSessions: [] };
            }),
        }),
      );
      assert.equal(familyReads, 2);
      assert.equal(locationReads, 2);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          catalog: () => Stream.empty,
          onLocations: () => locationReads++,
        }),
      ),
    );
  });

  it.effect("activeFamilyTitleOpenedOnce", () => {
    const titleReads: string[] = [];
    const item = (id: string): PiSessionSummary => ({
      id,
      title: `Title ${id}`,
      created: "2026-01-01",
      modified: "2026-01-02",
      messageCount: 0,
      resolved: false,
    });
    return Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const first = (yield* updates.pipe(Stream.take(1), Stream.runCollect))[0];
      assert.equal(first?._tag, "Snapshot");
      if (first?._tag !== "Snapshot") return;
      assert.deepEqual(
        first.sessions.map((session) => [session.sessionId, session.title]),
        [
          ["ordinary", "Title ordinary"],
          ["parent", "Title parent"],
          ["child", "Title child"],
        ],
      );
      assert.deepEqual(titleReads, ["ordinary", "parent", "child"]);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          family: {
            familyId: "family",
            parentSessionId: "parent",
            projectPath: "/project",
            workingDirectory: "/project",
            createdAt: "2026-01-01",
            children: [{ sessionId: "child", requestId: "request", createdAt: "2026-01-01" }],
          },
          catalog: (_cwd, excluded = []) =>
            Stream.fromIterable(["ordinary", "parent", "child"]).pipe(
              Stream.filter((id) => !excluded.includes(id)),
              Stream.map((id) => {
                titleReads.push(id);
                return item(id);
              }),
            ),
          catalogEntry: (_query, id) =>
            Effect.sync(() => {
              titleReads.push(id);
              return item(id);
            }),
        }),
      ),
    );
  });

  it.effect.each([false, true])(
    "filters families before opening transcripts when resolved=%s",
    (resolved) => {
      let titleReads = 0;
      let locationReads = 0;
      return Effect.gen(function* () {
        const updates = yield* projectSessionMetadata.observeCatalog({
          projectPath: "/project",
          resolved,
        });
        const first = (yield* updates.pipe(Stream.take(1), Stream.runCollect))[0];
        assert.equal(first?._tag, "Snapshot");
        assert.deepEqual(first?._tag === "Snapshot" ? first.sessions : undefined, []);
        assert.equal(titleReads, 0);
        assert.equal(locationReads, resolved ? 0 : 1);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            family: {
              familyId: "family",
              parentSessionId: "parent",
              projectPath: "/project",
              workingDirectory: "/project",
              createdAt: "2026-01-01",
              children: [],
            },
            initialResolvedSessionIds: resolved ? [] : ["parent"],
            catalog: () => Stream.empty,
            catalogEntry: () =>
              Effect.sync(() => {
                titleReads++;
                return undefined;
              }),
            onLocations: () => locationReads++,
          }),
        ),
      );
    },
  );

  it.effect("bounds existing archive titles before catalog serialization", () => {
    return Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
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
      const updates = yield* projectSessionMetadata.observeCatalog({
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
      const updates = yield* projectSessionMetadata.observeCatalog({
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
      const updates = yield* projectSessionMetadata.observeCatalog({
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
      const session = (id: string): PiSessionSummary => ({
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
        const updates = yield* projectSessionMetadata.observeCatalog({
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
    const sessions = Array.from({ length: 150 }, (_, index): PiSessionSummary => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 0,
      resolved: false,
    }));
    return Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
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

  it.effect(
    "retains a blocked recovery across catalog hydration and lookup without acquiring a runtime, then explicitly clears it",
    () => {
      let acquisitions = 0;
      const issue = "A tool was interrupted. Confirm its result before continuing.";
      return Effect.gen(function* () {
        const storage = yield* RuntimeRecoveryStorage;
        yield* storage.update({
          sessionId: "session-1",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          profile: "ProjectSession",
          transcriptPersisted: true,
          state: "blocked",
          issue,
          inputs: [],
        });
        const query = { projectPath: "/project", resolved: false };
        for (let reopen = 0; reopen < 2; reopen += 1) {
          const updates = yield* projectSessionMetadata.observeCatalog(query);
          const initial = (yield* updates.pipe(Stream.take(1), Stream.runCollect))[0];
          assert.equal(initial?._tag === "Snapshot" && initial.sessions[0]?.recoveryIssue, issue);
          assert.equal(initial?._tag === "Snapshot" && initial.sessions[0]?.running, false);
        }
        assert.equal(
          (yield* projectSessionMetadata.lookup({ sessionId: "session-1" })).recoveryIssue,
          issue,
        );
        assert.equal(acquisitions, 0);

        const received = yield* Queue.unbounded<SessionCatalogUpdate>();
        const updates = yield* projectSessionMetadata.observeCatalog(query);
        yield* updates.pipe(
          Stream.runForEach((update) => Queue.offer(received, update)),
          Effect.forkChild,
        );
        yield* Queue.take(received);
        yield* storage.remove("session-1");
        yield* (yield* SessionCatalogChanges).publish({
          _tag: "ProjectSessionActivityChanged",
          sessionId: "session-1",
          projectPath: "/project",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
        });
        const update = yield* Queue.take(received);
        assert.equal(
          update._tag === "Event" &&
            update.event._tag === "ActivityChanged" &&
            update.event.recoveryIssue,
          null,
        );
        assert.equal(
          (yield* projectSessionMetadata.lookup({ sessionId: "session-1" })).recoveryIssue,
          undefined,
        );
        assert.equal(acquisitions, 0);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            onRuntimeOptions: () => {
              acquisitions += 1;
            },
          }).pipe(Layer.provide(coordinationStorageHarness().layer)),
        ),
      );
    },
  );

  it.effect.each([
    { state: "complete", outcome: "complete" },
    { state: "failed", outcome: "failed" },
    { state: "stopped", outcome: "aborted" },
  ] as const)(
    "projects retained $state status through a fresh catalog and lookup without runtime acquisition",
    ({ state, outcome }) => {
      let acquisitions = 0;
      return Effect.gen(function* () {
        yield* (yield* RuntimeRecoveryStorage).update({
          sessionId: "session-1",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          profile: "ProjectSession",
          transcriptPersisted: true,
          state,
          inputs: [],
        });
        const query = { projectPath: "/project", resolved: false };
        const initial = (yield* (yield* projectSessionMetadata.observeCatalog(query)).pipe(
          Stream.take(1),
          Stream.runCollect,
        ))[0];
        assert.equal(
          initial?._tag === "Snapshot" && initial.sessions[0]?.latestTurnOutcome,
          outcome,
        );
        assert.equal(initial?._tag === "Snapshot" && initial.sessions[0]?.running, false);
        assert.equal(
          (yield* projectSessionMetadata.lookup({ sessionId: "session-1" })).latestTurnOutcome,
          outcome,
        );
        assert.equal(acquisitions, 0);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            onRuntimeOptions: () => {
              acquisitions += 1;
            },
          }).pipe(Layer.provide(coordinationStorageHarness().layer)),
        ),
      );
    },
  );

  it.effect("updates one catalog entry without restarting its initial scan", () => {
    let catalogScans = 0;
    return Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const application = yield* ApplicationState;
      const updates = yield* projectSessionMetadata.observeCatalog({
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

  it.effect("projects a live title before the first assistant message creates a session file", () =>
    Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const updates = yield* projectSessionMetadata.observeCatalog({
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
      yield* catalogs.publish({
        _tag: "ProjectSessionTitleChanged",
        projectPath: "/project",
        sessionId: "not-yet-persisted",
        title: "Generated title",
      });
      const observed = Array.from(yield* Fiber.join(fiber));
      assert.deepEqual(observed[1], {
        _tag: "Event",
        revision: 2,
        event: { _tag: "TitleChanged", sessionId: "not-yet-persisted", title: "Generated title" },
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "moves a resolved session in place without restarting the active metadata stream",
    () => {
      return Effect.gen(function* () {
        const updates = yield* projectSessionMetadata.observeCatalog({
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
        yield* projectSessionLifecycle.resolve({
          sessionId: "session-1",
          workingDirectory: "/project",
        });
        const observed = Array.from(yield* Fiber.join(fiber));
        assert.deepEqual(observed[1], {
          _tag: "Event",
          revision: 2,
          event: {
            _tag: "StatusChanged",
            sessionId: "session-1",
            resolved: true,
            unread: false,
          },
        });
      }).pipe(Effect.provide(makeLayer()));
    },
  );

  it.effect.each(["complete", "failed", "aborted"] as const)(
    "clears unopened family child activity when Pi stops before %s bookkeeping",
    (outcome) =>
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void, Error>();
        const started = yield* Deferred.make<void>();
        let streaming = false;
        let executingIds: string[] = [];
        let stopPi = () => undefined;
        const layer = makeLayer(undefined, {
          family: {
            familyId: "family",
            parentSessionId: "parent",
            projectPath: "/project",
            workingDirectory: "/project",
            createdAt: "2026-01-01",
            children: [{ sessionId: "session-1", requestId: "child", createdAt: "2026-01-01" }],
          },
          catalog: () => Stream.make(sessionSummary("parent"), sessionSummary("session-1")),
          runtime: (options) => {
            stopPi = () => {
              streaming = false;
              options.onEvent({ type: "streaming", sessionId: "session-1", streaming: false });
            };
            return {
              ...fakeRuntime(options),
              get streaming() {
                return streaming;
              },
              executingTurnIds: () => executingIds,
              prompt: (_text, _delivery, _attachments, _markdown, turnId) => {
                executingIds = turnId ? [turnId] : [];
                streaming = true;
                options.onEvent({ type: "streaming", sessionId: "session-1", streaming: true });
                return Effect.runPromise(
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(finished)),
                  ),
                );
              },
            };
          },
        });
        yield* Effect.gen(function* () {
          const query = { projectPath: "/project", resolved: false };
          const updates = yield* projectSessionMetadata.observeCatalog(query);
          const received = yield* Queue.unbounded<SessionCatalogUpdate>();
          yield* updates.pipe(
            Stream.runForEach((update) => Queue.offer(received, update)),
            Effect.forkChild,
          );
          const catalog = SessionCatalog.create();
          const initial = yield* Queue.take(received);
          applySessionCatalogGroupUpdate(catalog, query, initial);
          assert.equal(catalog.find("session-1")?.running, false);
          const runtimes = yield* CakeSessionRuntimes;
          const options = yield* acquireOptions({
            sessionId: "session-1",
            newSession: false,
            location: {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/project",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved",
            },
          });
          const handle = yield* runtimes.acquire(options);
          yield* handle.prompt("Work in the background");
          const accepted = yield* Queue.take(received);
          applySessionCatalogGroupUpdate(catalog, query, accepted);
          assert.equal(catalog.find("session-1")?.running, true);
          assert.equal(catalog.find("parent")?.running, false);
          // A reconnect while the child is already active must have the same indicator.
          const reconnect = yield* (yield* projectSessionMetadata.observeCatalog(query)).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(
            reconnect[0]?._tag === "Snapshot" &&
              reconnect[0].sessions.find((session) => session.sessionId === "session-1")?.running,
            true,
          );
          yield* Deferred.await(started);
          // Consume the activity notification for Pi's start, then stop Pi while
          // the accepted prompt still awaits its completion bookkeeping.
          applySessionCatalogGroupUpdate(catalog, query, yield* Queue.take(received));
          stopPi();
          applySessionCatalogGroupUpdate(catalog, query, yield* Queue.take(received));
          assert.equal(catalog.find("session-1")?.running, false);
          assert.equal((yield* handle.currentTurnIds()).length, 1);
          const idleReconnect = yield* (yield* projectSessionMetadata.observeCatalog(query)).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(
            idleReconnect[0]?._tag === "Snapshot" &&
              idleReconnect[0].sessions.find((session) => session.sessionId === "session-1")
                ?.running,
            false,
          );
          if (outcome === "complete") yield* Deferred.succeed(finished, undefined);
          else
            yield* Deferred.fail(
              finished,
              outcome === "aborted" ? new TurnCanceledError("Canceled") : new Error("Model failed"),
            );
          const settled = yield* Queue.take(received);
          applySessionCatalogGroupUpdate(catalog, query, settled);
          assert.equal(catalog.find("session-1")?.running, false);
          catalog[Symbol.dispose]();
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("streams Project and Working Directory metadata above CakeSessionRuntimes", () =>
    Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
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

  it.effect("tool-compacts without changing session identity or Fast mode", () => {
    let runtimeConstructions = 0;
    let compacted = false;
    return Effect.gen(function* () {
      const result = yield* projectSessionContinuations.toolCompact({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
      });
      assert.equal(result.sessionId, "session-1");
      assert.equal(compacted, true);
      assert.equal(runtimeConstructions, 1);
      const state = yield* getState();
      assert.deepEqual(state.fastModeSessionIds, ["session-1"]);
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
          {
            onCreateRuntime: () => runtimeConstructions++,
            onToolCompact: () => {
              compacted = true;
            },
          },
        ),
      ),
    );
  });

  it.effect("announces a prompted tool compaction once", () => {
    const changes: SessionCatalogChange[] = [];
    return Effect.gen(function* () {
      yield* projectSessionContinuations.toolCompact({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
        prompt: "Continue",
      });

      assert.equal(
        changes.filter(
          (change) => change._tag === "ProjectSessionChanged" && change.sessionId === "session-1",
        ).length,
        1,
      );
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          onCatalogChange: (change) => changes.push(change),
        }),
      ),
    );
  });

  it.effect("gives forks the next numbered copy title", () => {
    let forkTitle: string | undefined;
    const activeCatalogs: string[] = [];
    const resolvedCatalogs: string[] = [];
    const catalogEntry = (id: string, title: string): PiSessionSummary => ({
      id,
      title,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 2,
      resolved: false,
    });

    return Effect.gen(function* () {
      yield* projectSessionContinuations.fork({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
      });

      assert.equal(forkTitle, "Renamed source (3)");
      const items = (yield* projectTodos.list("/project")).items;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.title, forkTitle);
      assert.deepEqual(items[0]?.associations, [
        { kind: "session", sessionId: "forked", title: forkTitle },
      ]);
      assert.deepEqual(activeCatalogs, ["/project"]);
      assert.deepEqual(resolvedCatalogs, ["/project"]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          catalog: () =>
            Stream.fromIterable([
              catalogEntry("unrelated-title", "Unrelated title"),
              catalogEntry("fork-1", "Renamed source (1)"),
            ]),
          resolvedCatalog: () => Stream.make(catalogEntry("fork-2", "Renamed source (2)")),
          catalogTitle: () => "Renamed source",
          onCatalog: (workingDirectory) => activeCatalogs.push(workingDirectory),
          onResolvedCatalog: (workingDirectory) => resolvedCatalogs.push(workingDirectory),
          worktreeRecords: [
            {
              projectPath: "/project",
              worktreePath: "/project-worktree",
              branch: "agent/unrelated",
              baseBranch: "main",
              createdAt: "2026-01-01T00:00:00.000Z",
              state: "active",
            },
          ],
          onForkTitle: (title) => {
            forkTitle = title;
          },
        }),
      ),
    );
  });

  it.effect("uses the agent fork title and continuation prompt for its linked to-do", () =>
    Effect.gen(function* () {
      yield* projectSessionContinuations.fork({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
        title: "Implement startup fix",
        prompt: "Implement the measured startup improvement and verify it.",
      });
      const [item] = (yield* projectTodos.list("/project")).items;
      assert.equal(item?.title, "Implement startup fix");
      assert.equal(item?.description, "Implement the measured startup improvement and verify it.");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("associates only the fork runtime's reachable artifact revisions", () => {
    const pointer: ArtifactPointer = {
      protocol: "cake.artifact/v1",
      lineageId: "artifact-before-entry",
      revision: 2,
      kind: "table",
      digest: "a".repeat(64),
      stableRef: "cake://artifact/artifact-before-entry",
      exactRef: "cake://artifact/artifact-before-entry@r2",
    };
    let inherited: ReadonlyArray<ArtifactPointer> | undefined;
    let link: ArtifactLink | undefined;

    return Effect.gen(function* () {
      yield* projectSessionContinuations.fork({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
      });

      assert.deepEqual(inherited, [pointer]);
      assert.deepEqual(link?.target, { type: "session", sessionId: "forked" });
      assert.deepEqual(link?.selection, { mode: "pinned", revision: 2 });
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          forkArtifactPointers: [pointer],
          onArtifactLink: (createdLink) => {
            link = createdLink;
          },
          onInheritFork: (
            sourceWorkingDirectory,
            sourceSessionId,
            destinationWorkingDirectory,
            destinationSessionId,
            pointers,
          ) => {
            assert.equal(sourceWorkingDirectory, "/project");
            assert.equal(sourceSessionId, "session-1");
            assert.equal(destinationWorkingDirectory, "/project");
            assert.equal(destinationSessionId, "forked");
            inherited = pointers;
          },
        }),
      ),
    );
  });

  it.effect("keeps a fork from a family member standalone with exact pinned links", () => {
    const pointer: ArtifactPointer = {
      protocol: "cake.artifact/v1",
      lineageId: "family-artifact",
      revision: 3,
      kind: "markdown",
      digest: "b".repeat(64),
      stableRef: "cake://artifact/family-artifact",
      exactRef: "cake://artifact/family-artifact@r3",
    };
    let inherited: ReadonlyArray<ArtifactPointer> | undefined;
    let link: ArtifactLink | undefined;

    return Effect.gen(function* () {
      const result = yield* projectSessionContinuations.fork({
        target: { sessionId: "session-1", workingDirectory: "/project" },
        entryId: "assistant-entry",
      });

      assert.equal(result.sessionId, "forked");
      assert.deepEqual(inherited, [pointer]);
      assert.deepEqual(link?.target, { type: "session", sessionId: "forked" });
      assert.deepEqual(link?.selection, { mode: "pinned", revision: 3 });
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family: {
            familyId: "family-1",
            parentSessionId: "session-1",
            projectPath: "/project",
            workingDirectory: "/project",
            createdAt: "2026-01-01T00:00:00.000Z",
            children: [
              {
                sessionId: "child",
                requestId: "request-child",
                createdAt: "2026-01-01T00:00:01.000Z",
              },
            ],
          },
          forkArtifactPointers: [pointer],
          onArtifactLink: (createdLink) => {
            link = createdLink;
          },
          onInheritFork: (_sourcePath, _sourceId, _destinationPath, destinationId, pointers) => {
            assert.equal(destinationId, "forked");
            inherited = pointers;
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
      const copy = vi
        .spyOn(projectSessionLocations, "forkToWorkingDirectory")
        .mockImplementation((input) =>
          Effect.sync(() => {
            assert.equal(input.source.sessionDirectory, "/sessions");
            assert.equal(input.destination.sessionDirectory, "/sessions");
            return {
              sessionId: "forked",
              sessionFile: "/sessions/forked.jsonl",
              artifactPointers: [],
            };
          }),
        );
      return Effect.gen(function* () {
        const target = { sessionId: "session-1", workingDirectory: "/project" };
        const result = yield* projectSessionContinuations.fork({
          target,
          entryId: "assistant-entry",
        });
        const source = yield* projectSessionMetadata.inspect(target);

        assert.equal(result.sessionId, "forked");
        assert.equal(source.resolved, true);
        assert.equal(runtimeConstructions, 0);
        assert.equal(restores, 0);
        assert.equal(archives, 0);
        assert.equal(copy.mock.calls.length, 1);
      }).pipe(
        Effect.ensuring(Effect.sync(() => copy.mockRestore())),
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

  it.effect("restores a resolved session before tool compaction", () => {
    let runtimeConstructions = 0;
    let restores = 0;
    return Effect.gen(function* () {
      const target = { sessionId: "session-1", workingDirectory: "/project" };
      const result = yield* projectSessionContinuations.toolCompact({
        target,
        entryId: "assistant-entry",
      });
      const source = yield* projectSessionMetadata.inspect(target);

      assert.equal(result.sessionId, "session-1");
      assert.equal(source.resolved, false);
      assert.equal(runtimeConstructions, 1);
      assert.equal(restores, 1);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          resolvedOnDisk: true,
          onCreateRuntime: () => runtimeConstructions++,
          onRestore: () => restores++,
        }),
      ),
    );
  });

  it.effect("maps restore location failures to the restore operation", () =>
    Effect.gen(function* () {
      const failure = yield* projectSessionLifecycle
        .restore({ sessionId: "missing", workingDirectory: "/missing" })
        .pipe(Effect.flip);
      assert.equal(failure.operation, "restore");
      assert.match(failure.message, /could not find Project Session missing/);
    }).pipe(Effect.provide(makeLayer(undefined, { sessionExists: false }))),
  );

  it.effect("resolves a located idle session without constructing a Pi runtime", () => {
    let runtimeConstructions = 0;
    let archives = 0;
    return Effect.gen(function* () {
      yield* projectSessionLifecycle.resolve({
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
    "resolves multiple standalone sessions from IDs and publishes one coherent transition",
    () => {
      const archived: string[] = [];
      const changes: SessionCatalogChange[] = [];
      let idScans = 0;
      let catalogScans = 0;
      return Effect.gen(function* () {
        const result = yield* projectSessionLifecycle.resolveWorkingDirectory("/worktree");
        assert.equal(result.projectPath, "/project");
        assert.deepEqual(result.resolvedSessionIds, ["worktree-1", "worktree-2"]);
        assert.deepEqual(result.failures, []);
        assert.deepEqual(archived, ["worktree-1", "worktree-2"]);
        assert.equal(idScans, 1);
        assert.equal(catalogScans, 0);
        assert.deepEqual(changes, [
          {
            _tag: "ProjectSessionsTransitioned",
            sessions: [
              { sessionId: "worktree-1", workingDirectory: "/worktree" },
              { sessionId: "worktree-2", workingDirectory: "/worktree" },
            ],
            projectPath: "/project",
            resolved: true,
          },
        ]);
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
            sessionIds: (workingDirectory) =>
              workingDirectory === "/worktree"
                ? Stream.fromIterable(["worktree-1", "worktree-2"])
                : Stream.make("other-1"),
            onSessionIds: () => idScans++,
            onCatalog: () => catalogScans++,
            onCatalogChange: (change) => changes.push(change),
            onArchive: (sessionId) => archived.push(sessionId),
          }),
        ),
      );
    },
  );

  it.effect(
    "publishes standalone batch committed IDs even when the last checkout cleanup fails",
    () => {
      const changes: SessionCatalogChange[] = [];
      return Effect.gen(function* () {
        const result = yield* projectSessionLifecycle.resolveWorkingDirectory("/worktree");
        assert.deepEqual(result.resolvedSessionIds, ["first", "second"]);
        assert.deepEqual(result.failures, []);
        assert.equal(result.cleanupFailures.length, 1);
        assert.deepEqual(result.cleanupFailures[0]?.resolvedSessionIds, ["second"]);
        assert.deepEqual(changes, [
          {
            _tag: "ProjectSessionsTransitioned",
            projectPath: "/project",
            sessions: [
              { sessionId: "first", workingDirectory: "/worktree" },
              { sessionId: "second", workingDirectory: "/worktree" },
            ],
            resolved: true,
          },
        ]);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            locations: [
              {
                projectPath: "/project",
                projectName: "Project",
                workingDirectory: "/worktree",
                sessionDirectory: "/sessions",
                resolvedSessionDirectory: "/resolved-sessions",
              },
            ],
            worktreeRecords: [
              {
                projectPath: "/project",
                worktreePath: "/worktree",
                branch: "agent/work",
                baseBranch: "main",
                state: "landed",
                createdAt: "2026-01-01",
              },
            ],
            sessionIds: () => Stream.make("first", "second"),
            catalog: () => Stream.make(sessionSummary("first"), sessionSummary("second")),
            cleanupFailure: true,
            onCatalogChange: (change) => changes.push(change),
          }),
        ),
      );
    },
  );

  it.effect("resolves a family by archiving only its root", () => {
    const events: string[] = [];
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
    return Effect.gen(function* () {
      const result = yield* projectSessionLifecycle.resolveWorkingDirectory("/project");
      assert.deepEqual(result.resolvedSessionIds, ["parent", "child"]);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(events, ["archive:parent"]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family,
          sessionIds: () => Stream.fromIterable(["child", "parent"]),
          onArchive: (sessionId) => events.push(`archive:${sessionId}`),
        }),
      ),
    );
  });

  it.effect("publishes one active-catalog removal for a resolved Session Family", () => {
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
    const session = (id: string): PiSessionSummary => ({
      id,
      title: id,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      messageCount: 1,
      resolved: false,
    });
    return Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const ready = yield* Deferred.make<void>();
      const fiber = yield* updates.pipe(
        Stream.tap((update) =>
          update._tag === "Snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);

      yield* projectSessionLifecycle.resolve({ sessionId: "parent" });

      const observed = Array.from(yield* Fiber.join(fiber));
      assert.equal(observed[1]?._tag, "Event");
      if (observed[1]?._tag !== "Event") return;
      assert.deepEqual(observed[1].event, {
        _tag: "RemovedBatch",
        sessionIds: ["parent", "child"],
      });
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family,
          catalog: () => Stream.fromIterable([session("parent"), session("child")]),
        }),
      ),
    );
  });

  it.effect("restores legacy child storage before making the root active", () => {
    const events: string[] = [];
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
    return projectSessionLifecycle.restore({ sessionId: "parent" }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(events, ["restore:child", "restore:parent"]);
        }),
      ),
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family,
          initialResolvedSessionIds: ["parent", "child"],
          onRestore: (sessionId) => events.push(`restore:${sessionId}`),
        }),
      ),
    );
  });

  it.effect("resolving an already archived root never synchronizes child namespaces", () => {
    const archived: string[] = [];
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
    return projectSessionLifecycle.resolve({ sessionId: "parent" }).pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          assert.deepEqual(archived, []);
          assert.deepEqual((yield* getState()).unreadSessionIds, []);
        }),
      ),
      Effect.provide(
        makeLayer(
          { ...defaultApplicationState(), unreadSessionIds: ["parent"] },
          {
            family,
            initialResolvedSessionIds: ["parent"],
            onArchive: (sessionId) => archived.push(sessionId),
          },
        ),
      ),
    );
  });

  it.effect("publishes only the root authority when restoring a family", () => {
    const changes: SessionCatalogChange[] = [];
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
    return projectSessionLifecycle.restore({ sessionId: "parent" }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(changes, [
            {
              _tag: "ProjectSessionsTransitioned",
              sessions: [{ sessionId: "parent", workingDirectory: "/project" }],
              projectPath: "/project",
              resolved: false,
            },
          ]);
        }),
      ),
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family,
          initialResolvedSessionIds: ["child"],
          onCatalogChange: (change) => changes.push(change),
        }),
      ),
    );
  });

  it.effect(
    "resolution preserves owned worker history, while explicit parent deletion removes only that ownership",
    () => {
      const deleted: string[] = [];
      return Effect.gen(function* () {
        const storage = (yield* SubagentCoordinator).storage;
        const owned = subagentHistoryFixture();
        const unrelated = subagentHistoryFixture({
          handleId: Schema.decodeUnknownSync(subagentsHandleId)(
            "00000000-0000-4000-8000-000000000002",
          ),
          privateSessionId: "other-private",
          parentSessionId: "other-parent",
        });
        yield* storage.history.update(owned);
        yield* storage.history.update(unrelated);
        yield* projectSessionLifecycle.resolve({ sessionId: "session-1" });
        assert.equal((yield* storage.history.list()).length, 2);
        assert.deepEqual(deleted, []);
        yield* projectSessionLifecycle.deleteResolved("session-1");
        assert.deepEqual(yield* storage.history.list(), [unrelated]);
        assert.deepEqual(deleted, ["session-1", owned.privateSessionId]);
      }).pipe(Effect.provide(makeLayer(undefined, { onDeleteArchive: (id) => deleted.push(id) })));
    },
  );

  it.effect(
    "project deletion cleans released workers owned by both active and resolved parents",
    () => {
      const deleted: string[] = [];
      return Effect.gen(function* () {
        const storage = (yield* SubagentCoordinator).storage;
        const owned = subagentHistoryFixture();
        const resolved = subagentHistoryFixture({
          handleId: Schema.decodeUnknownSync(subagentsHandleId)(
            "00000000-0000-4000-8000-000000000002",
          ),
          privateSessionId: "resolved-private",
          parentSessionId: "resolved-parent",
        });
        yield* storage.history.update(owned);
        yield* storage.history.update(resolved);
        yield* projectSessionLifecycle.deleteProjectSessions("/project", []);
        assert.deepEqual(yield* storage.history.list(), []);
        assert.ok(deleted.includes(owned.privateSessionId));
        assert.ok(deleted.includes(resolved.privateSessionId));
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            initialResolvedSessionIds: ["resolved-parent"],
            resolvedProjectEntries: [
              { sessionId: "resolved-parent", modifiedAt: "2026-01-02T00:00:00.000Z" },
            ],
            onDeleteArchive: (id) => deleted.push(id),
          }),
        ),
      );
    },
  );

  it.effect("preserves direct artifact links when resolved transcript deletion fails", () => {
    const removedArtifactTargets: ArtifactLinkTarget[] = [];
    let garbageCollections = 0;
    return Effect.gen(function* () {
      const workers = (yield* SubagentCoordinator).storage;
      const owned = subagentHistoryFixture();
      yield* workers.history.update(owned);
      const failure = yield* projectSessionLifecycle.deleteResolved("session-1").pipe(Effect.flip);
      assert.match(failure.message, /Cannot delete session-1/);
      assert.deepEqual(yield* workers.history.list(), [owned]);
      assert.deepEqual(removedArtifactTargets, []);
      assert.equal(garbageCollections, 0);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          resolvedOnDisk: true,
          archiveDeleteErrorSessionId: "session-1",
          onRemoveArtifactTarget: (target) => removedArtifactTargets.push(target),
          onArtifactGarbageCollection: () => garbageCollections++,
        }),
      ),
    );
  });

  it.effect("preserves family artifact links when family metadata deletion fails", () => {
    const removedArtifactTargets: ArtifactLinkTarget[] = [];
    let garbageCollections = 0;
    return Effect.gen(function* () {
      const failure = yield* projectSessionLifecycle
        .deleteProjectSessions("/project", [])
        .pipe(Effect.flip);
      assert.match(failure.message, /Cannot remove families for \/project/);
      assert.deepEqual(removedArtifactTargets, []);
      assert.equal(garbageCollections, 0);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          sessionExists: false,
          familyRemovalError: true,
          family: {
            familyId: "family-1",
            parentSessionId: "parent",
            projectPath: "/project",
            workingDirectory: "/project",
            createdAt: "2026-01-01T00:00:00.000Z",
            children: [],
          },
          onRemoveArtifactTarget: (target) => removedArtifactTargets.push(target),
          onArtifactGarbageCollection: () => garbageCollections++,
        }),
      ),
    );
  });

  it.effect("cleans session and family links only after their authorities commit", () => {
    const lifecycleOrder: string[] = [];
    return projectSessionLifecycle.deleteProjectSessions("/project", []).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(lifecycleOrder, [
            "session-authority:session-1",
            "session-link:session-1",
            "gc",
            "family-authority",
            "family-link:family-1",
            "gc",
          ]);
        }),
      ),
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          family: {
            familyId: "family-1",
            parentSessionId: "parent",
            projectPath: "/project",
            workingDirectory: "/project",
            createdAt: "2026-01-01T00:00:00.000Z",
            children: [],
          },
          onDeleteArchive: (sessionId) => lifecycleOrder.push(`session-authority:${sessionId}`),
          onRemoveArtifactTarget: (target) =>
            lifecycleOrder.push(
              target.type === "session"
                ? `session-link:${target.sessionId}`
                : `family-link:${target.familyId}`,
            ),
          onRemoveFamilyProject: () => lifecycleOrder.push("family-authority"),
          onArtifactGarbageCollection: () => lifecycleOrder.push("gc"),
        }),
      ),
    );
  });

  it.effect("requests conservative cleanup when link removal fails after deletion commits", () => {
    const lifecycleOrder: string[] = [];
    return Effect.gen(function* () {
      const failure = yield* projectSessionLifecycle.deleteResolved("session-1").pipe(Effect.flip);
      assert.match(failure.message, /Cannot remove artifact links/);
      assert.deepEqual(lifecycleOrder, ["session-authority", "link-cleanup-attempt", "gc"]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          resolvedOnDisk: true,
          onDeleteArchive: () => lifecycleOrder.push("session-authority"),
          artifactRemovalFails: (target) => {
            if (target.type === "session") lifecycleOrder.push("link-cleanup-attempt");
            return target.type === "session";
          },
          onArtifactGarbageCollection: () => lifecycleOrder.push("gc"),
        }),
      ),
    );
  });

  it.effect("reports partial Working Directory resolution failures and batches successes", () => {
    const archived: string[] = [];
    const changes: SessionCatalogChange[] = [];
    return Effect.gen(function* () {
      const result = yield* projectSessionLifecycle.resolveWorkingDirectory("/project");
      assert.deepEqual(result.resolvedSessionIds, ["session-1"]);
      assert.deepEqual(result.failures, [
        { sessionIds: ["session-2"], message: "Cannot archive session-2" },
      ]);
      assert.deepEqual(archived, ["session-1"]);
      assert.deepEqual(changes, [
        {
          _tag: "ProjectSessionsTransitioned",
          sessions: [{ sessionId: "session-1", workingDirectory: "/project" }],
          projectPath: "/project",
          resolved: true,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer(defaultApplicationState(), {
          sessionIds: () => Stream.fromIterable(["session-1", "session-2"]),
          archiveErrorSessionId: "session-2",
          onArchive: (sessionId) => archived.push(sessionId),
          onCatalogChange: (change) => changes.push(change),
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
      yield* projectSessionLifecycle.resolve({
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
      yield* projectSessionLifecycle.resolve({
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
      yield* projectSessionLifecycle.restore({
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

  for (const legacyActiveTranscript of [false, true]) {
    it.effect(
      `reopens and sends after landed checkout cleanup${legacyActiveTranscript ? " with an already-reactivated transcript" : ""}`,
      () => {
        const events: string[] = [];
        const prompted = Deferred.makeUnsafe<void>();
        const records: WorktreeRecord[] = [
          {
            projectPath: "/project",
            worktreePath: "/worktree",
            branch: "agent/finished",
            baseBranch: "main",
            state: "landed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ];
        let resolved = false;
        const target = { sessionId: "session-1", workingDirectory: "/worktree" };
        return Effect.gen(function* () {
          yield* projectSessionLifecycle.resolve(target);
          assert.equal(records[0]?.state, "resolved");
          assert.deepEqual(events, ["archive", "cleanup"]);
          if (legacyActiveTranscript) {
            // Reproduce the old send path: transcript restored, checkout still retired.
            yield* projectSessionLocations.restore(
              target.sessionId,
              yield* projectSessionMetadata.findLocation(target),
            );
          }
          events.length = 0;

          // Exact-ID routing and a fresh catalog must work without an existing
          // runtime or renderer cache, including the older partial-restore state.
          const lookup = yield* projectSessionMetadata.lookup({ sessionId: target.sessionId });
          assert.equal(lookup.workingDirectory, "/worktree");
          assert.equal(lookup.resolved, !legacyActiveTranscript);
          yield* projectSessionMetadata.open({ sessionId: target.sessionId });
          const updates = yield* projectSessionMetadata.observeCatalog({
            projectPath: "/project",
            resolved: !legacyActiveTranscript,
          });
          const [initial] = yield* updates.pipe(Stream.take(1), Stream.runCollect);
          assert.equal(initial?._tag, "Snapshot");
          if (initial?._tag === "Snapshot")
            assert.deepEqual(
              initial.sessions.map((item) => item.sessionId),
              [target.sessionId],
            );
          assert.equal(events.length, 0); // Merely opening never recreates a checkout.

          if (legacyActiveTranscript) {
            const observation = yield* projectSessionOperations.observeConversation(target);
            yield* observation.pipe(
              Stream.filter((update) => update._tag === "Snapshot"),
              Stream.take(1),
              Stream.runDrain,
              Effect.scoped,
            );
            assert.deepEqual(events.slice(0, 2), ["checkout", "runtime"]);
            events.length = 0;
          }
          yield* projectSessionOperations
            .sendAutomatically({
              ...target,
              text: "Continue",
              attachments: [],
              renderUserMessageAsMarkdown: false,
            })
            .pipe(Effect.scoped);
          if (!legacyActiveTranscript)
            assert.deepEqual(events.slice(0, 3), ["checkout", "transcript", "runtime"]);
          yield* Deferred.await(prompted);
          assert.equal(records[0]?.state, "landed");
          assert.equal(resolved, false);
          assert.ok(events.includes("prompt"));
          // A subsequent cold open/observation uses the same ID, cwd and history.
          yield* projectSessionMetadata.open({ sessionId: target.sessionId });
          const observation = yield* projectSessionOperations.observeConversation(target);
          const [reopened] = yield* observation.pipe(Stream.take(1), Stream.runCollect);
          assert.equal(reopened?._tag, "Preview");
          if (reopened?._tag === "Preview") {
            assert.equal(reopened.snapshot.sessionId, target.sessionId);
            assert.deepEqual(reopened.snapshot.parts, snapshot.parts.map(toJsonValue));
          }
          const missing = yield* projectSessionMetadata
            .lookup({ sessionId: "missing" })
            .pipe(Effect.flip);
          assert.match(missing.message, /could not find Project Session missing/);
        }).pipe(
          Effect.provide(
            makeLayer(undefined, {
              worktreeRecords: records,
              locations: [
                {
                  projectPath: "/project",
                  projectName: "Project",
                  workingDirectory: "/worktree",
                  sessionDirectory: "/sessions",
                  resolvedSessionDirectory: "/resolved-sessions",
                },
              ],
              locate: (id, location) =>
                Effect.succeed(
                  id === target.sessionId && location.cwd === "/worktree"
                    ? resolved
                      ? "resolved"
                      : "active"
                    : undefined,
                ),
              catalog: (cwd) =>
                cwd === "/worktree" ? Stream.make(sessionSummary(target.sessionId)) : Stream.empty,
              onArchive: () => {
                resolved = true;
                events.push("archive");
              },
              onCleanupResolved: () => {
                const record = records[0];
                assert.ok(record);
                records.splice(0, 1, { ...record, state: "resolved", resolvedFrom: "landed" });
                events.push("cleanup");
              },
              onRestoreResolved: () => {
                const record = records[0];
                assert.ok(record);
                records.splice(0, 1, { ...record, state: "landed" });
                events.push("checkout");
              },
              onRestore: () => {
                resolved = false;
                events.push("transcript");
              },
              onRuntimeOptions: (newSession) => {
                assert.equal(newSession, false);
                assert.equal(records[0]?.state, "landed");
                events.push("runtime");
              },
              onOperation: (operation) => events.push(operation),
              prompt: () =>
                Effect.runPromise(Deferred.succeed(prompted, undefined)).then(() => undefined),
            }),
          ),
        );
      },
    );
  }

  it.effect("keeps a cleaned-up session resolved when implicit checkout restoration fails", () => {
    let transcriptRestores = 0;
    let runtimes = 0;
    return Effect.gen(function* () {
      const worktrees = yield* ManagedWorktrees;
      const failure = yield* projectSessionOperations
        .sendAutomatically({
          sessionId: "session-1",
          workingDirectory: "/worktree",
          text: "Continue",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        })
        .pipe(
          Effect.provideService(ManagedWorktrees, {
            ...worktrees,
            restoreResolved: () =>
              Effect.fail(
                new ManagedWorktreeError({
                  operation: "restoreResolved",
                  message: "Cannot restore checkout",
                }),
              ),
          }),
          Effect.flip,
        );
      assert.match(failure.message, /Cannot restore checkout/);
      assert.equal(
        (yield* projectSessionMetadata.lookup({ sessionId: "session-1" })).resolved,
        true,
      );
      assert.equal(transcriptRestores, 0);
      assert.equal(runtimes, 0);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          resolvedOnDisk: true,
          worktreeRecords: [
            {
              projectPath: "/project",
              worktreePath: "/worktree",
              branch: "agent/finished",
              baseBranch: "main",
              state: "resolved",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          locations: [
            {
              projectPath: "/project",
              projectName: "Project",
              workingDirectory: "/worktree",
              sessionDirectory: "/sessions",
              resolvedSessionDirectory: "/resolved-sessions",
            },
          ],
          onRestore: () => transcriptRestores++,
          onCreateRuntime: () => runtimes++,
        }),
      ),
    );
  });

  it.effect("resolves a session from an inactive Managed Worktree location", () => {
    let archives = 0;
    return Effect.gen(function* () {
      yield* projectSessionLifecycle.resolve({
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

  for (const workingDirectory of ["/project", "/worktree"]) {
    it.effect(
      `observes a running session after project trust changes in ${workingDirectory}`,
      () => {
        let creations = 0;
        let disposals = 0;
        const reloadTrust: boolean[] = [];
        const operations: string[] = [];
        const started = Deferred.makeUnsafe<void>();
        const followUpStarted = Deferred.makeUnsafe<void>();
        let promptCount = 0;
        const finish = Deferred.makeUnsafe<void>();
        const location: ProjectSessionLocation = {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory,
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
          ...(workingDirectory === "/worktree"
            ? {
                managedWorktree: {
                  projectPath: "/project",
                  worktreePath: workingDirectory,
                  branch: "agent/existing",
                  baseBranch: "main",
                  state: "active" as const,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              }
            : {}),
        };
        return Effect.gen(function* () {
          const application = yield* ApplicationState;
          const sessions = yield* CakeSessionRuntimes;
          const initialOptions = yield* acquireOptions({
            location,
            sessionId: "session-1",
            newSession: false,
          });
          assert.equal(initialOptions.runtime.trusted, false);
          const first = yield* sessions.acquire(initialOptions);
          const running = yield* first.prompt("Keep working");
          yield* Deferred.await(started);
          const queued = yield* first.followUp("Then check the result");
          yield* Deferred.await(followUpStarted);
          const before = yield* first.snapshot();
          assert.equal(before.workspacePath, workingDirectory);
          const queueBefore = yield* first.listQueuedMessages();
          const recoveryBefore = yield* (yield* RuntimeRecoveryStorage).get("session-1");

          for (const trusted of [true, false]) {
            yield* application.transact((state) =>
              Effect.succeed({ ...state, trustedProjectPaths: trusted ? ["/project"] : [] }),
            );
            const options = yield* acquireOptions({
              location,
              sessionId: "session-1",
              newSession: false,
            });
            assert.equal(options.runtime.trusted, trusted);
            // Exercise the actual regular Project Session observer, not just acquireSession.
            const stream = yield* projectSessionOperations.observeConversation({
              sessionId: "session-1",
              workingDirectory,
            });
            const [update] = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.scoped);
            assert.equal(update?._tag, "Snapshot");
            if (update?._tag === "Snapshot") {
              assert.equal(update.snapshot.sessionId, before.sessionId);
              assert.deepEqual(update.snapshot.parts, before.parts.map(toJsonValue));
              assert.equal(update.snapshot.streaming, true);
            }
            // Existing command/observer options must consult live policy, not reverse it.
            assert.equal(initialOptions.runtime.projectTrust?.(), trusted);
            yield* sessions.acquire(initialOptions);
            assert.deepEqual(yield* first.currentTurnIds(), [running, queued]);
            assert.deepEqual(yield* first.listQueuedMessages(), queueBefore);
            assert.deepEqual(
              yield* (yield* RuntimeRecoveryStorage).get("session-1"),
              recoveryBefore,
            );
            assert.equal(creations, 1);
            assert.equal(disposals, 0);
          }
          assert.deepEqual(reloadTrust, [true, false]);
          const conflict = yield* sessions
            .acquire({
              ...initialOptions,
              runtime: { ...initialOptions.runtime, tools: ["read"] },
            })
            .pipe(Effect.flip);
          assert.match(conflict.message, /conflicting runtime options/);
          assert.ok(!operations.includes("abort"));
          assert.ok(!operations.includes("clear-queue"));
          const listening = yield* Deferred.make<void>();
          const settled = yield* first.updates.pipe(
            Stream.tap((update) =>
              update._tag === "Snapshot" ? Deferred.succeed(listening, undefined) : Effect.void,
            ),
            Stream.filter(
              (update) => update._tag === "Event" && update.event.type === "turn-settled",
            ),
            Stream.take(2),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* Deferred.await(listening);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(settled);
        }).pipe(
          Effect.provide(
            makeLayer(
              { ...defaultApplicationState(), trustedProjectPaths: [] },
              {
                locations: [location],
                runtime: (options) => {
                  creations += 1;
                  return {
                    ...fakeRuntime(
                      options,
                      () =>
                        Effect.runPromise(
                          Deferred.succeed(
                            promptCount++ === 0 ? started : followUpStarted,
                            undefined,
                          ).pipe(Effect.andThen(Deferred.await(finish))),
                        ),
                      undefined,
                      undefined,
                      undefined,
                      (operation) => operations.push(operation),
                      [],
                      () => disposals++,
                    ),
                    streaming: true,
                    snapshot: async () => ({
                      ...snapshot,
                      workspacePath: workingDirectory,
                      streaming: true,
                    }),
                    listQueuedMessages: async () => ({
                      steering: [],
                      followUp: ["Then check the result"],
                    }),
                    reload: async () => {
                      reloadTrust.push(options.projectTrust?.() ?? options.trusted);
                    },
                  };
                },
              },
            ),
          ),
        );
      },
    );
  }

  it.effect(
    "observation retains a command-only new identity across start, commands, and its first message",
    () => {
      let creations = 0;
      let disposals = 0;
      const inputs: string[] = [];
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const settled = yield* Queue.unbounded<void>();
        const stream = yield* projectSessionOperations.observeConversation(
          { sessionId: "session-1", workingDirectory: "/project" },
          true,
        );
        const observation = yield* stream.pipe(
          Stream.runForEach((update) =>
            update._tag === "Snapshot"
              ? Deferred.succeed(ready, undefined)
              : update._tag === "Event" && update.event._tag === "TurnSettled"
                ? Queue.offer(settled, undefined)
                : Effect.void,
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* projectSessionOperations
          .start({
            sessionId: "session-1",
            workingDirectory: "/project",
            text: "/mcp",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          })
          .pipe(Effect.scoped);
        yield* Queue.take(settled);
        for (const text of ["/mcp login fixture", "First normal message"]) {
          yield* sessionChats
            .deliver(
              { sessionId: "session-1", text, attachments: [], renderUserMessageAsMarkdown: false },
              "prompt",
            )
            .pipe(Effect.scoped);
          yield* Queue.take(settled);
        }
        assert.deepEqual(inputs, ["/mcp", "/mcp login fixture", "First normal message"]);
        assert.equal(creations, 1);
        assert.equal(disposals, 0);
        yield* Fiber.interrupt(observation);
        assert.equal(disposals, 1);
        // Leaving and later reopening follows scoped observation policy: no
        // leaked lease and a known still-unpersisted identity can start again.
        const reopened = yield* projectSessionOperations.observeConversation(
          { sessionId: "session-1", workingDirectory: "/project" },
          true,
        );
        const updates = yield* reopened.pipe(Stream.take(1), Stream.runCollect);
        assert.equal(updates[0]?._tag, "Snapshot");
        if (updates[0]?._tag === "Snapshot") assert.deepEqual(updates[0].snapshot.parts, []);
        assert.equal(creations, 2);
        assert.equal(disposals, 2);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            sessionExists: false,
            runtime: (options) => {
              creations += 1;
              return {
                ...fakeRuntime(options),
                snapshot: async () => ({ ...snapshot, parts: [], sessionListed: false }),
                prompt: async (text) => {
                  inputs.push(text);
                },
                dispose: async () => {
                  disposals += 1;
                },
              };
            },
          }),
        ),
      );
    },
  );

  it.effect(
    "new command observation waits for checkout setup rather than inspecting a nonexistent transcript",
    () =>
      Effect.gen(function* () {
        const setupEntered = yield* Deferred.make<void>();
        const setupReady = yield* Deferred.make<void>();
        let created = 0;
        let inspected = 0;
        yield* Effect.gen(function* () {
          const updates = yield* projectSessionOperations.observeConversation(
            { sessionId: "session-1", workingDirectory: "/project" },
            true,
          );
          const observation = yield* updates.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Deferred.await(setupEntered);
          assert.equal(created, 0);
          assert.equal(inspected, 0);
          yield* Deferred.succeed(setupReady, undefined);
          const result = yield* Fiber.join(observation);
          assert.equal(result[0]?._tag, "Snapshot");
          assert.equal(created, 1);
          assert.equal(inspected, 0);
        }).pipe(
          Effect.provide(
            makeLayer(undefined, {
              sessionExists: false,
              deferredWorktreeSetup: Deferred.succeed(setupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(setupReady)),
              ),
              onCreateRuntime: () => {
                created += 1;
              },
              onInspect: () => {
                inspected += 1;
              },
            }),
          ),
        );
      }),
  );

  it.effect(
    "a known new identity reopens Pi's persisted transcript rather than creating an empty replacement",
    () => {
      const modes: boolean[] = [];
      return Effect.gen(function* () {
        const stream = yield* projectSessionOperations.observeConversation(
          { sessionId: "session-1" },
          true,
        );
        const updates = yield* stream.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(modes, [false]);
        assert.deepEqual(
          updates.map((update) => update._tag),
          ["Preview", "Snapshot"],
        );
        for (const update of updates)
          if (update._tag !== "Event")
            assert.deepEqual(update.snapshot.parts, JSON.parse(JSON.stringify(snapshot.parts)));
      }).pipe(
        Effect.provide(makeLayer(undefined, { onRuntimeOptions: (mode) => modes.push(mode) })),
      );
    },
  );

  it.effect("displays persisted history while cold runtime initialization is blocked", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const initialize = yield* Deferred.make<void>();
      const received = yield* Queue.unbounded<ConversationUpdate>();
      let constructions = 0;
      let disposals = 0;
      yield* Effect.gen(function* () {
        const stream = yield* projectSessionOperations.observeConversation({
          sessionId: "session-1",
        });
        const observation = yield* stream.pipe(
          Stream.runForEach((update) => Queue.offer(received, update)),
          Effect.forkChild,
        );
        const preview = yield* Queue.take(received);
        assert.equal(preview._tag, "Preview");
        if (preview._tag === "Preview")
          assert.deepEqual(preview.snapshot.parts, snapshot.parts.map(toJsonValue));
        yield* Deferred.await(entered);
        assert.equal(constructions, 0);
        yield* Deferred.succeed(initialize, undefined);
        const live = yield* Queue.take(received);
        assert.equal(live._tag, "Snapshot");
        assert.equal(live.revision, 2);
        assert.equal(constructions, 1);
        assert.equal(disposals, 0);
        yield* Fiber.interrupt(observation);
        assert.equal(disposals, 1);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            createRuntime: (options) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(initialize);
                constructions += 1;
                return {
                  ...fakeRuntime(options),
                  dispose: async () => {
                    disposals += 1;
                  },
                };
              }),
          }),
        ),
      );
    }),
  );

  it.effect("warm observation prefers the live runtime without inspecting disk history", () => {
    let inspections = 0;
    let constructions = 0;
    return Effect.gen(function* () {
      yield* projectSessionOperations.acquireTarget(
        {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
        },
        "session-1",
        false,
      );
      const stream = yield* projectSessionOperations.observeConversation({
        sessionId: "session-1",
      });
      const [first] = yield* stream.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(first?._tag, "Snapshot");
      if (first?._tag === "Snapshot") assert.equal(first.snapshot.streaming, true);
      assert.equal(inspections, 0);
      assert.equal(constructions, 1);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          onCreateRuntime: () => {
            constructions += 1;
          },
          onInspect: () => {
            inspections += 1;
          },
          runtime: (options) => ({
            ...fakeRuntime(options),
            snapshot: async () => ({ ...snapshot, streaming: true }),
          }),
        }),
      ),
    );
  });

  it.effect("releases a cold runtime when observation is cancelled during initialization", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const initialize = yield* Deferred.make<void>();
      const received: string[] = [];
      let attempts = 0;
      let disposals = 0;
      yield* Effect.gen(function* () {
        const stream = yield* projectSessionOperations.observeConversation({
          sessionId: "session-1",
        });
        const observation = yield* stream.pipe(
          Stream.runForEach((update) =>
            Effect.sync(() => {
              received.push(update._tag);
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        // Resource acquisition finishes uninterruptibly, then the cancelled
        // observation releases its lease without publishing a live snapshot.
        const cancellation = yield* Fiber.interrupt(observation).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(initialize, undefined);
        yield* Fiber.join(cancellation);
        assert.equal(disposals, 1);
        assert.deepEqual(received, ["Preview"]);
        const reopened = yield* projectSessionOperations.observeConversation({
          sessionId: "session-1",
        });
        const updates = yield* reopened.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(
          updates.map((update) => update._tag),
          ["Preview", "Snapshot"],
        );
        assert.equal(attempts, 2);
        assert.equal(disposals, 2);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            createRuntime: (options) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(initialize);
                }
                return {
                  ...fakeRuntime(options),
                  dispose: async () => {
                    disposals += 1;
                  },
                };
              }),
          }),
        ),
      );
    }),
  );

  it.effect(
    "reports initialization failure after preview and supports a fresh observation retry",
    () =>
      Effect.gen(function* () {
        const initialize = yield* Deferred.make<void, Error>();
        const received = yield* Queue.unbounded<ConversationUpdate>();
        let attempts = 0;
        yield* Effect.gen(function* () {
          const stream = yield* projectSessionOperations.observeConversation({
            sessionId: "session-1",
          });
          const observation = yield* stream.pipe(
            Stream.runForEach((update) => Queue.offer(received, update)),
            Effect.result,
            Effect.forkChild,
          );
          assert.equal((yield* Queue.take(received))._tag, "Preview");
          yield* Deferred.fail(initialize, new Error("Extension initialization failed"));
          const failed = yield* Fiber.join(observation);
          assert.equal(failed._tag, "Failure");
          if (failed._tag === "Failure")
            assert.match(failed.failure.message, /Extension initialization failed/);
          const retry = yield* projectSessionOperations.observeConversation({
            sessionId: "session-1",
          });
          const updates = yield* retry.pipe(Stream.take(2), Stream.runCollect);
          assert.deepEqual(
            updates.map((update) => update._tag),
            ["Preview", "Snapshot"],
          );
          assert.equal(attempts, 2);
        }).pipe(
          Effect.provide(
            makeLayer(undefined, {
              createRuntime: (options) =>
                Effect.gen(function* () {
                  attempts += 1;
                  if (attempts === 1) yield* Deferred.await(initialize);
                  return fakeRuntime(options);
                }),
            }),
          ),
        );
      }),
  );

  it.effect("emits a Cake snapshot and returns an accepted Turn ID", () =>
    Effect.gen(function* () {
      const stream = yield* projectSessionOperations.observeConversation({
        sessionId: "session-1",
      });
      const initial = yield* stream.pipe(
        Stream.filter((update) => update._tag === "Snapshot"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(initial[0]?._tag, "Snapshot");
      yield* projectSessionOperations.acquireTarget(
        {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
        },
        "session-1",
        false,
      );
      const turnId = yield* sessionChats.deliver(
        {
          sessionId: "session-1",
          text: "Implement it",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        "prompt",
      );
      assert.match(turnId, /^[0-9a-f-]{36}$/);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "preserves compacted work logs across active, resolved, and reopened Conversation observation",
    () => {
      let inspections = 0;
      let disposals = 0;
      return Effect.gen(function* () {
        const updates = yield* projectSessionOperations.observeConversation({
          sessionId: "session-1",
        });
        const received = yield* Queue.unbounded<ConversationUpdate>();
        const fiber = yield* updates.pipe(
          Stream.tap((update) => Queue.offer(received, update)),
          Stream.take(5),
          Stream.runCollect,
          Effect.forkChild,
        );
        assert.equal((yield* Queue.take(received))._tag, "Preview");
        assert.equal((yield* Queue.take(received))._tag, "Snapshot");

        yield* projectSessionLifecycle.resolve({ sessionId: "session-1" });
        assert.equal((yield* Queue.take(received))._tag, "Preview");
        yield* projectSessionLifecycle.restore({ sessionId: "session-1" });

        const observed = Array.from(yield* Fiber.join(fiber));
        assert.deepEqual(
          observed.map((update) => update._tag),
          ["Preview", "Snapshot", "Preview", "Preview", "Snapshot"],
        );
        for (const update of observed) {
          if (update._tag === "Event") continue;
          assert.deepEqual(update.snapshot.parts[1], {
            id: "compacted-tool",
            kind: "tool",
            name: "read",
            input: "README.md",
            output: "historical result",
            state: "success",
            origin: "compacted",
          });
        }
        if (observed[2]?._tag === "Preview") {
          assert.equal(observed[2].revision, 3);
          assert.equal(observed[2].snapshot.sessionId, "session-1");
          assert.deepEqual(observed[2].snapshot.parts[0], {
            id: "user-message",
            kind: "text",
            role: "user",
            text: "Hello",
            status: "complete",
          });
        }
        assert.equal(inspections, 3);
        assert.equal(disposals, 2);
      }).pipe(
        Effect.provide(
          makeLayer(undefined, {
            onInspect: () => inspections++,
            onDispose: () => disposals++,
          }),
        ),
      );
    },
  );

  it.effect("previews a continuation while setup blocks runtime acquisition and turns", () => {
    let runtimeConstructions = 0;
    return Effect.gen(function* () {
      const setup = yield* Deferred.make<void, ManagedWorktreeError>();
      const layer = makeLayer(undefined, {
        locations: [
          {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/worktree",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved-sessions",
            managedWorktree: {
              projectPath: "/project",
              worktreePath: "/worktree",
              branch: "agent/background",
              baseBranch: "main",
              state: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
        deferredWorktreeSetup: Deferred.await(setup),
        onCreateRuntime: () => runtimeConstructions++,
      });
      yield* Effect.gen(function* () {
        const updates = yield* projectSessionOperations.observeConversation({
          sessionId: "session-1",
          workingDirectory: "/worktree",
        });
        const initial = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
        assert.equal(initial[0]?._tag, "Preview");
        assert.equal(runtimeConstructions, 0);

        const turn = yield* projectSessionOperations
          .sendAutomatically({
            sessionId: "session-1",
            workingDirectory: "/worktree",
            text: "Continue after setup",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.equal(runtimeConstructions, 0);

        yield* Deferred.succeed(setup, undefined);
        yield* Fiber.join(turn);
        assert.equal(runtimeConstructions, 1);
      }).pipe(Effect.provide(layer));
    });
  });

  it.effect(
    "routes matching conversation controls through one acquired Project Session runtime",
    () => {
      const operations: string[] = [];
      let runtimeConstructions = 0;
      const target = { sessionId: "session-1" };
      return Effect.gen(function* () {
        yield* projectSessionOperations.acquireTarget(
          {
            projectPath: "/project",
            projectName: "Project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved-sessions",
          },
          target.sessionId,
          false,
        );
        yield* sessionChats.compact(target, "Keep the architecture notes");
        yield* sessionChats.editMessage({
          ...target,
          entryId: "user-message",
          text: "Updated",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        });
        yield* sessionChats.applyConfiguration(target, {
          provider: "fixture-provider",
          modelId: "fixture-model",
          thinkingLevel: "medium",
          fastMode: false,
        });
        yield* sessionChats.setModel(target, "fixture-provider", "fixture-model");
        yield* sessionChats.setThinkingLevel(target, "high");
        yield* sessionChats.setFastMode(target, true);
        yield* sessionChats.setPiSetting(target, { key: "retryEnabled", value: false });
        yield* sessionChats.listQueuedMessages(target);
        yield* sessionChats.clearQueue(target);
        yield* sessionChats.cancelSteering(target);
        yield* sessionChats.removeQueuedMessage(target, "queued-part");
        yield* sessionChats.steerQueuedMessage(target, "queued-part");
        yield* sessionChats.abort({ ...target, stop: { by: "user" } });

        assert.equal(runtimeConstructions, 1);
        assert.deepEqual(operations, [
          "compact",
          "edit",
          "configuration",
          "model",
          "thinking",
          "fast",
          "setting",
          "list-queue",
          "clear-queue",
          "cancel-steering",
          "remove-queued",
          "steer-queued",
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
      const updates = yield* projectSessionMetadata.observeCatalog({
        projectPath: "/project",
        resolved: false,
      });
      const ready = yield* Deferred.make<void>();
      const fiber = yield* updates.pipe(
        Stream.tap((update) =>
          update.revision === 1 ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.filter((update) => update._tag === "Snapshot" || update.event._tag === "Upserted"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);

      yield* projectSessionOperations.start({
        sessionId: "session-1",
        workingDirectory: "/project",
        text: "First message",
        labelIds: ["00000000-0000-4000-8000-000000000001"],
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });

      const project = (yield* getState()).projects.find(
        (candidate) => candidate.path === "/project",
      );
      assert.equal(project?.todos?.items.length, 1);
      assert.equal(project?.todos?.items[0]?.title, "First message");
      assert.equal(project?.todos?.items[0]?.description, "First message");
      assert.deepEqual(project?.todos?.items[0]?.associations, [
        { kind: "session", sessionId: "session-1", title: "First message" },
      ]);
      assert.deepEqual(project?.workflow?.assignments, [
        {
          sessionId: "session-1",
          labelIds: ["00000000-0000-4000-8000-000000000001"],
        },
      ]);
      const observed = Array.from(yield* Fiber.join(fiber));
      assert.equal(observed[1]?._tag, "Event");
      assert.equal(observed[1]?._tag === "Event" ? observed[1].event._tag : undefined, "Upserted");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("publishes a renamed title before the active turn settles", () => {
    let title = "Active branch";
    return Effect.gen(function* () {
      const updates = yield* projectSessionMetadata.observeCatalog({
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

      yield* projectSessionOperations.rename({ sessionId: "session-1" }, "Renamed while running");

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
      yield* projectSessionOperations.start({
        sessionId: "session-1",
        workingDirectory: "/project",
        text: "First message",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });

      const updates = yield* projectSessionOperations.observeConversation({
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
      const stream = yield* projectSessionOperations.observeConversation({
        sessionId: "session-1",
        workingDirectory: "/project",
      });
      yield* stream.pipe(
        Stream.filter((update) => update._tag === "Snapshot"),
        Stream.take(1),
        Stream.runDrain,
      );
      assert.deepEqual(creationModes, [false]);
    }).pipe(
      Effect.provide(
        makeLayer(undefined, {
          onRuntimeOptions: (newSession) => creationModes.push(newSession),
        }),
      ),
    );
  });

  it.effect("opens an unresolved session without catalog churn or a Pi runtime", () => {
    let runtimeConstructions = 0;
    const changes: SessionCatalogChange[] = [];
    return Effect.gen(function* () {
      yield* projectSessionMetadata.open({ sessionId: "session-1" });
      assert.equal(runtimeConstructions, 0);
      assert.deepEqual(changes, []);
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
          {
            onCreateRuntime: () => runtimeConstructions++,
            onCatalogChange: (change) => changes.push(change),
          },
        ),
      ),
    );
  });

  it.effect("previews a resolved session without restoring or constructing its runtime", () => {
    let runtimeConstructions = 0;
    let inspections = 0;
    let restores = 0;
    return Effect.gen(function* () {
      yield* projectSessionMetadata.open({ sessionId: "session-1" });
      assert.equal(runtimeConstructions, 0);
      assert.equal(restores, 0);

      const updates = yield* projectSessionOperations.observeConversation({
        sessionId: "session-1",
      });
      const preview = Array.from(yield* updates.pipe(Stream.take(1), Stream.runCollect));
      assert.equal(preview[0]?._tag, "Preview");
      const first = preview[0];
      if (first?._tag === "Preview")
        assert.deepEqual(first.snapshot.parts[0], {
          id: "user-message",
          kind: "text",
          role: "user",
          text: "Hello",
          status: "complete",
        });
      assert.equal(runtimeConstructions, 0);
      assert.equal(inspections, 1);
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
            onInspect: () => inspections++,
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
      yield* projectSessionLifecycle.restore({ sessionId: "session-1" });
      yield* projectSessionOperations.acquireTarget(
        {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved-sessions",
        },
        "session-1",
        false,
      );
      yield* sessionChats.deliver(
        {
          sessionId: "session-1",
          text: "Continue",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        "prompt",
      );
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
      const error = yield* projectSessionMetadata
        .open({ sessionId: "missing", workingDirectory: "/project" })
        .pipe(Effect.flip);
      assert.equal(error.operation, "open");
      assert.match(error.message, /could not find Project Session missing/);
    }).pipe(Effect.provide(makeLayer(undefined, { sessionExists: false }))),
  );
});
