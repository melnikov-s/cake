import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { DiscussionSessionEnvironment } from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import { WorktreeLandingAgent } from "../../../src/services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../../src/services/worktrees/WorktreeLandingCompletion";
import { WorktreeLandingCoordinatorLive } from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import { Context, Deferred, Effect, Layer, Option, Queue, Stream } from "effect";
import {
  RendererConnection,
  type RendererConnectionInfo,
} from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { AgentAvailability } from "../../../src/services/pi/AgentAvailability";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import { ClientWorkspacesLive } from "../../../src/services/clients/ClientWorkspacesLive";
import {
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { PiModel } from "../../../src/services/pi/model-data";
import { PiModels } from "../../../src/services/pi/PiModels";
import { PiSettings } from "../../../src/services/pi/PiSettings";
import { PiAgentResources } from "../../../src/services/pi/PiAgentResources";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { makeWorkspaceFilesLive } from "../../../src/services/filesystem/WorkspaceFilesLive";
import { makeAttachmentUploadsLive } from "../../../src/services/filesystem/AttachmentUploadsLive";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { makeSavedDraftStorageLive } from "../../../src/services/storage/SavedDraftStorage";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeProjectAccessLive } from "../../../src/services/projects/ProjectAccessLive";
import { ProjectConfiguration } from "../../../src/services/projects/ProjectConfiguration";
import { RewordingRequestsLive } from "../../../src/services/projects/RewordingRequestsLive";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { DrawBoardStorage } from "../../../src/services/storage/DrawBoardStorage";
import { makeDrawBoardStorageLive } from "../../../src/services/storage/DrawBoardStorageLive";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ArtifactProjection } from "../../../src/services/artifacts/ArtifactProjection";
import { ArtifactGarbageCollector } from "../../../src/services/artifacts/ArtifactGarbageCollector";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ScheduledMessages } from "../../../src/services/scheduled-messages/ScheduledMessages";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { fakeRuntime, snapshot } from "../../app/helpers/piRuntimeFixture";
import type { Attachment, ConversationSnapshot } from "../../../src/ipc/session-contract";

/** A mechanism fixture, NOT proof of production graph acquisition. Real RPC/domain policy,
 * ApplicationState, connection authorities and CakeSessionRuntimes; controlled Pi/storage/worktree
 * boundaries. The separate headless Node tests acquire the production graph with Electron forbidden.
 */
export const makeNetworkTestBackend = Effect.fn("NetworkTest.backend")(function* (options?: {
  adapter?: CakeSessionRuntimesAdapter;
  models?: ReadonlyArray<typeof PiModel.Type>;
  onPrompt?: (text: string, attachments: ReadonlyArray<Attachment>) => void;
  projectPath?: string;
  drawBoardsRoot?: string;
  vscode?: Partial<VsCodeServer["Service"]>;
  terminal?: Partial<Terminal["Service"]>;
}) {
  const projectPath = options?.projectPath ?? "/project";
  const savedDraftDirectory = join(tmpdir(), `cake-test-saved-drafts-${randomUUID()}`);
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => rm(savedDraftDirectory, { recursive: true, force: true })).pipe(
      Effect.ignore,
    ),
  );
  const savedDraftStorage = makeSavedDraftStorageLive(savedDraftDirectory).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
  const started = yield* Queue.unbounded<string>();
  const finish = yield* Deferred.make<void>();
  const settled = yield* Queue.unbounded<void>();
  const cleaned = yield* Queue.unbounded<number>();
  const metadata = yield* Queue.unbounded<RendererConnectionInfo>();
  const subscriptionClosed = yield* Queue.unbounded<number>();
  const stats = {
    acquisitions: 0,
    releases: 0,
    turns: 0,
    aborted: 0,
    saves: 0,
    backendClosed: false,
  };
  let current: ConversationSnapshot = {
    ...snapshot,
    sessionId: "00000000-0000-4000-8000-000000000001",
  };
  const onPrompt = options?.onPrompt;
  const runtimes = makeCakeSessionRuntimesLayer(
    options?.adapter ?? {
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed("# Test changelog"),
      createRuntime: (options) =>
        Effect.sync(() => {
          stats.acquisitions++;
          return {
            ...fakeRuntime(options, () => {
              stats.releases++;
            }),
            sessionId: current.sessionId,
            get streaming() {
              return current.streaming;
            },
            snapshot: async () => current,
            prompt: (
              text: string,
              _delivery: "prompt" | "steer" | "follow-up",
              attachments: Attachment[],
            ) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  stats.turns++;
                  onPrompt?.(text, attachments);
                  current = { ...current, streaming: true };
                  yield* Queue.offer(started, text);
                  yield* Deferred.await(finish);
                  current = {
                    ...current,
                    streaming: false,
                    parts: [
                      {
                        id: "answer",
                        kind: "text",
                        role: "assistant",
                        status: "complete",
                        text: "Completed while disconnected",
                      },
                    ],
                  };
                  options.onEvent({ type: "snapshot", snapshot: current });
                  yield* Queue.offer(settled, undefined);
                }),
              ),
            abort: () =>
              Effect.runPromise(
                Effect.sync(() => {
                  stats.aborted++;
                }).pipe(Effect.andThen(Deferred.succeed(finish, undefined)), Effect.asVoid),
              ),
          };
        }),
    },
  );
  const application = ApplicationState.layer.pipe(
    Layer.provide(
      Layer.succeed(ApplicationStorage, {
        load: () =>
          Effect.succeed({
            source: "missing" as const,
            state: {
              ...defaultApplicationState(),
              trustedProjectPaths: [projectPath],
              projects: [
                {
                  path: projectPath,
                  name: "Test",
                  addedAt: "2026-01-01T00:00:00.000Z",
                  lastOpenedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            },
          }),
        save: () =>
          Effect.sync(() => {
            stats.saves++;
          }),
      }),
    ),
  );
  const observedEvents = Layer.effect(
    ClientEvents,
    Effect.map(ClientEvents, (events) =>
      ClientEvents.of({
        ...events,
        application: (id) =>
          events.application(id).pipe(Stream.ensuring(Queue.offer(subscriptionClosed, id))),
      }),
    ),
  ).pipe(Layer.provide(ClientEventsLive));
  const clients = Layer.mergeAll(
    ClientConnectionsLive,
    observedEvents,
    ClientWorkspacesLive,
    RewordingRequestsLive,
  );
  const worktrees = Layer.mock(ManagedWorktrees, {
    records: () => Effect.succeed([]),
    observe: () => Stream.never,
    awaitSetup: () => Effect.void,
    hasDeferredSetup: () => Effect.succeed(false),
  });
  const access = Layer.effect(
    ProjectAccess,
    Effect.map(ProjectAccess, (service) =>
      ProjectAccess.of({
        ...service,
        clearOwner: (id) => service.clearOwner(id).pipe(Effect.andThen(Queue.offer(cleaned, id))),
        allow: (path) =>
          Effect.gen(function* () {
            const connection = yield* Effect.serviceOption(RendererConnection);
            if (Option.isSome(connection)) yield* Queue.offer(metadata, connection.value);
            yield* service.allow(path);
          }),
      }),
    ),
  ).pipe(
    Layer.provide(
      makeProjectAccessLive({
        projectSessionDirectory: "/sessions",
        resolvedProjectSessionDirectory: "/resolved",
      }).pipe(Layer.provide(Layer.merge(application, worktrees))),
    ),
  );
  const coordinator = RendererRequestCoordinatorLive.pipe(Layer.provide(clients));
  const host = Layer.effect(
    ProjectSessionRuntimeHost,
    Effect.gen(function* () {
      const requests = yield* RendererRequestCoordinator;
      const integrations = {
        requestUi: async () => undefined,
        requestApplicationControl: async () => ({ ok: false, error: "No UI" }),
        emitExtensionUiIntent: () => undefined,
        persistArtifact: async () => {
          throw new Error("Unused artifact storage");
        },
        requestArtifact: async () => undefined,
        generateInlineWidget: async () => {
          throw new Error("Unavailable capture");
        },
      };
      return ProjectSessionRuntimeHost.of({
        runtimeIntegrations: (_workingDirectory, sessionId) =>
          requests
            .registerProjectSession(sessionId, projectPath)
            .pipe(Effect.orDie, Effect.as(integrations)),
        releaseSession: (sessionId) =>
          requests.releaseSession({ _tag: "ProjectSession", sessionId }),
        stopWorkingDirectory: () => Effect.void,
      });
    }),
  ).pipe(Layer.provide(coordinator));
  const layer = Layer.mergeAll(
    Layer.mock(VsCodeServer, {
      leaseFor: () => undefined,
      releaseConnection: () => Effect.void,
      ...options?.vscode,
    }),
    Layer.mock(DiscussionSessionEnvironment, {}),
    Layer.mock(WorktreeLandingAgent, {}),
    Layer.mock(WorktreeLandingCompletion, {}),
    WorktreeLandingCoordinatorLive,
    application,
    savedDraftStorage,
    clients,
    coordinator,
    host,
    runtimes,
    SessionCatalogChanges.layer,
    SubagentCoordinatorLive,
    AgentAvailability.layer,
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          stats.backendClosed = true;
        }),
      ),
    ),
    access,
    makeWorkspaceFilesLive("/agent").pipe(Layer.provide(access)),
    makeAttachmentUploadsLive(
      join(tmpdir(), `cake-test-uploads-${randomUUID()}`),
      join(tmpdir(), `cake-test-accepted-${randomUUID()}`),
    ).pipe(Layer.provide(clients)),
    worktrees,
    Layer.succeed(ProjectConfiguration, { agentDirectory: "/agent" }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
    Layer.mock(SessionFamilyStorage, {
      list: () => Effect.succeed([]),
      familyForMember: () => Effect.succeed(undefined),
      settleTurn: () => Effect.void,
      withMemberLock: (_sessionId, effect) => effect,
    }),
    Layer.mock(SessionArchiveStorage, {
      projectMigrationComplete: () => Effect.succeed(true),
      resolvedProjects: () => Stream.empty,
      locate: () => Effect.succeed("active" as const),
      resolvedProjectEntry: () => Effect.succeed(undefined),
    }),
    Layer.mock(Terminal, {
      closeWorkingDirectory: () => Effect.void,
      closeOwner: () => Effect.void,
      ...options?.terminal,
    }),
    Layer.mock(SubagentEnvironment, {}),
    Layer.mock(ArtifactStorage, {}),
    Layer.mock(ArtifactProjection, {}),
    Layer.mock(ArtifactGarbageCollector, {}),
    options?.drawBoardsRoot
      ? makeDrawBoardStorageLive(options.drawBoardsRoot).pipe(
          Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        )
      : Layer.mock(DrawBoardStorage, {}),
    Layer.mock(ReviewStorage, {
      agentSessionDirectory: () => {
        throw new Error("Unused reviews");
      },
      reviewContextPath: () => {
        throw new Error("Unused reviews");
      },
      discussionParentContextPath: () => {
        throw new Error("Unused reviews");
      },
    }),
    Layer.mock(PiModels, { list: () => Effect.succeed(options?.models ?? []) }),
    Layer.mock(PiSettings, {}),
    Layer.mock(PiAgentResources, {}),
    Layer.mock(ScheduledMessages, {
      snapshot: () => {
        throw new Error("Unused schedules");
      },
    }),
  );
  const context = yield* Layer.build(layer);
  yield* Context.get(context, ApplicationState).initialize();
  yield* Context.get(context, ProjectAccess).allow(projectPath);
  return { context, stats, started, finish, settled, cleaned, subscriptionClosed, metadata };
});
