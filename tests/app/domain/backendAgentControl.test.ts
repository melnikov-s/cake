import { PiModels } from "../../../src/services/pi/PiModels";
import {
  UnknownPiModelError,
  UnavailablePiModelError,
  UnauthenticatedPiModelError,
} from "../../../src/contracts/pi/model-data";
import { AgentControlTestLive } from "../helpers/agentControlTestLayer";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createCakeSessionRuntime,
  type CakeSessionRuntime,
} from "../../../src/services/pi/runtime/cake-session-runtime";
import { cakeWorkspaceSessionDirectory } from "../../../src/services/pi/runtime/session-discovery";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as artifactCommands from "../../../src/domain/artifacts/artifactCommands";
import * as sessionReferences from "../../../src/domain/project-sessions/sessionReferences";
import * as sessionMetadata from "../../../src/domain/project-sessions/projectSessionMetadata";
import { ArtifactRuntime } from "../../../src/services/artifact-runtime/ArtifactRuntime";
import { ArtifactRuntimeLive } from "../../../src/services/artifact-runtime/ArtifactRuntimeLive";
import { ArtifactRuntimeHostLive } from "../../../src/layers/ArtifactRuntimeHostLive";
import { ArtifactRuntimeDescriptor } from "../../../src/contracts/artifacts/artifact-runtime-descriptor";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import { ArtifactViews } from "../../../src/services/artifacts/ArtifactViews";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import type { InternalInput } from "../../../src/contracts/conversations/internal-input";
import { it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Queue,
  Schema,
  Stream,
} from "effect";
import { expect, vi } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
  PROJECT_ICON_FILE_MAX_BYTES,
} from "../../../src/contracts/application/application-data";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../../src/contracts/serialization/json-contract";
import type { SessionContextMetadata } from "../../../src/contracts/conversations/session-context-metadata";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeChatDurable } from "../../../src/services/pi-durable/CakeChatDurable";
import { DiscussionSessionEnvironment } from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import {
  messageReference,
  parseSessionLink,
} from "../../../src/contracts/conversations/message-reference";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import {
  coordinatorCakeOperations,
  projectCakeOperations,
  createProjectSessionRuntime,
} from "../../../src/layers/CakeOperations";
import { AutomationRecords } from "../../../src/services/automations/AutomationRecords";
import {
  AutomationStorage,
  type AutomationLedger,
} from "../../../src/services/storage/AutomationStorage";
import { automationDefinition } from "../helpers/automationFixture";
import { setCakeChatPreferences, upsertProject } from "../../../src/domain/application/application";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import { AttachmentUploadError } from "../../../src/contracts/filesystem/attachment-uploads-errors";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import * as cakeChatRuntime from "../../../src/domain/cake-chats/cakeChatRuntime";
import * as cakeChatOperations from "../../../src/domain/cake-chats/cakeChatOperations";
import * as runtimeRecovery from "../../../src/domain/project-sessions/runtimeRecovery";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import * as agentControl from "../../../src/domain/application/agentControl";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { modelPresetPromptsTestLayer } from "../helpers/modelPresetPrompts";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import {
  SessionArchiveStorage,
  SessionArchiveStorageError,
  type ProjectSessionArchiveMetadata,
} from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import {
  CakeSessionRuntimes,
  PiSessionError,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import {
  makeRuntimeRecoveryStorageTestLayer,
  fakeRuntime,
  snapshot,
} from "../helpers/piRuntimeFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import type { ScheduledMessage } from "../../../src/contracts/scheduled-messages/scheduled-message-data";
import { parseScheduledMessage } from "../../../src/contracts/conversations/scheduled-message-envelope";
import * as scheduledMessages from "../../../src/domain/scheduled-messages/scheduledMessages";
import { ScheduledMessages } from "../../../src/services/scheduled-messages/ScheduledMessages";
import { ScheduledMessageStorage } from "../../../src/services/storage/ScheduledMessageStorage";

const source = "00000000-0000-4000-8000-000000000011";
const target = "00000000-0000-4000-8000-000000000022";
const third = "00000000-0000-4000-8000-000000000033";
const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
import { discoveryResultText } from "../../../src/contracts/agent/discovery-result-text";

const caller = {
  kind: "project-session" as const,
  sessionId: source,
  title: "Source",
  projectName: "Project",
  projectPath: "/project",
  workingDirectory: "/project",
};
const signal = () => new AbortController().signal;
const summary = (id: string) => ({
  id,
  title: id === source ? "Source" : "Same title",
  created: "2026-01-01",
  modified: id === target ? "2026-01-03" : "2026-01-02",
  messageCount: 1,
  resolved: false,
});

const fixture = Effect.fn("BackendAgentControlTest.fixture")(function* (withChats = false) {
  const clock = yield* Clock.Clock;
  const consumedInputs = new Map<string, number>();
  const compactions: Array<{ sessionId: string; instructions?: string }> = [];
  const toolPrunings: string[] = [];
  const compactFailures = new Set<string>();
  const compacted = new Set<string>();
  const compactStarted = yield* Deferred.make<void>();
  const compactRelease = yield* Deferred.make<void>();
  let pauseCompaction = false;
  const prompts = yield* Queue.unbounded<{
    sessionId: string;
    text: string;
    delivery: string;
    attachments: readonly Attachment[];
  }>();
  const saves = yield* Queue.unbounded<void>();
  const saveRelease = yield* Deferred.make<void>();
  let pauseSave = false;
  let failNextSave = false;
  let saveCount = 0;
  let restored = 0;
  let resolved = false;
  let protectedTarget = false;
  const drafts: SavedDraft[] = [];
  const deniedPaths = new Set<string>();
  const promptRoots = new Set<string>();
  const active = new Set<string>();
  const pending = new Set<string>();
  const unavailable = new Set<string>();
  const failedTurns = new Set<string>();
  const admissions = yield* Queue.unbounded<void>();
  const admissionRelease = yield* Deferred.make<void>();
  let pauseAdmission = false;
  const messageRelease = yield* Deferred.make<void>();
  let pauseMessage = false;
  const protectedSessions = new Set<string>();
  const grants: unknown[] = [];
  const queries: unknown[] = [];
  const received: Array<{ connectionId: number; event: CakeEvent }> = [];
  const deliveries = yield* Queue.unbounded<{ connectionId: number; event: CakeEvent }>();
  const runtimeCreates: string[] = [];
  const runtimeFactories = new Map<string, () => Promise<CakeSessionRuntime>>();
  const internalInputs: InternalInput[] = [];
  const httpRequests: HttpClientRequest.HttpClientRequest[] = [];
  const gatewayCalls: Array<{
    sessionId: string;
    command: string;
    input: JsonObject;
    fullControl: boolean;
  }> = [];
  const inspections: string[] = [];
  const listReads = {
    ids: [] as string[],
    titles: [] as string[],
    entries: [] as string[],
    locate: 0,
    resolutions: [] as string[],
    drafts: 0,
    records: 0,
    inspectionFiles: [] as Array<string | undefined>,
  };
  const redactionReads = { inventories: 0, entries: 0 };
  const sessionsByDirectory = new Map<string, string[]>([["/project", [source, target, third]]]);
  const archivedEntries = new Map<string, ProjectSessionArchiveMetadata>();
  const worktreeRecords: WorktreeRecord[] = [];
  const contextBySession = new Map<string, SessionContextMetadata>();
  const requestCalls: unknown[] = [];
  const project = {
    path: "/project",
    name: "Project",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    settings: defaultProjectSettings(),
  };
  const storage = Layer.succeed(
    ApplicationStorage,
    ApplicationStorage.of({
      load: () =>
        Effect.succeed({
          state: {
            ...defaultApplicationState(),
            globalSessionLabels: [],
            projects: [project],
          },
          source: "current",
        }),
      save: () =>
        Effect.gen(function* () {
          saveCount++;
          yield* Queue.offer(saves, undefined);
          if (pauseSave) yield* Deferred.await(saveRelease);
          if (failNextSave) {
            failNextSave = false;
            return yield* new ApplicationWriteError({
              stage: "write",
              message: "Injected storage failure",
            });
          }
        }),
    }),
  );
  const clients = Layer.merge(ClientConnectionsLive, ClientEventsLive);
  const renderers = RendererRequestCoordinatorLive.pipe(Layer.provideMerge(clients));
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: (query) => {
      listReads.ids.push(query.workingDirectory);
      return Stream.fromIterable(sessionsByDirectory.get(query.workingDirectory) ?? []);
    },
    catalog: (query) => {
      const ids = (sessionsByDirectory.get(query.workingDirectory) ?? []).filter(
        (id) => !unavailable.has(id) && !query.excludedSessionIds?.includes(id),
      );
      listReads.titles.push(...ids);
      return Stream.fromIterable(
        ids.map((id) => ({
          ...summary(id),
          contextMetadata: contextBySession.get(id),
          sessionFile: `/cake/sessions/${id}.jsonl`,
        })),
      );
    },
    catalogEntry: (_query, id) => {
      listReads.entries.push(id);
      return unavailable.has(id)
        ? Effect.fail(
            new PiSessionError({ operation: "catalogEntry", message: "Recipient unavailable" }),
          )
        : Effect.succeed(
            [source, target, third].includes(id) || contextBySession.has(id)
              ? { ...summary(id), contextMetadata: contextBySession.get(id) }
              : undefined,
          );
    },
    inspect: ({ sessionId }, options) =>
      Effect.sync(() => {
        inspections.push(sessionId);
        listReads.inspectionFiles.push(options?.sessionFile);
        return {
          workspacePath: "/project",
          sessionId,
          sessionFile: `/cake/sessions/${sessionId}.jsonl`,
          contextMetadata: contextBySession.get(sessionId),
          parts: [
            {
              id: "entry",
              kind: "text" as const,
              role: "user" as const,
              text: "First input",
              status: "complete" as const,
            },
          ],
        };
      }),
    changelog: () => Effect.succeed(""),
    createRuntime: (options) =>
      Effect.gen(function* () {
        const sessionId = options.sessionId ?? "unexpected";
        runtimeCreates.push(sessionId);
        const factory = runtimeFactories.get(sessionId);
        if (factory) return yield* Effect.promise(factory);
        if (pauseAdmission && sessionId === target) {
          yield* Queue.offer(admissions, undefined);
          yield* Deferred.await(admissionRelease);
        }
        return {
          ...fakeRuntime(options, () => undefined),
          sessionId,
          sessionFile: `/cake/sessions/${sessionId}.jsonl`,
          get streaming() {
            return active.has(sessionId);
          },
          snapshot: async () => ({ ...snapshot, sessionId, streaming: active.has(sessionId) }),
          listQueuedMessages: async () => ({
            steering: [],
            followUp: pending.has(sessionId) ? ["Pending input"] : [],
          }),
          scheduledInputReceipt: async (turnId) => {
            const consumedAt = consumedInputs.get(turnId);
            return consumedAt === undefined ? undefined : { status: "consumed", consumedAt };
          },
          callCakeOperation: async (command, input) => {
            gatewayCalls.push({ sessionId, command, input, fullControl: false });
            if (command !== "settings.open") throw new Error(`Unknown Cake operation: ${command}`);
            Schema.decodeUnknownSync(Schema.Struct({ page: Schema.Literal("general") }))(input, {
              onExcessProperty: "error",
            });
            return { opened: true, sessionId };
          },
          callCakeTool: async (command, input) => {
            gatewayCalls.push({ sessionId, command, input, fullControl: true });
            if (command !== "settings.open") throw new Error(`Unknown Cake operation: ${command}`);
            Schema.decodeUnknownSync(Schema.Struct({ page: Schema.Literal("general") }))(input, {
              onExcessProperty: "error",
            });
            const result = { opened: true, sessionId };
            return {
              json: result,
              text: JSON.stringify(result),
              content: [],
              details: result,
              structuredContent: result,
            };
          },
          prompt: async (
            text,
            delivery,
            attachments,
            _markdown,
            _turnId,
            _presentationMode,
            _title,
            _responseMode,
            internal,
          ) => {
            if (internal) internalInputs.push(internal);
            if (_turnId && parseScheduledMessage(text))
              consumedInputs.set(_turnId, clock.currentTimeMillisUnsafe());
            await Effect.runPromise(
              Queue.offer(prompts, { sessionId, text, delivery, attachments }),
            );
            if (pauseMessage) await Effect.runPromise(Deferred.await(messageRelease));
            if (failedTurns.has(sessionId)) throw new Error("Model failed after admission");
          },
          toolPruneIfIdle: async () => {
            toolPrunings.push(sessionId);
            Deferred.doneUnsafe(compactStarted, Effect.void);
            if (pauseCompaction) await Effect.runPromise(Deferred.await(compactRelease));
            if (compactFailures.has(sessionId)) throw new Error("Tool pruning navigation failed");
            return { status: "compacted" };
          },
          compactIfIdle: async (instructions) => {
            compactions.push({
              sessionId,
              ...(instructions === undefined ? null : { instructions }),
            });
            Deferred.doneUnsafe(compactStarted, Effect.void);
            if (pauseCompaction) await Effect.runPromise(Deferred.await(compactRelease));
            if (compactFailures.has(sessionId)) throw new Error("Compaction provider failed");
            if (compacted.has(sessionId)) return { status: "unchanged" };
            compacted.add(sessionId);
            return { status: "compacted" };
          },
          inspectSession: async (query): Promise<JsonValue> => {
            queries.push(query);
            if (query.kind === "messages-list") {
              const ref = messageReference(sessionId, "entry");
              return {
                sessionId,
                branch: "all",
                total: 1,
                offset: 0,
                nextOffset: null,
                messages:
                  query.entryId === "missing"
                    ? []
                    : [
                        {
                          ref,
                          link: ref,
                          sessionId,
                          entryId: "entry",
                          parentId: null,
                          timestamp: "2026-01-01",
                          role: "user",
                          active: true,
                          inputRefs: [],
                          hasImages: false,
                        },
                      ],
              };
            }
            return { total: 0, entries: [] };
          },
        };
      }),
  }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer()));
  let companionContextSessionId: string | undefined;
  let storedSchedules: readonly ScheduledMessage[] = [];
  const familyHarness = familyStorageHarness();
  const dependencies = Layer.mergeAll(
    modelPresetPromptsTestLayer,
    AgentControlTestLive,
    NodePath.layer,
    Layer.mock(ArtifactRuntime, {}),
    Layer.mock(ArtifactViews, {}),
    Layer.mock(ArtifactStorage, {}),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        httpRequests.push(request);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("teapot", { status: 418, headers: { "x-test": "response" } }),
          ),
        );
      }),
    ),
    Layer.mock(CakeChatDurable, {
      assistantContextSessionId: () => Effect.sync(() => companionContextSessionId),
    }),
    ScheduledMessages.layer.pipe(
      Layer.provide(
        Layer.succeed(ScheduledMessageStorage, {
          load: () => Effect.sync(() => storedSchedules),
          save: (messages) =>
            Effect.sync(() => {
              storedSchedules = [...messages];
            }),
        }),
      ),
    ),
    withChats
      ? Layer.succeed(CakeChatConfiguration, {
          location: { workingDirectory: "/chat", sessionDirectory: "/chats" },
          agentDirectory: "/agent",
        })
      : Layer.empty,
    Layer.mock(SavedDraftStorage, {
      list: () =>
        Effect.sync(() => {
          listReads.drafts++;
          return drafts;
        }),
      update: (record, revision) =>
        Effect.sync(() => {
          const index = drafts.findIndex((item) => item.sessionId === record.sessionId);
          expect(drafts[index]?.revision).toBe(revision);
          const updated = { ...record, revision: revision + 1 };
          drafts[index] = updated;
          return updated;
        }),
    }),
    makeHeadlessProjectSessionRuntimeMechanismTestLayer({
      requestUi: async () => undefined,
      requestInterview: async () => undefined,
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("unexpected artifact");
      },
      generateInlineWidget: async () => {
        throw new Error("unexpected widget");
      },
      requestApplicationControl: (invocation, abort) => {
        requestCalls.push(invocation);
        return Effect.runPromise(requests.requestProjectControl(source, invocation, abort));
      },
    }),
    Layer.mock(PiModels, {
      resolve: (selection) =>
        selection.modelId === "valid"
          ? Effect.succeed(selection)
          : Effect.fail(
              selection.modelId === "unavailable"
                ? new UnavailablePiModelError({
                    provider: selection.provider,
                    modelId: selection.modelId,
                  })
                : selection.modelId === "unauthenticated"
                  ? new UnauthenticatedPiModelError({
                      provider: selection.provider,
                      modelId: selection.modelId,
                    })
                  : new UnknownPiModelError({
                      provider: selection.provider,
                      modelId: selection.modelId,
                    }),
            ),
    }),
    Layer.mock(ProjectAccess, {
      rememberSessionLocation: () => Effect.void,
      isAllowed: (path) => Effect.succeed(!deniedPaths.has(path)),
      allowedWorkingDirectories: () =>
        Effect.succeed([...promptRoots].filter((path) => !deniedPaths.has(path))),
    }),
    runtimes,
    renderers,
    familyHarness.layer,
    SessionCatalogChanges.layer,
    ApplicationState.layer.pipe(Layer.provide(storage)),
    Layer.mock(ManagedWorktrees, {
      records: () =>
        Effect.sync(() => {
          listReads.records++;
          return worktreeRecords;
        }),
      awaitSetup: () => Effect.void,
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: (id) => Effect.succeed(archivedEntries.get(id)),
      resolvedEntry: (id) => Effect.succeed(summary(id)),
      resolvedProjects: (path) =>
        Stream.fromIterable(
          [...archivedEntries.values()].filter((entry) => entry.projectPath === path),
        ),
      recordedResolvedIds: () => Effect.succeed(new Set(resolved ? [target] : [])),
      resolvedIds: (at) =>
        Effect.sync(() => {
          listReads.resolutions.push(at.cwd);
          return new Set(resolved ? [target] : []);
        }),
      locate: (id, at) => {
        listReads.locate++;
        return Effect.succeed(
          archivedEntries.has(id)
            ? ("resolved" as const)
            : !sessionsByDirectory.get(at.cwd)?.includes(id)
              ? undefined
              : resolved && id === target
                ? ("resolved" as const)
                : ("active" as const),
        );
      },
      restoreProject: () =>
        Effect.sync(() => {
          restored++;
          resolved = false;
          return undefined;
        }),
    }),
    Layer.mock(TaskInputStorage, {
      recipients: () =>
        Effect.sync(() => {
          redactionReads.inventories++;
          return new Set([...protectedSessions, ...(protectedTarget ? [target] : [])]);
        }),
      isRecipient: (id) =>
        Effect.sync(() => {
          redactionReads.entries++;
          return (id === target && protectedTarget) || protectedSessions.has(id);
        }),
      protectRecipient: (id) =>
        Effect.sync(() => {
          protectedSessions.add(id);
        }),
      authorizeForward: (owner, refs, recipient) =>
        Effect.gen(function* () {
          grants.push({ owner, refs, recipient });
          if (refs.some((ref) => ref !== "allowed"))
            return yield* new AttachmentUploadError({
              operation: "forward",
              message: "Input is not granted to this sender",
            });
          return refs.map((ref) => `granted/${ref}`);
        }),
      resolve: (id, attachments) =>
        Effect.sync(() => {
          grants.push({ resolve: id, attachments });
          return attachments;
        }),
    }),
    // Project icon updates read real image files; every other file operation stays a no-op.
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const node = yield* FileSystem.FileSystem;
        return FileSystem.makeNoop({ stat: node.stat, readFile: node.readFile });
      }),
    ).pipe(Layer.provide(NodeFileSystem.layer)),
  );
  const context = yield* Layer.build(dependencies);
  const requests: RendererRequestCoordinator["Service"] = Context.get(
    context,
    RendererRequestCoordinator,
  );
  yield* Context.get(context, ApplicationState).initialize();
  yield* requests.registerProjectSession(source, "/project");
  const events = Context.get(context, ClientEvents);
  const ready = yield* Queue.unbounded<void>();
  for (const connectionId of [11, 22]) {
    yield* events.application(connectionId).pipe(
      Stream.runForEach((event) =>
        event.type === "renderer-events-ready"
          ? Queue.offer(ready, undefined)
          : Effect.gen(function* () {
              received.push({ connectionId, event });
              yield* Queue.offer(deliveries, { connectionId, event });
            }),
      ),
      Effect.forkScoped,
    );
    yield* Queue.take(ready);
  }
  const options = yield* acquireOptions({ location, sessionId: source, newSession: false }).pipe(
    Effect.provide(context),
  );
  yield* Context.get(context, CakeSessionRuntimes).acquire(options);
  const invoke = options.runtime.currentSessionControl?.invokeAppControl;
  assert.ok(invoke);
  return {
    context,
    familyFiles: familyHarness.files,
    createSession: options.runtime.currentSessionControl?.createSession,
    familyCall: (
      command: "sessions.send" | "sessions.reply",
      input: JsonObject,
      sourceEntryId?: string,
    ) =>
      Effect.promise(async () => {
        const route = options.runtime.currentSessionControl?.routeFamilyMessage;
        assert.ok(route);
        return route(command, input, signal(), undefined, sourceEntryId);
      }),
    storedSchedules: () => storedSchedules,
    compactions,
    toolPrunings,
    compactFailures,
    compactStarted,
    compactRelease,
    pauseCompaction: () => {
      pauseCompaction = true;
    },
    drafts,
    deny: (path: string) => deniedPaths.add(path),
    allowPromptRoot: (path: string) => promptRoots.add(path),
    active,
    pending,
    unavailable,
    failedTurns,
    messageRelease,
    admissions,
    admissionRelease,
    pauseAdmission: () => {
      pauseAdmission = true;
    },
    pauseMessage: () => {
      pauseMessage = true;
    },
    prompts,
    setCompanionContext: (sessionId: string | undefined) => {
      companionContextSessionId = sessionId;
    },
    received,
    deliveries,
    requests,
    requestCalls,
    grants,
    queries,
    runtimeCreates,
    runtimeFactories,
    inspections,
    contextBySession,
    listReads,
    redactionReads,
    sessionsByDirectory,
    archivedEntries,
    worktreeRecords,
    saves,
    saveRelease,
    call: (command: string, input: JsonObject = {}, sourceEntryId?: string) =>
      Effect.promise(() => invoke(command, input, signal(), sourceEntryId)),
    callText: (command: string, input: JsonObject = {}, sourceEntryId?: string) =>
      Effect.promise(() => invoke(command, input, signal(), sourceEntryId)).pipe(
        Effect.map((result) => discoveryResultText(command, result) ?? result),
      ),
    directText: (
      command: string,
      input: JsonValue,
      sender: agentControl.AgentControlCaller = caller,
    ) =>
      agentControl.invoke(command, input, sender).pipe(
        Effect.provide(context),
        Effect.map((result) =>
          result === undefined ? result : (discoveryResultText(command, result) ?? result),
        ),
      ),
    direct: (command: string, input: JsonValue, sender: agentControl.AgentControlCaller = caller) =>
      agentControl.invoke(command, input, sender).pipe(Effect.provide(context)),
    background: (command: string, input: JsonValue) =>
      agentControl.invoke(command, input).pipe(Effect.provide(context)),
    artifact: (command: string, input: JsonValue, callingSessionId?: string) =>
      artifactCommands
        .invoke(command, input, {
          artifactId: "bridge-artifact",
          ...(callingSessionId ? { callingSessionId } : null),
        })
        .pipe(
          Effect.provide(Context.omit(FileSystem.FileSystem)(context)),
          Effect.provide(NodeFileSystem.layer),
        ),
    internalInputs,
    httpRequests,
    gatewayCalls,
    state: () => Context.get(context, ApplicationState).snapshot(),
    pause: () => {
      pauseSave = true;
    },
    saveCount: () => saveCount,
    failNextSave: () => {
      failNextSave = true;
    },
    resolve: () => {
      resolved = true;
    },
    restored: () => restored,
    protect: () => {
      protectedTarget = true;
    },
    protectedSessions,
  };
});

const switchSelection = {
  provider: "fixture",
  modelId: "valid",
  thinkingLevel: "off",
  fastMode: false,
};
it.effect("model switch validates model, identity and Companion before stopping work", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = [...f.runtimeCreates];
    for (const input of [
      { sessionId: target, model: { ...switchSelection, modelId: "invalid" } },
      { sessionId: target, model: { ...switchSelection, modelId: "unavailable" } },
      { sessionId: target, model: { ...switchSelection, modelId: "unauthenticated" } },
      { sessionId: "not-a-session", model: switchSelection },
      { sessionId: SESSION_ASSISTANT_ID, model: switchSelection },
    ]) {
      const result = yield* f.direct("sessions.set-model", input).pipe(Effect.result);
      if (result._tag === "Success") expect(result.success).toMatchObject({ ok: false });
      else expect(result.failure).toBeDefined();
    }
    expect(f.runtimeCreates).toEqual(before);
  }),
);

it.effect("model switch rejects launcher-owned private subagents without stopping", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const prepared = yield* acquireOptions({ location, sessionId: target, newSession: false }).pipe(
      Effect.provide(f.context),
    );
    yield* Context.get(f.context, CakeSessionRuntimes).acquire({
      ...prepared,
      profile: { _tag: "SubagentSession" },
      runtime: {
        ...prepared.runtime,
        auxiliary: true,
        globalControl: undefined,
        sessionControl: undefined,
        currentSessionControl: undefined,
      },
    });
    expect(
      yield* f.direct("sessions.set-model", { sessionId: target, model: switchSelection }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("single-turn tasks") });
  }),
);

it.effect("model switch targets another Project Session and preserves queued input", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const events: string[] = [];
    f.runtimeFactories.set(target, async () => ({
      ...fakeRuntime(
        {
          onEvent: () => undefined,
          cwd: "/project",
          agentDir: "/agent",
          sessionDir: "/sessions",
          requestUi: async () => undefined,
        },
        () => undefined,
      ),
      sessionId: target,
      streaming: true,
      snapshot: async () => ({ ...snapshot, sessionId: target, streaming: true }),
      abort: async () => {
        events.push("stop");
      },
      waitForStop: async () => {
        events.push("terminated");
      },
      applyConfiguration: async () => {
        events.push("configure");
      },
      prompt: async (text) => {
        events.push(text);
      },
      listQueuedMessages: async () => ({ steering: ["Human input"], followUp: [] }),
    }));
    const result = yield* f.direct("sessions.set-model", {
      sessionId: target,
      model: switchSelection,
    });
    expect(result).toMatchObject({ ok: true, sessionId: target, receipt: { status: "continued" } });
    expect(events).toEqual(["stop", "terminated", "configure", "Continue."]);
  }),
);

it.effect("trusted artifact bridge discovers canonical commands and validates help", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const discovery = yield* f.artifact("commands.list", {});
    for (const command of [
      "projects.list",
      "settings.list",
      "artifacts.globals",
      "filesystem.read",
      "shell.run",
      "network.request",
      "chat.prompt",
    ]) {
      expect(JSON.stringify(discovery)).toContain(`"command":"${command}"`);
    }
    expect(yield* f.artifact("commands.help", { command: "filesystem.write" })).toMatchObject({
      ok: true,
      commands: [{ command: "filesystem.write", parameters: { required: ["path", "content"] } }],
    });
    expect(yield* f.artifact("commands.help", { command: "shell.run" })).toMatchObject({
      ok: true,
      commands: [{ command: "shell.run", parameters: { required: ["command", "cwd"] } }],
    });
    const invalidShellInputs: JsonValue[] = [
      { command: "true" },
      { command: "true", cwd: "relative" },
      { command: "true", cwd: "/work", timeoutSeconds: 0 },
      { command: "true", cwd: "/work", unexpected: true },
    ];
    for (const input of invalidShellInputs)
      expect(yield* f.artifact("shell.run", input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ArtifactCommandError", command: "shell.run" },
      });
    expect(yield* f.artifact("commands.help", { command: "not-a-command" })).toMatchObject({
      ok: false,
    });
  }),
);

it.effect(
  "trusted artifact bridge uses canonical backend mutations without a fabricated session",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = [...f.runtimeCreates];
      expect(yield* f.artifact("projects.list", {})).toMatchObject({
        ok: true,
        command: "projects.list",
      });
      expect(
        yield* f.artifact("session-labels.add", { name: "Artifact", color: "blue" }),
      ).toMatchObject({
        ok: true,
        command: "session-labels.add",
        label: { name: "Artifact", scope: "global" },
      });
      expect(f.state().globalSessionLabels).toMatchObject([{ name: "Artifact", color: "blue" }]);
      expect(f.runtimeCreates).toEqual(before);
      expect(f.requestCalls).toEqual([]);
      expect(yield* f.artifact("sessions.reports", {})).toMatchObject({
        ok: false,
        error: "Reports require an actual calling Session.",
      });
      expect((yield* f.artifact("window.not-a-backend-command", {}).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
);

it.effect(
  "trusted artifact filesystem supports text and binary read/write/list on absolute backend paths",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-artifact-bridge-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const path = join(directory, "value.txt");
      expect(
        yield* f.artifact("filesystem.write", { path, content: "hello artifact" }),
      ).toMatchObject({ ok: true, bytesWritten: 14 });
      expect(yield* f.artifact("filesystem.read", { path })).toMatchObject({
        ok: true,
        encoding: "utf8",
        content: "hello artifact",
      });
      expect(
        yield* f.artifact("filesystem.write", { path, content: "AP+A", encoding: "base64" }),
      ).toMatchObject({ bytesWritten: 3 });
      expect(yield* f.artifact("filesystem.read", { path, encoding: "base64" })).toMatchObject({
        content: "AP+A",
      });
      expect(yield* f.artifact("filesystem.list", { path: directory })).toMatchObject({
        entries: ["value.txt"],
      });
      for (const [command, input] of [
        ["filesystem.read", { path: "relative.txt" }],
        ["filesystem.write", { path, content: "%%%", encoding: "base64" }],
        ["filesystem.read", { path, extra: true }],
      ] as const)
        expect((yield* f.artifact(command, input).pipe(Effect.result))._tag).toBe("Failure");
    }),
);

it.effect(
  "trusted artifact network requests preserve headers and HTTP failure responses without a session",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(
        yield* f.artifact("network.request", {
          url: "https://example.test/endpoint",
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer test" },
          body: "{}",
        }),
      ).toMatchObject({ ok: true, status: 418, headers: { "x-test": "response" }, body: "teapot" });
      expect(f.httpRequests).toMatchObject([
        {
          method: "POST",
          url: "https://example.test/endpoint",
          headers: { "content-type": "application/json", authorization: "Bearer test" },
        },
      ]);
      expect(
        yield* f.artifact("network.request", {
          url: "https://example.test",
          responseEncoding: "base64",
        }),
      ).toMatchObject({ body: "dGVhcG90" });
      expect(
        (yield* f.artifact("network.request", { url: "file:///private/path" }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect(
  "artifact chat prompts require an explicit target and retain application provenance",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = [...f.runtimeCreates];
      expect(
        (yield* f.artifact("chat.prompt", { text: "No destination" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.runtimeCreates).toEqual(before);
      expect(
        yield* f.artifact("chat.prompt", { sessionId: target, text: "Artifact update" }),
      ).toMatchObject({ ok: true, sessionId: target, status: "admitted" });
      const prompt = yield* Queue.take(f.prompts);
      expect(prompt.sessionId).toBe(target);
      expect(prompt.text).toContain("Artifact-authored application input, not a user message.");
      expect(prompt.text).not.toContain("callingSessionId");
      expect(f.internalInputs).toMatchObject([
        {
          _tag: "AgentUpdate",
          update: { text: "Artifact update", source: { href: "cake://artifact/bridge-artifact" } },
        },
      ]);
      expect(
        yield* f.artifact(
          "chat.prompt",
          { sessionId: target, text: "Agent-origin artifact update" },
          source,
        ),
      ).toMatchObject({ ok: true, sessionId: target });
      const agentPrompt = yield* Queue.take(f.prompts);
      expect(agentPrompt.text).toContain(`"callingSessionId":"${source}"`);
      expect(agentPrompt.sessionId).toBe(target);
      expect(f.runtimeCreates.every((id) => id === source || id === target)).toBe(true);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect(
  "agent artifact commands discover and invoke the same validated bridge without a fake caller",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = [...f.runtimeCreates];
      expect(
        yield* f.background("artifacts.commands", { command: "network.request" }),
      ).toMatchObject({ ok: true, commands: [{ command: "network.request" }] });
      expect(
        yield* f.background("artifacts.command", {
          lineageId: "bridge-artifact",
          command: "network.request",
          input: { url: "https://example.test" },
        }),
      ).toMatchObject({ ok: true, status: 418 });
      expect(
        (yield* f
          .background("artifacts.command", {
            lineageId: "bridge-artifact",
            command: "network.request",
            input: { url: "file:///private" },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.runtimeCreates).toEqual(before);
      expect(f.gatewayCalls).toEqual([]);
    }),
);

it.effect(
  "artifact bridge uses only the actual calling session's canonical gateway for native commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      expect(
        (yield* f.artifact("settings.open", { page: "general" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.gatewayCalls).toEqual([]);
      expect(yield* f.artifact("settings.open", { page: "general" }, source)).toEqual({
        opened: true,
        sessionId: source,
      });
      expect(
        (yield* f.artifact("settings.open", { page: "invalid" }, source).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.artifact("settings.open", { page: "general" }, CAKE_CHAT_SESSION_ID)).toEqual(
        { opened: true, sessionId: CAKE_CHAT_SESSION_ID },
      );
      expect(f.gatewayCalls).toEqual([
        {
          sessionId: source,
          command: "settings.open",
          input: { page: "general" },
          fullControl: false,
        },
        {
          sessionId: source,
          command: "settings.open",
          input: { page: "invalid" },
          fullControl: false,
        },
        {
          sessionId: CAKE_CHAT_SESSION_ID,
          command: "settings.open",
          input: { page: "general" },
          fullControl: true,
        },
      ]);
    }),
);

it.effect(
  "compacts an authorized target through backend controls and awaits runtime completion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.pauseCompaction();
      const operation = yield* f
        .call("sessions.compact", { sessionId: "00000022", instructions: "Keep decisions" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(f.compactStarted);
      expect(operation.pollUnsafe()).toBeUndefined();
      expect(f.compactions).toEqual([{ sessionId: target, instructions: "Keep decisions" }]);
      yield* Deferred.succeed(f.compactRelease, undefined);
      expect(yield* Fiber.join(operation)).toMatchObject({
        ok: true,
        command: "sessions.compact",
        results: [{ reference: "00000022", sessionId: target, status: "compacted" }],
      });
      expect(yield* f.call("sessions.compact", { sessionId: target })).toMatchObject({
        ok: true,
        results: [{ status: "unchanged" }],
      });
      expect(f.requestCalls).toEqual([]);
      expect(f.restored()).toBe(0);
      expect(f.saveCount()).toBe(0);
    }),
);

it.effect("tool pruning routes from Project Session controls and awaits actual completion", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.pauseCompaction();
    const operation = yield* f
      .call("sessions.tool-prune", { sessionId: "00000022" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(f.compactStarted);
    expect(operation.pollUnsafe()).toBeUndefined();
    expect(f.toolPrunings).toEqual([target]);
    expect((yield* f.direct("sessions.tool-prune", {}).pipe(Effect.result))._tag).toBe("Failure");
    expect(f.compactions).toEqual([]);
    yield* Deferred.succeed(f.compactRelease, undefined);
    expect(yield* Fiber.join(operation)).toMatchObject({
      ok: true,
      command: "sessions.tool-prune",
      results: [{ reference: "00000022", sessionId: target, status: "compacted" }],
    });
    expect(yield* f.call("sessions.tool-prune", { sessionId: "missing" })).toMatchObject({
      ok: false,
      results: [{ status: "invalid" }],
    });
    expect(f.requestCalls).toEqual([]);
    expect(f.restored()).toBe(0);
    expect(f.saveCount()).toBe(0);
  }),
);

it.effect("unattended artifacts tool-prune explicit targets without impersonation or turns", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.pauseCompaction();
    const operation = yield* f
      .artifact("sessions.tool-prune", { sessionId: target })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(f.compactStarted);
    expect(operation.pollUnsafe()).toBeUndefined();
    expect(f.toolPrunings).toEqual([target]);
    yield* Deferred.succeed(f.compactRelease, undefined);
    expect(yield* Fiber.join(operation)).toMatchObject({
      ok: true,
      command: "sessions.tool-prune",
      results: [{ reference: target, sessionId: target, status: "compacted" }],
    });
    // Resolved history stays resolved. Tool pruning deliberately repeats branch creation;
    // it is not a durable request-id replay.
    f.resolve();
    expect(yield* f.artifact("sessions.tool-prune", { sessionId: "00000022" })).toMatchObject({
      ok: true,
      results: [{ sessionId: target, status: "compacted" }],
    });
    expect(f.toolPrunings).toEqual([target, target]);
    expect(yield* f.background("sessions.tool-prune", { sessionId: target })).toMatchObject({
      ok: false,
    });
    for (const command of ["sessions.compact", "sessions.compact-batch"])
      expect(
        yield* f.artifact(
          command,
          command === "sessions.compact" ? { sessionId: target } : { sessionIds: [target] },
        ),
      ).toMatchObject({ ok: false });
    expect(f.runtimeCreates).toEqual([source, target, target]);
    expect(f.compactions).toEqual([]);
    expect(f.gatewayCalls).toEqual([]);
    expect(f.internalInputs).toEqual([]);
    expect(yield* Queue.size(f.prompts)).toBe(0);
    expect(f.requestCalls).toEqual([]);
    expect(f.restored()).toBe(0);
    expect(f.saveCount()).toBe(0);
  }),
);

it.effect(
  "artifact host authority reaches registered projects but never widens real session callers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const project = f.state().projects[0];
      assert.ok(project);
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
        }),
      );
      f.sessionsByDirectory.set("/project", [source, target]);
      f.sessionsByDirectory.set("/other", [third]);
      // A genuine session caller keeps its own project scope, even through the artifact bridge.
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: third }, source)).toMatchObject({
        ok: false,
        results: [{ status: "unauthorized" }],
      });
      f.deny("/other");
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: third })).toMatchObject({
        ok: false,
        results: [{ status: "unauthorized" }],
      });
      expect(f.toolPrunings).toEqual([]);
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: target })).toMatchObject({
        ok: true,
      });
      // Removing a project removes host routing authority too, even when its identity is known elsewhere.
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: state.projects.filter((item) => item.path !== "/other"),
        }),
      );
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: third })).toMatchObject({
        ok: false,
        results: [{ status: "invalid" }],
      });
      expect(f.toolPrunings).toEqual([target]);
      // A separate registered and accessible project needs no creator/session identity.
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/accessible", name: "Accessible" }],
        }),
      );
      f.sessionsByDirectory.set("/accessible", [third]);
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: third })).toMatchObject({
        ok: true,
      });
      expect(f.toolPrunings).toEqual([target, third]);
      expect(f.gatewayCalls).toEqual([]);
      expect(f.restored()).toBe(0);
    }),
);

it.effect("artifact tool pruning rejects malformed, ambiguous and session-relative targets", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const collision = "11111111-1111-4111-8111-000000000022";
    f.sessionsByDirectory.set("/project", [source, target, third, collision]);
    for (const sessionId of [
      "parent",
      "Same title",
      "00000022",
      "00000000-0000-4000-8000-00000000ffff",
    ]) {
      expect(yield* f.artifact("sessions.tool-prune", { sessionId })).toMatchObject({
        ok: false,
        results: [{ status: "invalid" }],
      });
    }
    const invalidInputs: JsonValue[] = [
      {},
      { sessionId: "" },
      { sessionId: null },
      { sessionId: target, callingSessionId: source },
      { sessionId: target, projectPath: "/project" },
    ];
    for (const input of invalidInputs) {
      expect(yield* f.artifact("sessions.tool-prune", input).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ArtifactCommandError" },
      });
    }
    expect(f.toolPrunings).toEqual([]);
    expect(f.runtimeCreates).toEqual([source]);
    expect(f.restored()).toBe(0);
  }),
);

it.effect(
  "artifact tool pruning leaves streaming, queued and recovery-blocked targets untouched",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.direct("sessions.context", { sessionId: target });
      const recovery = Context.get(f.context, RuntimeRecoveryStorage);
      f.active.add(target);
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: target })).toMatchObject({
        results: [{ status: "busy" }],
      });
      f.active.delete(target);
      f.pending.add(target);
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: target })).toMatchObject({
        results: [{ status: "busy" }],
      });
      expect(f.pending.has(target)).toBe(true);
      f.pending.delete(target);
      const blocked: RuntimeRecoveryRecord = {
        ...location,
        sessionId: third,
        profile: "ProjectSession",
        transcriptPersisted: true,
        inputs: [],
        state: "blocked",
        issue: "Requires review",
      };
      yield* recovery.update(blocked);
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: third })).toMatchObject({
        results: [{ status: "busy" }],
      });
      expect(yield* recovery.get(third)).toEqual(blocked);
      yield* recovery.update({
        ...blocked,
        state: "active",
        inputs: [
          { turnId: "pending", text: "Wait", delivery: "prompt", attachments: [], markdown: true },
        ],
      });
      const before = yield* recovery.get(third);
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: third })).toMatchObject({
        results: [{ status: "busy" }],
      });
      expect(yield* recovery.get(third)).toEqual(before);
      expect(f.toolPrunings).toEqual([]);
      expect(f.runtimeCreates).toEqual([source, target]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.restored()).toBe(0);
    }),
);

it.effect(
  "a persistent QuickJS artifact dispatches unattended compaction through the production host",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-artifact-tool-prune-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      // Pi's SDK reads its credential root globally; keep it aligned with this isolated fixture.
      vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const sessionDir = join(directory, "sessions");
      const manager = SessionManager.create(
        directory,
        cakeWorkspaceSessionDirectory(directory, sessionDir),
      );
      manager.appendMessage({ role: "user", content: "Inspect this", timestamp: 1 });
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      manager.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "large.ts" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "Large tool output" }],
        isError: false,
        timestamp: 3,
      });
      const assistantId = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Inspection complete" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture",
        usage,
        stopReason: "stop",
        timestamp: 4,
      });
      const sessionId = manager.getSessionId();
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      const f = yield* fixture();
      const project = f.state().projects[0];
      assert.ok(project);
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: directory, name: "Runtime fixture" }],
        }),
      );
      const saveCount = f.saveCount();
      f.sessionsByDirectory.set(directory, [sessionId]);
      f.contextBySession.set(sessionId, { estimatedTokens: 100 });
      // Keep catalog/storage routing isolated, but acquire the real Pi target runtime and transcript.
      f.runtimeFactories.set(sessionId, () =>
        createCakeSessionRuntime({
          cwd: directory,
          agentDir: join(directory, "agent"),
          sessionDir,
          sessionId,
          requestUi: async () => undefined,
          onEvent: () => undefined,
        }),
      );
      const runtimeContext = yield* Layer.build(ArtifactRuntimeLive).pipe(
        Effect.provide(f.context),
      );
      const context = Context.merge(f.context, runtimeContext);
      yield* Layer.build(ArtifactRuntimeHostLive).pipe(Effect.provide(context));
      const runtime = Context.get(context, ArtifactRuntime);
      const targetArtifact = {
        lineageId: decodeArtifactLineageId("unattended-tool-prune"),
        revision: 1,
        runtime: Schema.decodeUnknownSync(ArtifactRuntimeDescriptor)({
          source:
            'return { tools: { prune: ({ sessionId }) => cake("sessions.tool-prune", { sessionId }) } };',
          tools: [
            {
              name: "prune",
              description: "Prune tools from an explicit idle target without a model call",
              inputSchema: {
                type: "object",
                properties: { sessionId: { type: "string" } },
                required: ["sessionId"],
                additionalProperties: false,
              },
              outputSchema: { type: "object" },
            },
          ],
        }),
      };
      for (let index = 0; index < 2; index++)
        expect(
          yield* runtime.call({ target: targetArtifact, name: "prune", input: { sessionId } }),
        ).toMatchObject({
          ok: true,
          results: [{ sessionId, status: "compacted" }],
        });
      expect((yield* runtime.status(targetArtifact.lineageId)).running).toBe(true);
      yield* runtime.stop(targetArtifact.lineageId);
      const persisted = SessionManager.open(
        sessionFile,
        cakeWorkspaceSessionDirectory(directory, sessionDir),
        directory,
      );
      expect(persisted.getSessionId()).toBe(sessionId);
      expect(persisted.getEntry(assistantId)).toBeDefined();
      expect(persisted.getTree()).toHaveLength(3);
      const messages = persisted.buildSessionContext().messages;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
      expect(JSON.stringify(messages)).not.toContain("Large tool output");
      expect(JSON.stringify(messages)).not.toContain("toolCall");
      expect(JSON.stringify(messages)).toContain("Inspection complete");
      expect(f.toolPrunings).toEqual([]);
      expect(f.runtimeCreates).toEqual([source, sessionId, sessionId]);
      expect(f.gatewayCalls).toEqual([]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.saveCount()).toBe(saveCount);
      expect(f.restored()).toBe(0);
    }),
);

it.effect(
  "bulk compaction preserves order, deduplicates aliases and retains partial failures",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.compactFailures.add(third);
      const sessionIds = [target, "00000022", "not-a-session", third, third, source];
      expect(yield* f.call("sessions.compact-batch", { sessionIds })).toMatchObject({
        ok: false,
        results: [
          { reference: target, sessionId: target, status: "compacted" },
          { reference: "00000022", sessionId: target, status: "compacted", duplicateOf: 0 },
          { reference: "not-a-session", status: "invalid" },
          {
            reference: third,
            sessionId: third,
            status: "failed",
            message: "Compaction provider failed",
          },
          { reference: third, status: "failed", duplicateOf: 3 },
          { reference: source, status: "compacted" },
        ],
      });
      expect(f.compactions.map((item) => item.sessionId)).toEqual([target, third, source]);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect("skips busy targets and compacts accessible resolved history without restore", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.direct("sessions.context", { sessionId: target });
    f.active.add(target);
    expect(yield* f.call("sessions.compact", { sessionId: target })).toMatchObject({
      ok: false,
      results: [{ status: "busy" }],
    });
    f.active.delete(target);
    f.resolve();
    expect(yield* f.call("sessions.compact", { sessionId: target })).toMatchObject({
      ok: true,
      results: [{ status: "compacted" }],
    });
    expect(f.compactions).toEqual([{ sessionId: target }]);
    expect(f.restored()).toBe(0);
    expect(f.saveCount()).toBe(0);
  }),
);

it.effect(
  "Project Chat compaction is project-scoped; global Cake Chat still requires path authorization",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const project = f.state().projects[0];
      assert.ok(project);
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
        }),
      );
      f.sessionsByDirectory.set("/other", [third]);
      f.sessionsByDirectory.set("/project", [source, target]);
      const projectChat = {
        kind: "cake-chat" as const,
        sessionId: projectChatSessionId("/project"),
        title: "Project Chat",
      };
      for (const sender of [
        caller,
        projectChat,
        { ...projectChat, sessionId: projectChatSessionId("/unknown") },
      ]) {
        expect(
          yield* f.direct("sessions.compact-batch", { sessionIds: [third, target] }, sender),
        ).toMatchObject({
          ok: false,
          results: [
            { status: "unauthorized" },
            {
              status:
                sender.sessionId === projectChatSessionId("/unknown")
                  ? "unauthorized"
                  : sender === caller
                    ? "compacted"
                    : "unchanged",
            },
          ],
        });
      }
      const global = {
        kind: "cake-chat" as const,
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      };
      f.deny("/other");
      expect(yield* f.direct("sessions.compact", { sessionId: third }, global)).toMatchObject({
        ok: false,
        results: [{ status: "unauthorized" }],
      });
      expect(f.compactions.every((item) => item.sessionId === target)).toBe(true);
      // A different, authorized project is reachable only from the global caller.
      f.sessionsByDirectory.set("/third-project", [third]);
      f.sessionsByDirectory.delete("/other");
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/third-project", name: "Third" }],
        }),
      );
      expect(yield* f.direct("sessions.compact", { sessionId: third }, global)).toMatchObject({
        ok: true,
        results: [{ status: "compacted" }],
      });
    }),
);

it.effect("compacts resolved family child history without migrating its resolution metadata", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Context.get(f.context, SessionFamilyStorage).addChild({
      familyId: crypto.randomUUID(),
      parentSessionId: target,
      parentWorkingDirectory: "/project",
      childSessionId: third,
      childWorkingDirectory: "/project",
      requestId: crypto.randomUUID(),
      projectPath: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    f.resolve();
    const archive = Context.get(f.context, SessionArchiveStorage);
    const result = yield* agentControl
      .invoke("sessions.compact", { sessionId: third }, caller)
      .pipe(
        Effect.provideService(SessionArchiveStorage, {
          ...archive,
          locate: (id, at) =>
            id === third ? Effect.succeed("resolved" as const) : archive.locate(id, at),
        }),
        Effect.provide(f.context),
      );
    expect(result).toMatchObject({
      ok: true,
      results: [{ sessionId: third, status: "compacted" }],
    });
    expect(f.restored()).toBe(0);
  }),
);

it.effect(
  "retired worktrees and saved drafts are unavailable without any runtime acquisition",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.worktreeRecords.push({
        worktreePath: "/retired",
        projectPath: "/project",
        branch: "agent/retired",
        baseBranch: "main",
        createdAt: "2026-01-01",
        state: "resolved",
      });
      f.sessionsByDirectory.set("/project", [source, third]);
      f.sessionsByDirectory.set("/retired", [target]);
      f.archivedEntries.set(target, {
        version: 2,
        sessionId: target,
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/retired",
        activeRoot: "/cake/sessions",
        resolvedRoot: "/cake/resolved",
        createdAt: "2026-01-01",
        modifiedAt: "2026-01-01",
        worktreeName: "retired",
      });
      f.drafts.push({
        sessionId: "00000000-0000-4000-8000-00000000abcd",
        projectPath: "/project",
        workingDirectory: "/project",
        title: "Saved",
        text: "Not activated",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-01-01",
        modifiedAt: "2026-01-01",
        revision: 1,
        status: "saved",
      });
      expect(
        yield* f.call("sessions.compact-batch", {
          sessionIds: [target, "0000abcd", "00000000-0000-4000-8000-00000000ffff"],
        }),
      ).toMatchObject({
        ok: false,
        results: [{ status: "unavailable" }, { status: "unavailable" }, { status: "invalid" }],
      });
      for (const sessionId of [target, "0000abcd"]) {
        expect(yield* f.artifact("sessions.tool-prune", { sessionId })).toMatchObject({
          ok: false,
          results: [{ status: "unavailable" }],
        });
      }
      f.worktreeRecords.splice(0);
      f.sessionsByDirectory.delete("/retired");
      expect(yield* f.artifact("sessions.tool-prune", { sessionId: target })).toMatchObject({
        ok: false,
        results: [{ status: "unavailable" }],
      });
      for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")]) {
        expect(yield* f.artifact("sessions.tool-prune", { sessionId })).toMatchObject({
          ok: false,
        });
      }
      expect(f.runtimeCreates).toEqual([source]);
      expect(f.compactions).toEqual([]);
      expect(f.toolPrunings).toEqual([]);
      expect(f.restored()).toBe(0);
      expect(f.saveCount()).toBe(0);
    }),
);

it.effect(
  "completed to-do associations can drive an explicit batch without automatic compaction or lifecycle edits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const created = yield* projectTodos
        .create("/project", {
          title: "Completed work",
          description: "A completed user request.",
          associations: [
            { kind: "session", sessionId: target, title: "Implementation" },
            { kind: "source", ref: messageReference(third, "entry"), title: "Report" },
          ],
        })
        .pipe(Effect.provide(f.context));
      yield* projectTodos
        .update("/project", { id: created.id, expectedRevision: 0, state: "done" })
        .pipe(Effect.provide(f.context));
      const todos = yield* projectTodos.list("/project").pipe(Effect.provide(f.context));
      const sessionIds = todos.items
        .filter((item) => item.state === "done")
        .flatMap((item) =>
          item.associations.flatMap((link) => {
            const id =
              link.kind === "session"
                ? link.sessionId
                : link.kind === "source"
                  ? parseSessionLink(link.ref)?.sessionId
                  : undefined;
            return id ? [id] : [];
          }),
        );
      expect(sessionIds).toEqual([target, third]);
      expect(f.compactions).toEqual([]);
      const saveCount = f.saveCount();
      const projectChat = {
        kind: "cake-chat" as const,
        sessionId: projectChatSessionId("/project"),
        title: "Project Chat",
      };
      expect(yield* f.direct("sessions.compact-batch", { sessionIds }, projectChat)).toMatchObject({
        ok: true,
        results: [
          { sessionId: target, status: "compacted" },
          { sessionId: third, status: "compacted" },
        ],
      });
      expect(yield* projectTodos.list("/project").pipe(Effect.provide(f.context))).toEqual(todos);
      expect(f.saveCount()).toBe(saveCount);
      expect(f.restored()).toBe(0);
    }),
);

it.effect("compaction is discoverable in permanent chat tools with bounded bulk inputs", () =>
  Effect.gen(function* () {
    const tools = backendAgentTools();
    for (const command of ["sessions.compact", "sessions.compact-batch"]) {
      const tool = tools.find((item) => item.command === command);
      expect(tool?.guidance?.join(" ")).toContain("todos.list/read");
      expect(tool?.guidance?.join(" ")).toContain("never aborted or queued");
      expect(tool?.examples?.length).toBeGreaterThan(0);
    }
    const f = yield* fixture();
    for (const sessionIds of [[], Array.from({ length: 101 }, () => target)]) {
      const result = yield* f.direct("sessions.compact-batch", { sessionIds }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
    expect(f.compactions).toEqual([]);
  }),
);

it.effect(
  "routes scoped report discovery, bounded reads and explicit handling through real agent controls",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      yield* storage.deferReferenceNotice({
        id: "report-1",
        recipientSessionId: caller.sessionId,
        text: "Exact worker handoff evidence",
      });
      yield* storage.deferReferenceNotice({
        id: "other-report",
        recipientSessionId: "other-chat",
        text: "Private other handoff",
      });
      const listing = yield* f.call("sessions.reports");
      assert.ok(listing && typeof listing === "object" && "total" in listing);
      assert.equal(listing.total, 1);
      assert.ok(!JSON.stringify(listing).includes("Exact worker handoff"));
      const read = yield* f.call("sessions.reports.read", { id: "report-1", offset: 6, limit: 6 });
      assert.ok(read && typeof read === "object" && "text" in read && "nextOffset" in read);
      assert.equal(read.text, "worker");
      assert.equal(read.nextOffset, 12);
      assert.equal(
        (yield* Effect.result(f.direct("sessions.reports.read", { id: "other-report" })))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          f.direct("sessions.reports.acknowledge", {
            ids: ["report-1"],
            disposition: "communicated",
            communicatedText: "A planned answer",
          }),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* storage.state()).deferredReferences?.length, 2);
    }),
);

it.effect(
  "multiwindow presentation and device requests remain bound to the caller, not the message target",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      yield* f.requests.registerProjectSession(target, "/project");
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: target }, 22);
      yield* f.call("project.settings.update", { changes: { customInstructions: "One owner" } });
      const notice = yield* Queue.take(f.deliveries);
      expect(notice).toMatchObject({
        connectionId: 11,
        event: {
          type: "agent-action-notice",
          source: { sessionId: source },
          message: "Updated Cake Project settings",
        },
      });
      const waiting = yield* f.call("app.user-selection").pipe(Effect.forkChild);
      const request = yield* Queue.take(f.deliveries);
      assert.equal(request.event.type, "project-session-control-requested");
      expect(request.connectionId).toBe(11);
      expect(
        yield* f.requests
          .respondProjectControl(22, source, request.event.controlRequestId, { ok: true })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      yield* f.requests.respondProjectControl(11, source, request.event.controlRequestId, {
        ok: true,
        text: "Owning window",
      });
      expect(yield* Fiber.join(waiting)).toEqual({ ok: true, text: "Owning window" });
      expect(f.requestCalls).toHaveLength(1);
    }),
);

it.effect(
  "resolved families reject generic messaging instead of silently restoring; family inspection is backend-owned",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).addChild({
        familyId: crypto.randomUUID(),
        parentSessionId: target,
        parentWorkingDirectory: "/project",
        childSessionId: third,
        childWorkingDirectory: "/project",
        requestId: crypto.randomUUID(),
        projectPath: "/project",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(
        yield* f.direct("sessions.list-family", {}, { ...caller, sessionId: target }),
      ).toMatchObject({
        ok: true,
        rootSessionId: target,
        sessions: [{ sessionId: target }, { sessionId: third }],
      });
      f.resolve();
      expect(
        yield* f
          .call("sessions.send", { sessionId: target, text: "Do not restore a family" })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.restored()).toBe(0);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect("project labels remain scoped to their Project before any assignment mutation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [
          ...state.projects,
          {
            path: "/other",
            name: "Other",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const result = yield* f.call("session-labels.add", {
      projectPath: "/other",
      name: "Other only",
      color: "blue",
    });
    const { label } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ label: Schema.Struct({ id: Schema.String }) }),
    )(result);
    expect(
      yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [label.id] }),
    ).toMatchObject({ ok: false, error: "A selected label belongs to a different Project." });
    expect(f.state().projects[0]?.workflow?.assignments ?? []).toEqual([]);
  }),
);

it.effect(
  "backend mutations preserve selected-Project authorization and resolved-session label policy",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.deny("/project");
      expect(
        yield* f.call("project.settings.update", { changes: { customInstructions: "Denied" } }),
      ).toMatchObject({ ok: false });
      expect(
        yield* f
          .call("session-labels.add", { projectPath: "/project", name: "Denied", color: "blue" })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [] }).pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.saveCount()).toBe(0);
      f.resolve();
      expect(
        yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [] }),
      ).toMatchObject({ ok: false });
    }),
);

it.effect("bounds label discovery and filters project/name before pagination", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (let index = 0; index < 24; index++) {
      yield* f.call("session-labels.add", {
        name: `Label ${index}`,
        color: "cyan",
        ...(index % 2 ? { projectPath: "/project" } : {}),
      });
    }
    const first = yield* f.call("session-labels.list");
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        total: Schema.Int,
        nextOffset: Schema.NullOr(Schema.Int),
        labels: Schema.Array(Schema.Unknown),
      }),
    )(first);
    expect(decoded.total).toBe(24);
    expect(decoded.labels).toHaveLength(20);
    expect(decoded.nextOffset).toBe(20);
    expect(yield* f.call("session-labels.list", { offset: 20, limit: 50 })).toMatchObject({
      total: 24,
      offset: 20,
      nextOffset: null,
    });
    expect(
      yield* f.call("session-labels.list", {
        projectPath: "/unregistered",
        query: "Label 1",
        limit: 2,
        offset: 1,
      }),
    ).toMatchObject({
      total: 5,
      offset: 1,
      nextOffset: 3,
      labels: [{ name: "Label 12" }, { name: "Label 14" }],
    });
    expect(yield* f.call("session-labels.list", { query: "absent" })).toMatchObject({
      total: 0,
      nextOffset: null,
      labels: [],
    });
    expect(yield* f.call("session-labels.list", { limit: 51 }).pipe(Effect.exit)).toMatchObject({
      _tag: "Failure",
    });
  }),
);

it.effect(
  "lets coding sessions explicitly update only their registered Project Chat with readback and live authorization",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* upsertProject("/other", "Other").pipe(Effect.provide(f.context));
      yield* setCakeChatPreferences({
        ...defaultCakeChatPreferences(),
        instructions: "Existing shared Zombie Madness rule must stay.",
      }).pipe(Effect.provide(f.context));
      yield* f.call("project.settings.update", {
        changes: {
          customInstructions: "Existing coding guidance.",
          projectChatInstructions: "Original chat guidance.",
        },
      });
      f.deny("/worktrees/coding-session");
      const options = yield* acquireOptions({
        location: { ...location, workingDirectory: "/worktrees/coding-session" },
        sessionId: source,
        newSession: false,
      }).pipe(Effect.provide(f.context));
      const registry = new CakeOperationRegistry(
        projectCakeOperations(options.runtime)({
          host: { appendEntry: () => undefined },
          api: () => {
            throw new Error("No renderer or shared-instruction fallback is permitted");
          },
          sessionId: () => source,
          publishSnapshot: async () => undefined,
          getAvailableOfType: async () => [],
        }),
      );
      const context = {
        signal: signal(),
        toolCallId: "project-guidance",
        runtime: { sessionId: source, assistantEntryId: "assistant" },
      };
      const read = yield* Effect.promise(() =>
        registry.invoke(
          {
            command: "settings.project-chat.get",
            input: { projectPath: "/project" },
          },
          context,
        ),
      );
      expect(read.details).toMatchObject({
        result: { projectPath: "/project", instructions: "Original chat guidance." },
      });
      expect(registry.operationHelp("settings.project-chat.update")).toContain(
        "Never silently substitute settings.cake-chat.update",
      );
      const input = {
        projectPath: "/project",
        expectedInstructions: "Original chat guidance.",
        instructions:
          "Original chat guidance. Shared checkout unless explicitly asked for a worktree.",
      };
      const saved = yield* Effect.promise(() =>
        registry.invoke({ command: "settings.project-chat.update", input }, context),
      );
      expect(saved.details).toMatchObject({
        result: { projectPath: "/project", instructions: input.instructions },
      });
      const readback = yield* Effect.promise(() =>
        registry.invoke(
          { command: "settings.project-chat.get", input: { projectPath: "/project" } },
          context,
        ),
      );
      expect(readback.details).toMatchObject({ result: { instructions: input.instructions } });
      expect(yield* f.call("project.settings.get")).toMatchObject({
        projectPath: "/project",
        settings: {
          projectChatInstructions: input.instructions,
          customInstructions: "Existing coding guidance.",
        },
      });
      expect(options.runtime.additionalSystemPrompt).not.toContain(input.instructions);
      expect(f.state().cakeChatPreferences?.instructions).toBe(
        "Existing shared Zombie Madness rule must stay.",
      );
      expect(f.state().projects.find((p) => p.path === "/other")?.settings).toBeUndefined();
      yield* Effect.promise(() =>
        expect(
          registry.invoke({ command: "settings.project-chat.update", input }, context),
        ).rejects.toThrow(/changed/),
      );
      for (const projectPath of ["/other", "/worktrees/coding-session", "/missing"]) {
        yield* Effect.promise(() =>
          expect(
            registry.invoke(
              { command: "settings.project-chat.get", input: { projectPath } },
              context,
            ),
          ).rejects.toThrow(/calling conversation/),
        );
        yield* Effect.promise(() =>
          expect(
            registry.invoke(
              {
                command: "settings.project-chat.update",
                input: { ...input, projectPath, expectedInstructions: "" },
              },
              context,
            ),
          ).rejects.toThrow(/calling conversation/),
        );
      }
      f.failNextSave();
      yield* Effect.promise(() =>
        expect(
          registry.invoke(
            {
              command: "settings.project-chat.update",
              input: {
                ...input,
                expectedInstructions: input.instructions,
                instructions: "Not persisted.",
              },
            },
            context,
          ),
        ).rejects.toThrow(/Injected storage failure/),
      );
      const afterFailure = yield* Effect.promise(() =>
        registry.invoke(
          { command: "settings.project-chat.get", input: { projectPath: "/project" } },
          context,
        ),
      );
      expect(afterFailure.details).toMatchObject({ result: { instructions: input.instructions } });
      f.deny("/project");
      const saves = f.saveCount();
      yield* Effect.promise(() =>
        expect(
          registry.invoke(
            {
              command: "settings.project-chat.update",
              input: {
                ...input,
                expectedInstructions: input.instructions,
                instructions: "Not authorized.",
              },
            },
            context,
          ),
        ).rejects.toThrow(/not selected by the user/),
      );
      expect(f.saveCount()).toBe(saves);
      expect(
        f.state().projects.find((p) => p.path === "/project")?.settings?.projectChatInstructions,
      ).toBe(input.instructions);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect("sessionInfoReusesAuthoritativeRoute", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (let i = 0; i < 4; i++)
      f.worktreeRecords.push({
        worktreePath: `/unrelated-${i}`,
        projectPath: "/project",
        branch: `agent/unrelated-${i}`,
        baseBranch: "main",
        createdAt: "2026-01-01",
      });
    const before = {
      records: f.listReads.records,
      locate: f.listReads.locate,
      entries: f.listReads.entries.length,
      ids: f.listReads.ids.length,
      creates: f.runtimeCreates.length,
    };
    expect(yield* f.direct("sessions.info", { sessionId: target })).toMatchObject({
      ok: true,
      session: {
        sessionId: target,
        workspacePath: "/project",
        deepLink: `cake://session/${target}`,
        lifecycle: "active",
        resolved: false,
      },
      status: "idle",
    });
    // One collision-checked route search, then one authoritative namespace check.
    expect(f.listReads.locate - before.locate).toBe(6);
    expect(f.listReads.records - before.records).toBe(1);
    expect(f.listReads.entries.slice(before.entries)).toEqual([]);
    expect(f.listReads.ids.length - before.ids).toBe(0);
    expect(f.inspections).toEqual([]);
    expect(f.runtimeCreates.length).toBe(before.creates);
  }),
);

it.effect("canonical session info retains authoritative existence validation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* Effect.flip(
        f.direct("sessions.info", { sessionId: "00000000-0000-4000-8000-00000000ffff" }),
      ),
    ).toMatchObject({ message: expect.stringContaining("could not find Project Session") });
    expect(f.inspections).toEqual([]);
  }),
);

it.effect("session info rejects canonical identity location collisions before inspection", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.worktreeRecords.push({
      worktreePath: "/collision",
      projectPath: "/project",
      branch: "agent/collision",
      baseBranch: "main",
      createdAt: "2026-01-01",
    });
    const archive = Context.get(f.context, SessionArchiveStorage);
    const context = Context.add(f.context, SessionArchiveStorage, {
      ...archive,
      locate: (id, at) =>
        id === target ? Effect.succeed("active" as const) : archive.locate(id, at),
    });
    expect(
      yield* Effect.flip(
        agentControl
          .invoke("sessions.info", { sessionId: target }, caller)
          .pipe(Effect.provide(context)),
      ),
    ).toMatchObject({ message: `Project Session ID collision detected: ${target}` });
    expect(f.inspections).toEqual([]);
  }),
);

it.effect("executes settings, label lifecycle, and authoritative inspection with no renderer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* f.call("settings.update", { key: "instructions.global", value: " Backend-owned " }),
    ).toMatchObject({ ok: true, value: { previous: "", value: "Backend-owned" } });
    expect(
      yield* f.call("project.settings.update", {
        changes: { customInstructions: "Project-owned", projectChatInstructions: "Chat-owned" },
      }),
    ).toMatchObject({
      ok: true,
      settings: { customInstructions: "Project-owned", projectChatInstructions: "Chat-owned" },
    });
    expect(yield* f.call("project.settings.get", {})).toMatchObject({
      projectPath: "/project",
      settings: { customInstructions: "Project-owned", projectChatInstructions: "Chat-owned" },
    });
    yield* f.call("project.settings.update", {
      changes: { customInstructions: "Updated coding only" },
    });
    expect(yield* f.call("project.settings.get", {})).toMatchObject({
      settings: {
        customInstructions: "Updated coding only",
        projectChatInstructions: "Chat-owned",
      },
    });
    // Cake Chat's explicitly targeted writer accepts every worktree setting and patches only them.
    yield* f.call("projects.settings.update", {
      projectPath: "/project",
      changes: {
        worktreeRemoveCommand: "tree remove",
        worktreeCommandTimeoutSeconds: 600,
        worktreeLanding: "pull-request",
      },
    });
    expect(yield* f.call("projects.settings.get", { projectPath: "/project" })).toMatchObject({
      projectPath: "/project",
      settings: {
        worktreeRemoveCommand: "tree remove",
        worktreeCommandTimeoutSeconds: 600,
        worktreeLanding: "pull-request",
        customInstructions: "Updated coding only",
        projectChatInstructions: "Chat-owned",
      },
    });
    const added = yield* f.call("session-labels.add", { name: "Review", color: "cyan" });
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ label: Schema.Struct({ id: Schema.String }) }),
    )(added);
    const labelId = result.label.id;
    yield* f.call("sessions.set-labels", { sessionId: target, labelIds: [labelId] });
    expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
      ok: true,
      session: {
        sessionId: target,
        deepLink: `cake://session/${target}`,
        lifecycle: "active",
        resolved: false,
      },
    });
    yield* f.call("session-labels.update", { labelId, name: "Ready" });
    yield* f.call("session-labels.reorder", { labelId, index: 0 });
    expect(yield* f.call("session-labels.list")).toMatchObject({
      labels: [{ id: labelId, name: "Ready" }],
    });
    yield* f.call("session-labels.remove", { labelId });
    expect(f.state().projects[0]?.workflow?.assignments[0]?.labelIds ?? []).toEqual([]);
    expect(yield* f.callText("sessions.list")).toBe(
      "3 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 idle active - ? ? ? ? user | /project | Same title\n00000000-0000-4000-8000-000000000011 idle active - ? ? ? ? user | /project | Source\n00000000-0000-4000-8000-000000000033 idle active - ? ? ? ? user | /project | Same title",
    );
    for (const command of ["history", "compactions", "tree", "context", "usage", "commands"])
      expect(yield* f.call(`sessions.${command}`, { sessionId: "00000022" })).toMatchObject({
        ok: true,
        target: { sessionId: target },
        result: { total: 0 },
      });
    expect(f.queries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "history", sessionId: target })]),
    );
    expect(f.requestCalls).toEqual([]);
  }),
);

it.effect(
  "disconnect/reload during mutation admission cannot cancel or repeat backend persistence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      f.pause();
      const pending = yield* f
        .call("session-labels.add", { name: "Exactly once", color: "mint" })
        .pipe(Effect.forkChild);
      yield* Queue.take(f.saves);
      yield* f.requests.releaseConnection(11);
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 22);
      yield* Deferred.succeed(f.saveRelease, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({ ok: true });
      expect(f.saveCount()).toBe(1);
      expect(
        f.state().globalSessionLabels.filter((label) => label.name === "Exactly once"),
      ).toHaveLength(1);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect.each([
  { delivery: "prompt" as const, resultDelivery: "reply" as const },
  { delivery: "steer" as const, resultDelivery: "notification" as const },
  { delivery: "queue" as const, resultDelivery: "ignore" as const },
])(
  "file-backed sends snapshot before admission and preserve $delivery/$resultDelivery, references and provenance",
  ({ delivery, resultDelivery }) =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-send-prompt-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const path = join(root, "task.md");
      const original = "Implement the exact file-backed task.\n";
      yield* Effect.promise(() => writeFile(path, original));
      const f = yield* fixture();
      f.allowPromptRoot(root);
      const sent = yield* f.call("sessions.send", {
        sessionId: target,
        text: "Follow the file",
        promptFiles: [path],
        inputRefs: ["allowed"],
        delivery,
        resultDelivery,
      });
      expect(sent).toMatchObject({
        ok: true,
        delivery,
        resultDelivery,
        expectsResponse: resultDelivery !== "ignore",
      });
      yield* Effect.promise(() => writeFile(path, "Changed source"));
      yield* Effect.promise(() => rm(path));
      const received = yield* Queue.take(f.prompts);
      const envelope = parseCrossSessionMessage(received.text);
      expect(envelope?.text).toContain(original);
      expect(envelope?.text).toContain('"filename":"task.md"');
      expect(envelope?.text).toContain(`"senderSessionId":"${source}"`);
      expect(envelope?.metadata.sender.sessionId).toBe(source);
      expect(received.attachments).toMatchObject([
        { kind: "forwarded-input", reference: "granted/allowed" },
      ]);
      expect(f.requestCalls).toEqual([]);
      const before = f.runtimeCreates.length;
      expect(
        yield* f
          .direct("sessions.send", { sessionId: third, text: "Invalid", promptFiles: [path] })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "AgentControlError" });
      expect(f.runtimeCreates).toHaveLength(before);
    }).pipe(Effect.scoped),
);

it.effect("passive file-backed sends retain their snapshot and remain passive", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "cake-fyi-prompt-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const path = join(root, "context.md");
    yield* Effect.promise(() => writeFile(path, "Exact passive context"));
    const f = yield* fixture();
    f.allowPromptRoot(root);
    const receipt = yield* f.call("sessions.send", {
      sessionId: target,
      text: "Context only",
      promptFiles: [path],
      delivery: "fyi",
    });
    expect(receipt).toMatchObject({
      ok: true,
      delivery: "fyi",
      status: "deferred",
      resultDelivery: "ignore",
      expectsResponse: false,
    });
    yield* Effect.promise(() => rm(path));
    expect(yield* Queue.size(f.prompts)).toBe(0);
    const notices = (yield* Context.get(f.context, SessionFamilyStorage).state()).passiveNotices;
    expect(notices).toMatchObject([
      { recipientSessionId: target, text: expect.stringContaining("Exact passive context") },
    ]);
  }).pipe(Effect.scoped),
);

it.effect(
  "non-family sends restore standalone targets and preserve grants, exact message references, and parent provenance",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.resolve();
      const selectedMessage = messageReference(source, "entry");
      const sent = yield* f.call(
        "sessions.send",
        {
          sessionId: "00000022",
          text: "Review this",
          inputRefs: ["allowed"],
          messageRefs: [selectedMessage],
          resultDelivery: "reply",
          delivery: "steer",
        },
        "sending-assistant",
      );
      expect(sent).toMatchObject({
        ok: true,
        expectsResponse: true,
        delivery: "steer",
        messageNumber: 1,
        target: { sessionId: target },
      });
      const delivered = yield* Queue.take(f.prompts);
      const envelope = parseCrossSessionMessage(delivered.text);
      expect(delivered).toMatchObject({
        sessionId: target,
        delivery: "steer",
        attachments: [{ kind: "forwarded-input", reference: "granted/allowed" }],
      });
      expect(envelope?.metadata).toMatchObject({
        expectsResponse: true,
        sender: {
          sessionId: source,
          kind: "project-session",
          title: "Source",
          workingDirectory: "/project",
        },
      });
      expect(envelope?.text).toContain(selectedMessage);
      expect(envelope?.metadata.sourceMessageRef).toBe(
        messageReference(source, "sending-assistant"),
      );
      expect(f.grants).toContainEqual({ owner: source, refs: ["allowed"], recipient: target });
      expect(f.restored()).toBe(1);
      expect(f.requestCalls).toEqual([]);
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ threadId: Schema.String, messageId: Schema.String }),
      )(sent);
      const reply = yield* f.direct(
        "sessions.reply",
        { text: "Findings", threadId: receipt.threadId },
        { ...caller, sessionId: target, title: "Target" },
      );
      expect(reply).toMatchObject({
        ok: true,
        replyToMessageId: receipt.messageId,
        expectsResponse: true,
        target: { sessionId: source },
      });
      expect(
        yield* f.direct(
          "sessions.thread",
          { threadId: receipt.threadId },
          { ...caller, sessionId: third },
        ),
      ).toMatchObject({ ok: false });
      expect(
        yield* f.direct(
          "sessions.reply",
          { text: "Forged", threadId: receipt.threadId, replyToMessageId: crypto.randomUUID() },
          { ...caller, sessionId: target },
        ),
      ).toMatchObject({ ok: false });
    }),
);

it.effect("rejected attachments or missing exact Pi messages cannot reach delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* f
        .call("sessions.send", { sessionId: target, text: "No permission", inputRefs: ["foreign"] })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" });
    expect(
      yield* f
        .call("sessions.send", {
          sessionId: target,
          text: "No message",
          messageRefs: [messageReference(source, "missing")],
        })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" });
    expect(yield* Queue.size(f.prompts)).toBe(0);
  }),
);

it.effect(
  "thread inspection retains factual failed/completed outcomes after immediate settlement and runtime release",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.failedTurns.add(target);
      for (const [sessionId, status] of [
        [target, "failed"],
        [third, "delivered"],
      ] as const) {
        const result = yield* f.call("sessions.send", { sessionId, text: "Run" });
        expect(result).toMatchObject({ ok: true, status: "accepted" });
        const { threadId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ threadId: Schema.String }),
        )(result);
        // The real runtime marks unread after its settlement hook has recorded the outcome.
        yield* Queue.take(f.saves);
        expect(yield* f.call("sessions.thread", { threadId })).toMatchObject({
          ok: true,
          thread: { messages: [{ status }] },
        });
      }
    }),
);

it.effect("shared thread admission enforces limits across concurrent callers and windows", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const sent = yield* f.call("sessions.send", {
      sessionId: target,
      text: "First",
      maxMessages: 2,
    });
    const { threadId } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ threadId: Schema.String }),
    )(sent);
    const results = yield* Effect.all(
      [
        f.direct("sessions.send", { sessionId: target, text: "Second", threadId }),
        f.direct("sessions.send", { sessionId: target, text: "Third", threadId }),
      ],
      { concurrency: "unbounded" },
    );
    expect(
      results.filter((result) => Schema.is(jsonObjectSchema)(result) && result.ok),
    ).toHaveLength(1);
    expect(yield* f.direct("sessions.thread", { threadId })).toMatchObject({
      ok: true,
      thread: { state: "closed", messageCount: 2, messages: [{}, {}] },
    });
  }),
);

const cakeControl = Effect.fn("BackendAgentControlTest.cakeControl")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
) {
  const options = yield* cakeChatRuntime
    .acquireOptions({
      configuration: {
        location: { workingDirectory: "/home", sessionDirectory: "/cake/global" },
        agentDirectory: "/cake",
      },
      target: { sessionId: CAKE_CHAT_SESSION_ID, tools: backendAgentTools() },
      newSession: false,
    })
    .pipe(Effect.provide(f.context));
  assert.ok(options.runtime.globalControl);
  return options.runtime.globalControl;
});

it.effect(
  "Project Sessions, Project Chat and Cake Chat discover and execute the same automation controls",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      let ledger: AutomationLedger = {
        automations: [],
        occurrences: [],
        runs: [],
        artifactSchedules: [],
        pausedArtifactIds: [],
      };
      const automationContext = yield* Layer.build(
        AutomationRecords.layer.pipe(
          Layer.provide(
            Layer.succeed(AutomationStorage, {
              load: () => Effect.succeed(ledger),
              save: (next) =>
                Effect.sync(() => {
                  ledger = next;
                }),
            }),
          ),
        ),
      );
      const context = Context.merge(f.context, automationContext);
      yield* Context.get(context, AutomationRecords).initialize();
      const input = Schema.decodeUnknownSync(jsonObjectSchema)({
        definition: automationDefinition(),
        initialState: "paused",
      });
      for (const sessionId of [projectChatSessionId("/project"), CAKE_CHAT_SESSION_ID]) {
        const options = yield* cakeChatRuntime
          .acquireOptions({
            configuration: {
              location: { workingDirectory: "/home", sessionDirectory: "/cake/global" },
              agentDirectory: "/cake",
            },
            target: { sessionId, tools: backendAgentTools() },
            newSession: false,
          })
          .pipe(Effect.provide(context));
        const registry = new CakeOperationRegistry(
          coordinatorCakeOperations(options.runtime)({
            sessionId,
            resolveModel: () => ({
              provider: "test",
              modelId: "test",
              thinkingLevel: "off",
              fastMode: false,
            }),
            setModel: async () => {},
            info: async () => ({}),
            usage: async () => ({}),
            contextStatus: async () => ({}),
            compact: async () => ({}),
          }),
        );
        expect(registry.topicHelp("automations")).toContain("automations.create");
        const result = yield* Effect.promise(() =>
          registry.invoke(
            { command: "automations.create", input },
            { signal: signal(), toolCallId: "automation", runtime: {} },
          ),
        );
        expect(result.details).toMatchObject({
          result: { ok: true, automation: { state: { _tag: "paused" } } },
        });
      }
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-automation-project-tools-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"))),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const options = yield* acquireOptions({
        location,
        sessionId: source,
        newSession: false,
      }).pipe(Effect.provide(context));
      const runtime = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createProjectSessionRuntime({
            ...options.runtime,
            cwd: directory,
            agentDir: join(directory, "agent"),
            sessionDir: join(directory, "sessions"),
            newSession: true,
            onEvent: () => undefined,
          }),
        ),
        (value) =>
          Effect.promise(async () => {
            await value.dispose();
          }),
      );
      const call = runtime.callCakeOperation?.bind(runtime);
      assert.ok(call);
      expect(
        yield* Effect.promise(() => call("automations.create", input, signal())),
      ).toMatchObject({ ok: true, automation: { state: { _tag: "paused" } } });
      expect(yield* Effect.promise(() => call("automations.list", {}, signal()))).toMatchObject({
        total: 3,
      });
      expect(ledger.automations).toHaveLength(3);
    }),
);

it.effect("permanent Project Chat and global Cake Chat discover and execute tool pruning", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    for (const sessionId of [projectChatSessionId("/project"), CAKE_CHAT_SESSION_ID]) {
      const options = yield* cakeChatRuntime
        .acquireOptions({
          configuration: {
            location: { workingDirectory: "/home", sessionDirectory: "/cake/global" },
            agentDirectory: "/cake",
          },
          target: { sessionId, tools: backendAgentTools() },
          newSession: false,
        })
        .pipe(Effect.provide(f.context));
      const control = options.runtime.globalControl;
      assert.ok(control);
      const allowed = options.runtime.allowedCakeOperations;
      expect(allowed).toContain("sessions.tool-prune");
      const registry = new CakeOperationRegistry(
        coordinatorCakeOperations(options.runtime)({
          sessionId,
          resolveModel: () => ({
            provider: "test",
            modelId: "test",
            thinkingLevel: "off",
            fastMode: false,
          }),
          setModel: async () => {},
          info: async () => ({}),
          usage: async () => ({}),
          contextStatus: async () => ({}),
          compact: async () => ({}),
        }),
      );
      expect(registry.topicHelp("sessions")).toContain("sessions.tool-prune");
      expect(registry.operationHelp("sessions.tool-prune")).toContain("sessionId");
      expect(registry.operationHelp("sessions.tool-prune")).toContain("no model call");
      expect(registry.topicHelp("sessions")).not.toContain("sessions.tool-compact");
      const call = (sessionId: string) =>
        Effect.promise(() =>
          registry.invoke(
            { command: "sessions.tool-prune", input: { sessionId } },
            { signal: signal(), toolCallId: "compact", runtime: {} },
          ),
        );
      const help = yield* Effect.promise(() =>
        registry.invoke(
          { command: "sessions.tool-prune.help" },
          { signal: signal(), toolCallId: "help", runtime: {} },
        ),
      );
      expect(JSON.stringify(help)).toContain("sessionId");
      expect(f.toolPrunings).toHaveLength(sessionId === CAKE_CHAT_SESSION_ID ? 2 : 0);
      expect((yield* call("00000022")).details).toMatchObject({
        result: { ok: true, results: [{ sessionId: target, status: "compacted" }] },
      });
      expect((yield* call("missing")).details).toMatchObject({
        result: { ok: false, results: [{ status: "invalid" }] },
      });
      f.protect();
      expect((yield* call(target)).details).toMatchObject({ result: { ok: true } });
    }
    expect(f.toolPrunings).toEqual([target, target, target, target]);
    expect(f.compactions).toEqual([]);
    expect(f.requestCalls).toEqual([]);
  }),
);

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const pngIcon = { mimeType: "image/png", data: pngBytes.toString("base64") } as const;
/** Agents see only the type and size; the stored bytes stay in settings. */
const pngSummary = { mimeType: "image/png", sizeBytes: pngBytes.length } as const;

const iconFiles = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "cake-project-icon-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
).pipe(
  Effect.tap((root) =>
    Effect.promise(async () => {
      await writeFile(join(root, "icon.png"), pngBytes);
      await writeFile(join(root, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
      await writeFile(join(root, "notes.png"), "not an image");
      const large = Buffer.alloc(PROJECT_ICON_FILE_MAX_BYTES + 1);
      pngBytes.copy(large);
      await writeFile(join(root, "large.png"), large);
    }),
  ),
);

const projectChatSettings = (f: Effect.Success<ReturnType<typeof fixture>>, sessionId: string) =>
  cakeChatRuntime
    .acquireOptions({
      configuration: {
        location: { workingDirectory: "/project", sessionDirectory: "/cake/project" },
        agentDirectory: "/cake",
      },
      target: { sessionId, tools: backendAgentTools() },
      newSession: false,
    })
    .pipe(
      Effect.provide(f.context),
      Effect.map((options) => {
        expect(options.runtime.allowedCakeOperations).toContain("projects.settings.update");
        const control = options.runtime.cakeChatProjects;
        assert.ok(control);
        return control;
      }),
    );

it.effect("Project Session and global Cake Chat set the Project icon from a local file path", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const root = yield* iconFiles;
    expect(
      yield* f.call("project.settings.update", {
        changes: { iconPath: join(root, "icon.png") },
      }),
    ).toMatchObject({ ok: true, settings: { icon: pngSummary } });
    expect(f.state().projects[0]?.settings?.icon).toEqual(pngIcon);
    // Global Cake Chat targets the Project explicitly; a leading ~ resolves to the home directory.
    vi.stubEnv("HOME", root);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const control = yield* projectChatSettings(f, CAKE_CHAT_SESSION_ID);
    expect(
      yield* Effect.promise(() =>
        control.updateSettings(
          { projectPath: "/project", changes: { iconPath: "~/photo.jpg" } },
          signal(),
        ),
      ),
    ).toMatchObject({
      ok: true,
      settings: { icon: { mimeType: "image/jpeg", sizeBytes: 6 } },
    });
    expect(f.state().projects[0]?.settings?.icon).toEqual({
      mimeType: "image/jpeg",
      data: "/9j/4AAQ",
    });
  }),
);

it.effect("rejects unusable icon files by path and reason without writing settings", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const root = yield* iconFiles;
    yield* f.call("project.settings.update", { changes: { iconPath: join(root, "icon.png") } });
    for (const [iconPath, reason] of [
      [join(root, "missing.png"), "the file does not exist"],
      [root, "it is not a file"],
      [join(root, "notes.png"), "it is not a PNG, JPEG, GIF or WebP image"],
      [
        join(root, "large.png"),
        `it is ${(PROJECT_ICON_FILE_MAX_BYTES + 1).toLocaleString("en-US")} bytes; the limit is ${PROJECT_ICON_FILE_MAX_BYTES.toLocaleString("en-US")} bytes`,
      ],
      ["icon.png", "use an absolute path or ~/ path"],
    ] as const)
      expect(
        yield* f.call("project.settings.update", {
          changes: { iconPath, worktreeLanding: "pull-request" },
        }),
      ).toEqual({
        ok: false,
        command: "project.settings.update",
        error: `Cannot use icon file ${iconPath}: ${reason}.`,
      });
    expect(f.state().projects[0]?.settings).toMatchObject({
      icon: pngIcon,
      worktreeLanding: "merge",
    });
  }),
);

it.effect("Project Chat reads and patches only its own Project's settings, icon included", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const root = yield* iconFiles;
    const project = f.state().projects[0];
    assert.ok(project);
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
      }),
    );
    const control = yield* projectChatSettings(f, projectChatSessionId("/project"));
    const iconPath = join(root, "icon.png");
    expect(
      yield* Effect.promise(() =>
        control.updateSettings(
          { projectPath: "/project", changes: { iconPath, worktreeLanding: "pull-request" } },
          signal(),
        ),
      ),
    ).toMatchObject({ ok: true, projectPath: "/project", settings: { icon: pngSummary } });
    const read = yield* Effect.promise(() =>
      control.getSettings({ projectPath: "/project" }, signal()),
    );
    expect(read).toMatchObject({
      projectPath: "/project",
      settings: { worktreeLanding: "pull-request" },
    });
    expect(JSON.stringify(read)).not.toContain(pngIcon.data);
    expect(read).toMatchObject({ settings: { icon: pngSummary } });
    for (const attempt of [
      () => control.getSettings({ projectPath: "/other" }, signal()),
      () => control.updateSettings({ projectPath: "/other", changes: { iconPath } }, signal()),
    ])
      expect(yield* Effect.flip(Effect.tryPromise(attempt))).toMatchObject({
        cause: { message: expect.stringContaining("only read or update its own") },
      });
    expect(f.state().projects.find((item) => item.path === "/other")?.settings?.icon).toBe(
      undefined,
    );
  }),
);

it.effect("tool pruning shares project authorization and skips busy targets without queuing", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const project = f.state().projects[0];
    assert.ok(project);
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
      }),
    );
    f.sessionsByDirectory.set("/other", [third]);
    f.sessionsByDirectory.set("/project", [source, target]);
    const projectChat = {
      kind: "cake-chat" as const,
      sessionId: projectChatSessionId("/project"),
      title: "Project Chat",
    };
    for (const sender of [caller, projectChat]) {
      expect(yield* f.direct("sessions.tool-prune", { sessionId: third }, sender)).toMatchObject({
        ok: false,
        results: [{ status: "unauthorized" }],
      });
    }
    const global = {
      kind: "cake-chat" as const,
      sessionId: CAKE_CHAT_SESSION_ID,
      title: "Cake Chat",
    };
    f.deny("/other");
    expect(yield* f.direct("sessions.tool-prune", { sessionId: third }, global)).toMatchObject({
      ok: false,
      results: [{ status: "unauthorized" }],
    });
    yield* f.direct("sessions.context", { sessionId: target });
    f.active.add(target);
    expect(
      yield* f.direct("sessions.tool-prune", { sessionId: target }, projectChat),
    ).toMatchObject({
      ok: false,
      results: [{ status: "busy" }],
    });
    expect(f.toolPrunings).toEqual([]);
    f.active.delete(target);
    f.resolve();
    expect(
      yield* f.direct("sessions.tool-prune", { sessionId: target }, projectChat),
    ).toMatchObject({
      ok: true,
      results: [{ status: "compacted" }],
    });
    f.compactFailures.add(target);
    expect(
      yield* f.direct("sessions.tool-prune", { sessionId: target }, projectChat),
    ).toMatchObject({
      ok: false,
      results: [{ status: "failed", message: "Tool pruning navigation failed" }],
    });
    f.sessionsByDirectory.delete("/other");
    f.sessionsByDirectory.set("/allowed", [third]);
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [...state.projects, { ...project, path: "/allowed", name: "Allowed" }],
      }),
    );
    expect(yield* f.direct("sessions.tool-prune", { sessionId: third }, global)).toMatchObject({
      ok: true,
      results: [{ sessionId: third, status: "compacted" }],
    });
    expect(f.compactions).toEqual([]);
    expect(f.requestCalls).toEqual([]);
    expect(f.restored()).toBe(0);
  }),
);

const batchRegistry = Effect.fn("BackendAgentControlTest.batchRegistry")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  projectResult?: (value: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
) {
  const control = yield* cakeControl(f);
  const registry = new CakeOperationRegistry(
    createGlobalControlOperations(control, () => ({
      provider: "test",
      modelId: "test",
      thinkingLevel: "off",
      fastMode: false,
    })),
    projectResult,
  );
  return (command: string, input: JsonObject) =>
    Effect.promise(() =>
      registry.invoke({ command, input }, { signal: signal(), toolCallId: "batch", runtime: {} }),
    );
});

it.effect(
  "stored report reads bypass unrelated admission/delivery locks and global identity projection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const storage = Context.get(f.context, SessionFamilyStorage);
      yield* storage.deferReferenceNotice({
        id: "retained-report",
        recipientSessionId: CAKE_CHAT_SESSION_ID,
        text: "Exact retained handoff",
        source: {
          kind: "subagent",
          sessionId: target,
          handleId: "worker",
          task: "Investigate",
          status: "done",
        },
      });
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Context.get(f.context, SessionCoordination)
        .withAdmission(
          storage.withNoticeDelivery(
            Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(locked);
      let projections = 0;
      const invoke = yield* batchRegistry(f, async () => {
        projections++;
        throw new Error("Must not discover unrelated checkouts to read a stored report");
      });
      const before = { ...f.listReads, ids: [...f.listReads.ids] };
      const result = yield* invoke("sessions.reports.read", { id: "retained-report", limit: 5 });
      expect(result.details).toMatchObject({
        result: { text: "Exact", nextOffset: 5, source: { sessionId: target } },
      });
      expect(projections).toBe(0);
      expect(f.listReads).toEqual(before);
      expect(f.runtimeCreates).toEqual([source]);
      expect((yield* storage.state()).deferredReferences).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
    }),
);

it.effect(
  "side chats send repeated parent messages with their own identity and inherited authorization",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const projectChat = projectChatSessionId("/project");
      for (const parent of [source, projectChat, CAKE_CHAT_SESSION_ID]) {
        const sideChatSessionId = parent === source ? third : cakeChatSideChatSessionId(7, parent);
        yield* Context.get(f.context, SessionFamilyStorage).registerParent({
          sessionId: sideChatSessionId,
          parentSessionId: parent,
        });
        const options =
          parent === source
            ? yield* acquireOptions({
                location,
                sessionId: parent,
                newSession: false,
                sideChatSessionId,
              }).pipe(Effect.provide(f.context))
            : yield* cakeChatRuntime
                .acquireOptions({
                  configuration: {
                    location: {
                      workingDirectory: parent === projectChat ? "/project" : "/home",
                      sessionDirectory: "/cake/chat",
                    },
                    agentDirectory: "/cake",
                  },
                  target: { sessionId: parent, tools: backendAgentTools() },
                  newSession: false,
                  sideChatSessionId,
                })
                .pipe(Effect.provide(f.context));
        const global = options.runtime.globalControl;
        const project = options.runtime.currentSessionControl?.invokeAppControl;
        assert.ok(global || project);
        const invoke = (command: string, input: JsonObject) => {
          if (global) return global.invoke({ name: command, arguments: input }, signal());
          assert.ok(project);
          return project(command, input, signal());
        };
        yield* Context.get(f.context, CakeSessionRuntimes).acquire({
          profile: { _tag: "DiscussionSession" },
          runtime: {
            ...options.runtime,
            sessionId: sideChatSessionId,
            directSessionDir: true,
            sessionDir: `/cake/discussions/${sideChatSessionId}`,
          },
        });
        yield* sessionChats
          .deliver(
            {
              sessionId: sideChatSessionId,
              text: "User follow-up",
              attachments: [],
              renderUserMessageAsMarkdown: false,
            },
            "prompt",
          )
          .pipe(Effect.provide(f.context));
        expect(yield* Queue.take(f.prompts)).toMatchObject({
          sessionId: sideChatSessionId,
          text: "User follow-up",
        });
        expect(
          yield* Effect.promise(() =>
            invoke("sessions.send", { sessionId: 7, text: "Invalid target" }),
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
        expect(yield* Queue.size(f.prompts)).toBe(0);
        for (const sessionId of [undefined, "parent"]) {
          const text = sessionId ? "Follow-up evidence" : "Parent, please review";
          const receipt = yield* Effect.promise(() =>
            invoke("sessions.send", {
              ...(sessionId ? { sessionId } : {}),
              text,
              delivery: "prompt",
              resultDelivery: "ignore",
            }),
          );
          expect(receipt).toMatchObject({
            ok: true,
            target: { sessionId: parent },
            transcriptDelivery: "unverified",
            execution: "unverified",
          });
          const recipient = yield* Queue.take(f.prompts);
          expect(recipient.sessionId).toBe(parent);
          expect(parseCrossSessionMessage(recipient.text)).toMatchObject({
            text,
            metadata: { sender: { sessionId: sideChatSessionId } },
          });
        }
        yield* f.direct(
          "sessions.send",
          {
            sessionId: sideChatSessionId,
            text: "Parent reply",
            delivery: "prompt",
            resultDelivery: "ignore",
          },
          {
            ...caller,
            sessionId: parent,
            kind: parent === source ? "project-session" : "cake-chat",
          },
        );
        const reply = yield* Queue.take(f.prompts);
        expect(reply.sessionId).toBe(sideChatSessionId);
        expect(parseCrossSessionMessage(reply.text)).toMatchObject({
          text: "Parent reply",
          metadata: { sender: { sessionId: parent } },
        });
        expect(
          yield* f.direct(
            "sessions.send",
            { sessionId: sideChatSessionId, text: "Quiet parent evidence", delivery: "fyi" },
            {
              ...caller,
              sessionId: parent,
              kind: parent === source ? "project-session" : "cake-chat",
            },
          ),
        ).toMatchObject({ ok: true, status: "deferred", transcriptDelivery: "pending" });
        expect(yield* Queue.size(f.prompts)).toBe(0);
        yield* sessionChats
          .deliver(
            {
              sessionId: sideChatSessionId,
              text: "Continue with updates",
              attachments: [],
              renderUserMessageAsMarkdown: false,
            },
            "prompt",
          )
          .pipe(Effect.provide(f.context));
        const carried = yield* Queue.take(f.prompts);
        expect(carried.sessionId).toBe(sideChatSessionId);
        expect(carried.text).toContain("Quiet parent evidence");
        expect(
          yield* Effect.promise(() =>
            invoke("sessions.send", {
              sessionId: projectChatSessionId("/unregistered"),
              text: "No authority",
              delivery: "prompt",
            }),
          ).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" });
      }
    }),
);

it.effect(
  "registered Project Chat discovery routes directly and sends return before recipient execution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const globalCaller = {
        kind: "cake-chat" as const,
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      };
      const listing = yield* f.direct("projects.list", { query: "Project" }, globalCaller);
      const projectChat = projectChatSessionId("/project");
      expect(listing).toMatchObject({
        projects: [{ path: "/project", projectChatId: projectChat }],
      });
      let projections = 0;
      const invoke = yield* batchRegistry(f, async () => {
        projections++;
        throw new Error("A send receipt must not scan unrelated sessions");
      });
      const beforeIds = [...f.listReads.ids];
      // The recipient's model boundary will remain suspended until explicitly released.
      f.pauseMessage();
      const receipt = yield* invoke("sessions.send", {
        sessionId: projectChat,
        text: "Investigate this",
        delivery: "prompt",
      });
      expect(receipt.details).toMatchObject({
        result: {
          ok: true,
          target: { sessionId: projectChat },
          status: "accepted",
          transcriptDelivery: "unverified",
          execution: "unverified",
        },
      });
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(projectChat);
      expect(yield* Deferred.isDone(f.messageRelease)).toBe(false);
      f.active.add(projectChat);
      const quiet = yield* invoke("sessions.send", {
        sessionId: projectChat,
        text: "Related evidence",
        delivery: "fyi",
      });
      expect(quiet.details).toMatchObject({
        result: {
          ok: true,
          delivery: "fyi",
          status: "deferred",
          expectsResponse: false,
          transcriptDelivery: "pending",
          execution: "not-requested",
        },
      });
      const storage = Context.get(f.context, SessionFamilyStorage);
      expect((yield* storage.state()).passiveNotices).toMatchObject([
        { recipientSessionId: projectChat, text: "Related evidence" },
      ]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.runtimeCreates.filter((id) => id === projectChat)).toHaveLength(1);
      expect(f.listReads.ids).toEqual(beforeIds);
      expect(projections).toBe(0);
      expect(
        yield* f
          .direct(
            "sessions.send",
            {
              sessionId: projectChatSessionId("/unregistered"),
              text: "Nobody",
              delivery: "fyi",
            },
            globalCaller,
          )
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.runtimeCreates).not.toContain(projectChatSessionId("/unregistered"));
      yield* Deferred.succeed(f.messageRelease, undefined);
    }),
);

it.effect(
  "backend inspection includes saved Drafts without starting Pi or requiring a window",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const draftId = "00000000-0000-4000-8000-000000000044";
      f.drafts.push({
        sessionId: draftId,
        projectPath: "/project",
        workingDirectory: "/project",
        title: "Unsent",
        text: "Do not execute",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-01-05",
        modifiedAt: "2026-01-05",
        revision: 1,
        status: "saved",
      });
      expect(yield* f.callText("sessions.list")).toContain(
        "draft draft - ? ? ? ? user | /project | Unsent",
      );
      expect(yield* f.call("sessions.info", { sessionId: draftId })).toMatchObject({
        ok: true,
        session: { sessionId: draftId, draft: true, lifecycle: "draft", resolved: false },
        status: "idle",
      });
      const added = yield* f.call("session-labels.add", { name: "Draft label", color: "cyan" });
      const { label } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ label: Schema.Struct({ id: Schema.String }) }),
      )(added);
      expect(
        yield* f.call("sessions.set-labels", { sessionId: draftId, labelIds: [label.id] }),
      ).toMatchObject({ ok: true });
      expect(f.drafts[0]?.labelIds).toEqual([label.id]);
      expect(f.drafts[0]?.revision).toBe(2);
      expect(f.state().projects[0]?.workflow?.assignments ?? []).toEqual([]);
      const current = f.drafts[0];
      assert.ok(current);
      f.drafts[0] = { ...current, status: "activating" };
      expect(
        yield* f.call("sessions.set-labels", { sessionId: draftId, labelIds: [] }),
      ).toMatchObject({ ok: false });
      expect(f.drafts[0]?.labelIds).toEqual([label.id]);
      expect(f.runtimeCreates).not.toContain(draftId);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect("compact roster identities route follow-up inspections without global enumeration", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const roster = yield* f.callText("sessions.list", { limit: 1 });
    assert.ok(typeof roster === "string");
    const reference = roster.split("\n")[2]?.split(" ")[0];
    assert.ok(reference);
    expect(reference).toBe(target);
    const directoryReads = [...f.listReads.ids];
    for (let index = 0; index < 20; index++)
      expect(yield* f.call("sessions.info", { sessionId: reference })).toMatchObject({
        session: { sessionId: target },
      });
    expect(f.listReads.ids).toEqual(directoryReads);
  }),
);

it.effect("returns canonical session JSON separately from its compact agent roster", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const data = yield* f.direct("sessions.list", {});
    expect(data).toMatchObject({
      total: 3,
      offset: 0,
      nextOffset: null,
      sampledAt: expect.any(Number),
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId: target })]),
    });
    expect(discoveryResultText("sessions.list", data ?? null)).toContain("3 sessions");
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  }),
);

it.effect(
  "lists compact size and freshness only for the selected page without waking sessions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* TestClock.setTime(Date.parse("2000-01-01T01:00:00.000Z"));
      f.contextBySession.set(target, {
        estimatedTokens: 120_000,
        lastModelActivityAt: "2000-01-01T00:00:00.000Z",
        cacheObservation: {
          provider: "anthropic",
          observedAt: "2000-01-01T00:00:00.000Z",
          readTokens: 0,
          writeTokens: 10_000,
          write1hTokens: 0,
        },
      });
      expect(yield* f.callText("sessions.list", { limit: 1 })).toBe(
        "3 sessions; next=1\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 idle active - 120K expired? 1h -55m user | /project | Same title",
      );
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
        session: {
          sessionId: target,
          resolved: false,
        },
      });
    }),
);

it.effect(
  "exposes committed-head metadata for Project Chat and global Cake Chat without opening either",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const projectChat = projectChatSessionId("/project");
      for (const id of [CAKE_CHAT_SESSION_ID, projectChat])
        f.contextBySession.set(id, { estimatedTokens: 1234 });
      const listing = yield* f.directText(
        "sessions.list",
        { query: "Chat" },
        { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      );
      expect(listing).toContain(
        "2 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title",
      );
      expect(listing).toContain("cake-chat idle active - 1.2K ? ? ? - | — | Cake Chat");
      expect(listing).toContain("idle active - 1.2K ? ? ? - | /project | Project Chat");
      const entries = f.listReads.entries.length;
      for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChat])
        expect(yield* f.direct("sessions.info", { sessionId })).toMatchObject({
          ok: true,
          session: {
            sessionId,
            deepLink: `cake://session/${encodeURIComponent(sessionId)}`,
            lifecycle: "active",
            resolved: false,
          },
        });
      expect(f.listReads.entries.length).toBe(entries);
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect(
  "defaults project callers to their project and allows explicit overrides from every caller",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const project = f.state().projects[0];
      assert.ok(project);
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
        }),
      );
      f.drafts.push({
        sessionId: "00000000-0000-4000-8000-00000000abcd",
        projectPath: "/other",
        workingDirectory: "/other-worktree",
        title: "Foreign task",
        text: "Private draft body",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-02-01",
        modifiedAt: "2026-02-01",
        revision: 1,
        status: "saved",
      });
      const foreign = f.drafts[0];
      assert.ok(foreign);
      const resolvedForeignId = "00000000-0000-4000-8000-00000000abce";
      f.drafts.push({
        ...foreign,
        sessionId: resolvedForeignId,
        title: "Resolved foreign",
        resolved: true,
      });
      f.resolve();
      const historicalListing = yield* Effect.gen(function* () {
        return yield* sessionMetadata.listing(
          yield* sessionReferences.discover("/other"),
          () => true,
        );
      }).pipe(Effect.provide(f.context));
      expect(
        historicalListing.sessions.some((session) => session.sessionId === resolvedForeignId),
      ).toBe(false);
      expect(f.drafts.find((draft) => draft.sessionId === resolvedForeignId)?.text).toBe(
        "Private draft body",
      );
      const global = {
        kind: "cake-chat" as const,
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      };
      const allProjects = yield* f.directText("sessions.list", {}, global);
      expect(allProjects).toContain("/project |");
      expect(allProjects).toContain("/other |");
      expect(allProjects).not.toContain(target);
      expect(allProjects).not.toContain(resolvedForeignId);
      expect(yield* f.directText("sessions.list", { query: "Foreign" }, global)).toContain(
        "0000abcd draft draft - ? ? ? ? user | /other | Foreign task",
      );
      expect(
        yield* f.directText("sessions.list", { query: "Foreign", projectPath: "/other" }, global),
      ).toContain("0000abcd draft draft - ? ? ? ? user | /other | Foreign task");
      const projectChat = {
        kind: "cake-chat" as const,
        sessionId: projectChatSessionId("/project"),
        title: "Project Chat",
      };
      for (const sender of [
        caller,
        { ...caller, workingDirectory: "/managed-worktree" },
        { ...caller, projectPath: undefined },
        projectChat,
      ]) {
        expect(yield* f.directText("sessions.list", { query: "Foreign" }, sender)).toBe(
          "0 sessions",
        );
        expect(yield* f.directText("sessions.list", { projectPath: "/other" }, sender)).toContain(
          "0000abcd draft draft - ? ? ? ? user | /other | Foreign task",
        );
        const local = yield* f.directText("sessions.list", { query: "Same" }, sender);
        expect(local).toContain(`${third} idle active - ? ? ? ? user | /project | Same title`);
        expect(local).not.toContain(target);
        const overridden = yield* f.directText(
          "sessions.list",
          { projectPath: "/other", limit: 1 },
          sender,
        );
        expect(overridden).toContain("2 sessions; next=1"); // Project Chat and unresolved Draft.
        expect(overridden).not.toContain(resolvedForeignId);
        expect(overridden).not.toContain("/project |");
      }
      expect(
        yield* f.directText(
          "sessions.list",
          {},
          { ...projectChat, sessionId: projectChatSessionId("/unregistered") },
        ),
      ).toMatchObject({
        ok: false,
        error: "The caller has no registered project scope.",
      });
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect("keeps task-input metadata redacted in session and report text catalogs", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.protectedSessions.add(target);
    const global = {
      kind: "cake-chat" as const,
      sessionId: CAKE_CHAT_SESSION_ID,
      title: "Cake Chat",
    };
    expect(yield* f.directText("sessions.list", { query: "Task" }, global)).toBe(
      "1 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 idle active - ? ? ? ? user | /project | Task session",
    );
    expect(f.redactionReads.inventories).toBe(1);
    expect(f.redactionReads.entries).toBe(0);
    const invoke = yield* batchRegistry(f);
    const expected =
      "1 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 idle active - ? ? ? ? - | — | Task session";
    expect(yield* invoke("sessions.list", { query: "Task" })).toMatchObject({
      text: expected,
      structuredContent: {
        command: "sessions.list",
        result: expect.objectContaining({
          total: 1,
          sessions: [expect.objectContaining({ title: "Task session" })],
        }),
      },
      details: {
        result: expect.objectContaining({
          total: 1,
          sessions: [expect.objectContaining({ title: "Task session" })],
        }),
      },
    });
    const unprotected = yield* f.directText("sessions.list", { query: "Same" }, global);
    expect(unprotected).toContain("00000033");
    expect(unprotected).not.toContain("00000022");
    const storage = Context.get(f.context, SessionFamilyStorage);
    yield* storage.deferReferenceNotice({
      id: "protected-report",
      recipientSessionId: CAKE_CHAT_SESSION_ID,
      text: "PRIVATE_REPORT_BODY",
      source: {
        kind: "subagent",
        handleId: "00000000-0000-4000-8000-000000000044",
        sessionId: target,
        task: "PRIVATE_TASK",
        status: "done",
      },
    });
    const report = yield* invoke("sessions.reports", {});
    expect(report.text).toBe(
      `1 pending reports\nid\tadmissions\tsession\thandle\tstatus\ttask\nprotected-report\t0\t${target}\t-\tdone\tTask session`,
    );
    expect(report.details).toMatchObject({
      result: {
        items: [
          {
            ref: `cake://subagent/${CAKE_CHAT_SESSION_ID}/00000000-0000-4000-8000-000000000044`,
            source: { sessionId: target, title: "Task session" },
          },
        ],
      },
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
    expect((yield* storage.state()).deferredReferences).toHaveLength(1);
    expect(f.runtimeCreates).toEqual([source]);
  }),
);

it.effect("scopes a 699-location roster before directory scans and retains page file routes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const project = f.state().projects[0];
    assert.ok(project);
    yield* Context.get(f.context, ApplicationState).transact((state) =>
      Effect.succeed({
        ...state,
        projects: [...state.projects, { ...project, path: "/other", name: "Other" }],
      }),
    );
    // 699 directories and 1603 identities, including standalone sessions without family bindings.
    f.sessionsByDirectory.set("/project", [
      source,
      target,
      third,
      ...Array.from(
        { length: 97 },
        (_, index) => `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
      ),
    ]);
    for (let index = 0; index < 697; index++) {
      const cwd = `/other/worktree-${index}`;
      f.worktreeRecords.push({
        worktreePath: cwd,
        projectPath: "/other",
        branch: `agent/${index}`,
        baseBranch: "main",
        createdAt: "2026-01-01",
      });
      f.sessionsByDirectory.set(
        cwd,
        Array.from(
          { length: index < 109 ? 3 : 2 },
          (_, n) => `00000000-0000-4000-8002-${String(index * 3 + n).padStart(12, "0")}`,
        ),
      );
    }
    const family = Context.get(f.context, SessionFamilyStorage);
    let familyReads = 0;
    const before = {
      locate: f.listReads.locate,
      records: f.listReads.records,
      drafts: f.listReads.drafts,
    };
    f.listReads.ids.length = 0;
    f.listReads.titles.length = 0;
    f.listReads.entries.length = 0;
    const invoke = (input: JsonObject, sender: agentControl.AgentControlCaller = caller) =>
      agentControl.invoke("sessions.list", input, sender).pipe(
        Effect.provideService(SessionFamilyStorage, {
          ...family,
          state: () => {
            familyReads++;
            return family.state();
          },
        }),
        Effect.provide(f.context),
        Effect.map((result) =>
          result === undefined ? result : (discoveryResultText("sessions.list", result) ?? result),
        ),
      );
    const listing = yield* invoke({ query: "Same", offset: 3, limit: 2 });
    expect(listing).toContain("99 sessions; next=5");
    expect(f.listReads.ids).toEqual(["/project"]);
    expect(f.listReads.titles).toEqual(f.sessionsByDirectory.get("/project"));
    expect(f.listReads.entries).toEqual([]);
    expect(f.listReads.locate - before.locate).toBe(0);
    expect(f.listReads.records - before.records).toBe(1);
    expect(f.listReads.drafts - before.drafts).toBe(1);
    expect(f.listReads.resolutions).toEqual(["/project"]);
    expect(familyReads).toBe(1);
    expect(f.inspections).toHaveLength(2);
    expect(f.listReads.inspectionFiles).toEqual(
      f.inspections.map((id) => `/cake/sessions/${id}.jsonl`),
    );
    // No retained roster: removing a transcript is visible on the very next invocation.
    f.sessionsByDirectory.set("/project", [source]);
    expect(yield* invoke({ query: "Same" })).toBe("0 sessions");
    expect(familyReads).toBe(2);
    expect(f.inspections).toHaveLength(2);
    f.listReads.titles.length = 0;
    f.listReads.ids.length = 0;
    const narrowedGlobal = yield* invoke(
      { projectPath: "/other", query: "Same", limit: 1 },
      {
        kind: "cake-chat",
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
      },
    );
    expect(narrowedGlobal).toContain("1503 sessions; next=1");
    expect(f.listReads.titles).toHaveLength(1503);
    expect(f.listReads.titles).not.toContain(source);
    expect(familyReads).toBe(3);
    expect(f.inspections).toHaveLength(3);
    expect(f.listReads.ids).toHaveLength(698);
    expect(f.listReads.ids).not.toContain("/project");
    expect(f.runtimeCreates).toEqual([source]);
  }),
);

it.effect(
  "excludes archived history after checkout retirement and omits colliding standalone identities",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const archived = "00000000-0000-4000-8000-0000deadbeef";
      f.archivedEntries.set(archived, {
        version: 2,
        sessionId: archived,
        projectPath: "/project",
        projectName: "Project",
        workingDirectory: "/deleted-checkout",
        activeRoot: "/cake/sessions",
        resolvedRoot: "/cake/resolved",
        createdAt: "2026-01-01",
        modifiedAt: "2026-03-01",
      });
      // Historical identities remain available through exact lookup, never the list.
      expect(yield* f.directText("sessions.list", {})).not.toContain(archived);
      expect(f.listReads.titles).not.toContain(archived);
      expect(f.listReads.entries).not.toContain(archived);
      expect(yield* f.direct("sessions.info", { sessionId: archived })).toMatchObject({
        session: { sessionId: archived, resolved: true },
      });
      f.worktreeRecords.push({
        worktreePath: "/collision",
        projectPath: "/project",
        branch: "agent/collision",
        baseBranch: "main",
        createdAt: "2026-01-01",
      });
      f.sessionsByDirectory.set("/collision", [third]);
      const result = yield* f.directText("sessions.list", { query: "Same" });
      expect(result).toContain("1 sessions");
      expect(result).toContain("00000022");
      expect(result).not.toContain("00000033");
      f.unavailable.add(archived);
      expect(yield* f.directText("sessions.list", {})).not.toContain(archived);
    }),
);

it.effect("uses family-root resolution in a listing snapshot", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Context.get(f.context, SessionFamilyStorage).addChild({
      familyId: "listing-family",
      parentSessionId: target,
      parentWorkingDirectory: "/project",
      childSessionId: third,
      childWorkingDirectory: "/retired-worktree",
      requestId: "child-request",
      projectPath: "/project",
      createdAt: "2026-01-01",
    });
    f.sessionsByDirectory.set("/project", [source, target]);
    f.sessionsByDirectory.set("/retired-worktree", [third]);
    expect(yield* f.directText("sessions.list", {})).toContain(third);
    f.resolve();
    // Storage can migrate a resolved root back into place after the ID discovery pass.
    f.sessionsByDirectory.set("/project", [source]);
    f.listReads.titles.length = 0;
    const archive = Context.get(f.context, SessionArchiveStorage);
    const result = yield* agentControl.invoke("sessions.list", {}, caller).pipe(
      Effect.provideService(SessionArchiveStorage, {
        ...archive,
        resolvedIds: (at) => {
          f.sessionsByDirectory.set("/project", [source, target]);
          return archive.resolvedIds(at);
        },
      }),
      Effect.provide(f.context),
      Effect.map((result) =>
        result === undefined ? result : (discoveryResultText("sessions.list", result) ?? result),
      ),
    );
    expect(result).toContain("1 sessions");
    expect(result).not.toContain(target);
    expect(result).not.toContain(third);
    expect(f.listReads.titles).toEqual([source]);
    expect(f.listReads.locate).toBe(0);
  }),
);

it.effect.each([
  "idle",
  "running",
  "needs-you",
  "failed",
  "interrupted",
  "stopped",
  "done",
  "unread",
  "draft",
] as const)(
  "sessions.list includes non-resolved %s sessions while excluding resolved rows before pagination",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.resolve();
      const families = Context.get(f.context, SessionFamilyStorage);
      if (["failed", "interrupted", "stopped", "done"].includes(status)) {
        yield* families.registerSpawn({
          ...workflowLaunch(third, "Unresolved task"),
          lastReport: {
            status:
              status === "done"
                ? "completed"
                : status === "interrupted"
                  ? "interrupted"
                  : status === "stopped"
                    ? "stopped"
                    : "failed",
            summary: "Recorded outcome",
            reportedAt: "2026-01-02",
          },
        });
      }
      if (status === "unread")
        yield* Context.get(f.context, ApplicationState).transact((state) =>
          Effect.succeed({ ...state, unreadSessionIds: [third] }),
        );
      if (status === "draft") {
        f.sessionsByDirectory.set("/project", [source, target]);
        f.drafts.push({
          sessionId: third,
          projectPath: "/project",
          workingDirectory: "/project",
          title: "Unsent",
          text: "",
          attachments: [],
          labelIds: [],
          resolved: false,
          createdAt: "2026-01-02",
          modifiedAt: "2026-01-02",
          revision: 1,
          status: "saved",
        });
      }
      const runtimes = Context.get(f.context, CakeSessionRuntimes);
      const context = Context.add(f.context, CakeSessionRuntimes, {
        ...runtimes,
        currentStatus: (location) =>
          location.sessionId === third
            ? Effect.succeed({
                streaming: status === "running",
                pending: false,
                persisted: true,
                ...(status === "needs-you" ? { recoveryIssue: "Input needed" } : {}),
              })
            : runtimes.currentStatus(location),
      });
      const call = (input: JsonObject = {}) =>
        agentControl.invoke("sessions.list", input, caller).pipe(
          Effect.provide(context),
          Effect.map((result) =>
            result === undefined
              ? result
              : (discoveryResultText("sessions.list", result) ?? result),
          ),
        );
      const listing = yield* call();
      expect(listing).toContain("2 sessions");
      expect(listing).toContain(`${third} ${status} ${status === "draft" ? "draft" : "active"}`);
      expect(listing).not.toContain(target);
      expect(f.listReads.titles).not.toContain(target);
      expect(yield* call({ limit: 1 })).toContain("2 sessions; next=1");
      const last = yield* call({ limit: 1, offset: 1 });
      expect(last).toContain("2 sessions\n");
      expect(last).not.toContain("next=");
      expect(last).not.toContain(target);
      expect(yield* call({ status, limit: 1 })).toContain(
        status === "idle" ? "2 sessions; next=1" : "1 sessions\n",
      );
    }),
);

it.effect("does not revive a resolved transcript through an unresolved draft fallback", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.resolve();
    f.drafts.push({
      sessionId: target,
      projectPath: "/project",
      workingDirectory: "/project",
      title: "Stale draft",
      text: "Private request",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: "2026-01-01",
      modifiedAt: "2026-01-04",
      revision: 1,
      status: "saved",
    });
    const result = yield* f.directText("sessions.list", {});
    expect(result).toContain("2 sessions");
    expect(result).not.toContain(target);
    expect(result).not.toContain("Stale draft");
    expect(f.listReads.titles).not.toContain(target);
  }),
);

const historicalSessionListInputs: JsonObject[] = [
  { includeResolved: true },
  { includeResolved: false },
  { status: "resolved" },
  { projection: "workflow", includeResolved: true },
  { projection: "workflow", includeResolved: false },
  { projection: "workflow", status: "resolved" },
];
it.effect.each(historicalSessionListInputs)(
  "sessions.list rejects historical options at the backend boundary: %j",
  (input) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.directText("sessions.list", input).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      });
      expect(f.listReads.ids).toEqual([]);
    }),
);

it.effect("paginates a minimal session roster and filters before selecting a page", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (let index = 0; index < 61; index++)
      f.drafts.push({
        sessionId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        projectPath: "/project",
        workingDirectory: "/project",
        title: `Paging ${index}`,
        text: "This request must not appear in a roster.",
        attachments: [],
        labelIds: [],
        resolved: false,
        createdAt: "2026-02-01",
        modifiedAt: "2026-02-01",
        revision: 1,
        status: "saved",
      });
    const first = yield* f.callText("sessions.list");
    assert.ok(typeof first === "string");
    expect(first).toContain("64 sessions; next=20\n");
    expect(first.split("\n")).toHaveLength(22);
    const filtered = yield* f.callText("sessions.list", {
      status: "draft",
      query: "Paging 1",
      offset: 9,
      limit: 2,
      projectPath: "/project",
    });
    expect(filtered).toBe(
      "11 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000118 draft draft - ? ? ? ? user | /project | Paging 18\n00000000-0000-4000-8000-000000000119 draft draft - ? ? ? ? user | /project | Paging 19",
    );
    const last = yield* f.callText("sessions.list", { status: "draft", limit: 50, offset: 50 });
    assert.ok(typeof last === "string");
    expect(last.split("\n")).toHaveLength(13);
    expect(last).toContain("61 sessions\n");
    expect(yield* f.callText("sessions.list", { projectPath: "/absent" })).toBe("0 sessions");
    expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
      session: { sessionId: target, lifecycle: "active", resolved: false },
    });
    expect(yield* f.callText("sessions.list", { limit: 51 }).pipe(Effect.exit)).toMatchObject({
      _tag: "Failure",
    });
  }),
);

it.effect(
  "resolved lifecycle is independent of stopped/completed execution outcomes without content inspection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const families = Context.get(f.context, SessionFamilyStorage);
      f.resolve();
      for (const outcome of ["stopped", "completed"] as const) {
        yield* families.registerSpawn({
          sessionId: target,
          projectPath: "/project",
          workingDirectory: "/project",
          requester: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
          reportDelivered: true,
          handoffSettled: true,
          lastReport: { status: outcome, summary: "PRIVATE_REPORT", reportedAt: "2026-01-02" },
        });
        yield* families.recordLaunchReport(target, {
          status: outcome,
          summary: "PRIVATE_REPORT",
          reportedAt: "2026-01-02",
        });
        expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
          session: { resolved: true, lifecycle: "resolved", outcome },
        });
        expect(f.inspections).toEqual([]);
        expect(yield* f.callText("sessions.list")).not.toContain(target);
        f.inspections.length = 0;
      }
    }),
);

it.effect(
  "sessions.list keeps launch status minimal and reports available through exact inspection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const families = Context.get(f.context, SessionFamilyStorage);
      for (const [sessionId, status, summaryText] of [
        [target, "failed", "Typecheck failed"],
        [third, "completed", "Landed abc123"],
      ] as const)
        yield* families.registerSpawn({
          sessionId,
          projectPath: "/project",
          workingDirectory: "/project",
          requester: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
          reportDelivered: true,
          handoffSettled: true,
          launchedAt: "2026-01-01",
          lastReport: { status, summary: summaryText, reportedAt: "2026-01-02" },
        });
      expect(yield* f.callText("sessions.list", { launchedByCakeChat: true })).toBe(
        "2 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 failed active failed ? ? ? ? user | /project | Same title\n00000000-0000-4000-8000-000000000033 done active completed ? ? ? ? user | /project | Same title",
      );
      expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
        session: {
          outcome: "failed",
          lifecycle: "active",
          resolved: false,
        },
      });
      expect(
        yield* f.callText("sessions.list", { launchedByCakeChat: true, attentionOnly: true }),
      ).toBe(
        "1 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 failed active failed ? ? ? ? user | /project | Same title",
      );
      for (const status of ["interrupted", "stopped"] as const) {
        yield* families.recordLaunchReport(target, {
          status,
          summary: status,
          reportedAt: "2026-01-03",
        });
        expect(yield* f.callText("sessions.list", { launchedByCakeChat: true })).toContain(
          `00000000-0000-4000-8000-000000000022 ${status} active ${status} ? ? ? ? user | /project | Same title`,
        );
        expect(
          yield* f.callText("sessions.list", { launchedByCakeChat: true, attentionOnly: true }),
        ).toBe(
          status === "interrupted"
            ? "1 sessions\nid status lifecycle outcome tokens cache age ttl purpose | project | title\n00000000-0000-4000-8000-000000000022 interrupted active interrupted ? ? ? ? user | /project | Same title"
            : "0 sessions",
        );
      }
      f.pauseMessage();
      yield* f.call("sessions.send", { sessionId: third, text: "Run" });
      yield* Queue.take(f.prompts);
      expect(yield* f.callText("sessions.list", { launchedByCakeChat: true })).toContain(
        "00000000-0000-4000-8000-000000000033 running active - ? ? ? ? user | /project | Same title",
      );
      yield* Deferred.succeed(f.messageRelease, undefined);
    }),
);

const workflowCaller = {
  kind: "cake-chat" as const,
  sessionId: CAKE_CHAT_SESSION_ID,
  title: "Cake Chat",
};
const workflowLaunch = (sessionId: string, title = "Task session") => ({
  sessionId,
  title,
  projectPath: "/project",
  workingDirectory: "/project",
  requester: { kind: "cake-chat" as const, sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
  reportDelivered: true,
  handoffSettled: true,
  launchedAt: "2026-01-01",
});

it.effect(
  "all status projections prefer a current turn over a retained or late failure report",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const families = Context.get(f.context, SessionFamilyStorage);
      yield* families.registerSpawn({
        ...workflowLaunch(target, "Continued task"),
        lastReport: { status: "failed", summary: "Historical failure", reportedAt: "2026-01-02" },
      });
      const original = Context.get(f.context, CakeSessionRuntimes);
      let latestTurnOutcome: "failed" | "complete" = "failed";
      let streaming = false;
      const context = Context.add(f.context, CakeSessionRuntimes, {
        ...original,
        currentStatus: () =>
          Effect.succeed({
            streaming,
            pending: false,
            persisted: true,
            latestTurnOutcome,
          }),
      });
      const call = (command: string, input: JsonValue = {}) =>
        agentControl.invoke(command, input, workflowCaller).pipe(
          Effect.provide(context),
          Effect.map((result) =>
            result === undefined ? result : (discoveryResultText(command, result) ?? result),
          ),
        );
      expect(yield* call("sessions.list", { launchedByCakeChat: true })).toContain(
        "00000000-0000-4000-8000-000000000022 failed active failed",
      );
      streaming = true;
      expect(yield* call("sessions.list", { launchedByCakeChat: true })).toContain(
        "00000000-0000-4000-8000-000000000022 running",
      );
      streaming = false;
      latestTurnOutcome = "complete";
      // Delivery time is not execution order: this historical notice arrives after success.
      yield* families.recordLaunchReport(target, {
        status: "failed",
        summary: "Late historical failure",
        reportedAt: "2026-01-04",
      });
      expect(yield* call("sessions.list", { launchedByCakeChat: true })).toContain(
        "00000000-0000-4000-8000-000000000022 done active completed",
      );
      expect(yield* call("sessions.info", { sessionId: target })).toMatchObject({
        session: { outcome: "completed" },
      });
      const roster = yield* call("sessions.list", { projection: "workflow" });
      expect(roster).toContain("\topen\tcompleted\t-");
      expect(roster).toContain("blocked/stopped=0");
      latestTurnOutcome = "failed";
      expect(yield* call("sessions.list", { launchedByCakeChat: true })).toContain(
        "00000000-0000-4000-8000-000000000022 failed active failed",
      );
      expect((yield* families.state()).spawnedSessions[0]?.lastReport?.summary).toBe(
        "Late historical failure",
      );
    }),
);

it.effect(
  "a resumed turn clears a failed outcome while it runs; only a latest failure stays failed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).registerSpawn({
        ...workflowLaunch(target, "Resumed task"),
        lastReport: { status: "failed", summary: "Daily limit reached", reportedAt: "2026-01-02" },
      });
      const row = (status: string, outcome: string) =>
        `00000000-0000-4000-8000-000000000022 ${status} active ${outcome} ? ? ? ? user | /project | Same title`;
      const roster = agentControl
        .invoke("sessions.list", { projection: "workflow" }, workflowCaller)
        .pipe(
          Effect.provide(f.context),
          Effect.map((result) =>
            result === undefined
              ? result
              : (discoveryResultText("sessions.list", result) ?? result),
          ),
        );
      const send = (text: string) =>
        f
          .call("sessions.send", { sessionId: target, text })
          .pipe(Effect.andThen(Queue.take(f.prompts)));
      f.failedTurns.add(target);
      yield* send("Fast request");
      // The real runtime marks unread after its settlement hook has recorded the outcome.
      yield* Queue.take(f.saves);
      expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
        status: "idle",
        session: { outcome: "failed" },
      });
      expect(yield* f.callText("sessions.list", { launchedByCakeChat: true })).toContain(
        row("failed", "failed"),
      );

      f.failedTurns.delete(target);
      f.pauseMessage();
      yield* send("Try again without Fast");
      const running = yield* f.call("sessions.info", { sessionId: target });
      expect(running).toMatchObject({ status: "running" });
      expect(running).not.toHaveProperty("session.outcome");
      expect(yield* f.callText("sessions.list", { launchedByCakeChat: true })).toContain(
        row("running", "-"),
      );
      const workingRoster = yield* roster;
      expect(workingRoster).toContain("\topen\trunning\t-\t-\tunknown\t");
      expect(workingRoster).not.toContain("Daily limit reached");

      yield* Deferred.succeed(f.messageRelease, undefined);
      yield* Queue.take(f.saves);
      expect(yield* f.call("sessions.info", { sessionId: target })).toMatchObject({
        status: "idle",
        session: { outcome: "completed" },
      });
      expect(yield* f.callText("sessions.list", { launchedByCakeChat: true })).toContain(
        row("done", "completed"),
      );
      expect(yield* roster).not.toContain("Daily limit reached");
    }),
);

it.effect(
  "workflow roster preserves unprotected names, redacts protected records, deduplicates results and never loads content or wakes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      f.protectedSessions.add(target);
      f.protectedSessions.add(third);
      yield* storage.registerSpawn(workflowLaunch(target, "Task session"));
      yield* storage.registerSpawn(workflowLaunch(third, "New session"));
      yield* storage.registerSpawn(workflowLaunch(source, "Retained launch label"));
      yield* storage.registerSpawn(
        workflowLaunch("00000000-0000-4000-8000-000000000088", "Untitled"),
      );
      yield* Context.get(f.context, ApplicationState).transact((state) =>
        Effect.succeed({
          ...state,
          projects: state.projects.map((project) => ({
            ...project,
            todos: {
              items: [
                {
                  id: "00000000-0000-4000-8000-000000000099",
                  title: "Repair launch roster",
                  description: "A durable task label.",
                  status: "",
                  state: "open" as const,
                  revision: 0,
                  associations: [
                    { kind: "session" as const, sessionId: target, title: "Task session" },
                  ],
                },
              ],
              selectedId: null,
              sequence: 0,
              deliveryToken: null,
              pending: [],
            },
          })),
        }),
      );
      for (const [id, reportedAt, title] of [
        ["old", "2026-01-01", "Old result"],
        ["new", "2026-01-02", "Inspect auth routing"],
      ] as const)
        yield* storage.recordCompletion({
          id,
          reportedAt,
          title,
          sessionId: third,
          coordinatorSessionId: CAKE_CHAT_SESSION_ID,
          summary: "Investigation finished",
          resultMessageRef: messageReference(third, "result"),
          kind: "investigation",
          state: "pending",
          decisions: ["review", "next-step"],
        });
      const before = yield* storage.state();
      const invoke = yield* batchRegistry(f);
      const response = yield* invoke("sessions.list", { projection: "workflow", limit: 50 });
      const text = response.text;
      expect(text).toContain("4 launches");
      expect(text).toContain("Retained launch label");
      expect(text).toContain("Unnamed task (title unknown)");
      expect(text).toContain("redacted\tTask session");
      expect(text).not.toContain("Repair launch roster");
      expect(text).not.toContain("Inspect auth routing");
      expect(text).not.toContain(messageReference(third, "result"));
      expect(text).toContain(`cake://session/${target}`);
      expect(text).toContain("readiness unknown");
      expect(yield* storage.state()).toEqual(before);
      expect(f.inspections).toEqual([]);
      expect(f.queries).toEqual([]);
      expect(f.listReads.titles).toEqual([]);
      expect(f.listReads.ids).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
      expect(f.grants).toEqual([]);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect("workflow timings aggregate repeated queries and count work before pagination", () => {
  const messages: unknown[] = [];
  let nanos = 0n;
  const advance = (ms: number) =>
    Effect.sync(() => {
      nanos += BigInt(ms) * 1_000_000n;
    });
  return Effect.gen(function* () {
    const f = yield* fixture();
    const families = Context.get(f.context, SessionFamilyStorage);
    yield* families.registerSpawn(workflowLaunch(target, "PRIVATE_TASK_ONE"));
    yield* families.registerSpawn(workflowLaunch(third, "PRIVATE_TASK_TWO"));
    const archive = Context.get(f.context, SessionArchiveStorage);
    const runtimes = Context.get(f.context, CakeSessionRuntimes);
    const worktrees = Context.get(f.context, ManagedWorktrees);
    const requests = Context.get(f.context, RendererRequestCoordinator);
    const context = f.context.pipe(
      Context.add(SessionFamilyStorage, {
        ...families,
        state: () => advance(2_000).pipe(Effect.andThen(families.state())),
      }),
      Context.add(SessionArchiveStorage, {
        ...archive,
        recordedResolvedIds: (location) =>
          advance(3_000).pipe(Effect.andThen(archive.recordedResolvedIds(location))),
      }),
      Context.add(CakeSessionRuntimes, {
        ...runtimes,
        currentStatus: (target) =>
          advance(1_000).pipe(Effect.andThen(runtimes.currentStatus(target))),
      }),
      Context.add(ManagedWorktrees, {
        ...worktrees,
        records: () => advance(4_000).pipe(Effect.andThen(worktrees.records())),
      }),
      Context.add(RendererRequestCoordinator, {
        ...requests,
        pendingUserInputs: () => advance(5_000).pipe(Effect.andThen(requests.pendingUserInputs())),
      }),
    );
    const clock = yield* Clock.Clock;
    const result = yield* agentControl
      .invoke(
        "sessions.list",
        {
          projection: "workflow",
          query: "PRIVATE_TASK",
          limit: 1,
        },
        workflowCaller,
      )
      .pipe(
        Effect.provide(context),
        Effect.provideService(Clock.Clock, {
          ...clock,
          monotonicTimeNanosUnsafe: () => nanos,
          monotonicTimeNanos: Effect.sync(() => nanos),
        }),
      );
    expect(discoveryResultText("sessions.list", result ?? null)).toContain("2 launches; next=1");
    expect(messages).toEqual([
      [
        "Slow workflow session list",
        {
          completed: true,
          phase: "format",
          phasesMs: {
            scope: 0,
            state: 2_000,
            metadata: 9_000,
            rows: 0,
            resolution: 3_000,
            runtime: 2_000,
            selection: 0,
            format: 0,
          },
          totalMs: 16_000,
          launches: 2,
          directories: 1,
          matched: 2,
          returned: 1,
        },
      ],
    ]);
    expect(JSON.stringify(messages)).not.toContain("PRIVATE");
    expect(f.inspections).toEqual([]);
    expect(f.listReads.ids).toEqual([]);
    expect(f.listReads.titles).toEqual([]);
    expect(f.runtimeCreates).toEqual([source]);
    // A fast subsequent request emits nothing and cannot reuse the previous totals.
    yield* f.directText("sessions.list", { projection: "workflow" }, workflowCaller);
    expect(messages).toHaveLength(1);
  }).pipe(
    Effect.provide(
      Logger.layer([
        Logger.make(({ message }) => {
          if (Array.isArray(message) && message[0] === "Slow workflow session list")
            messages.push(message);
        }),
      ]),
    ),
  );
});

it.effect(
  "interrupted workflow listings retain partial timings without claiming completion",
  () => {
    const messages: unknown[] = [];
    let nanos = 0n;
    return Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).registerSpawn(workflowLaunch(target));
      const reading = yield* Deferred.make<void>();
      const runtimes = Context.get(f.context, CakeSessionRuntimes);
      const context = Context.add(f.context, CakeSessionRuntimes, {
        ...runtimes,
        currentStatus: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(reading, undefined);
            return yield* Effect.never;
          }),
      });
      const clock = yield* Clock.Clock;
      const worker = yield* agentControl
        .invoke("sessions.list", { projection: "workflow" }, workflowCaller)
        .pipe(
          Effect.provide(context),
          Effect.provideService(Clock.Clock, {
            ...clock,
            monotonicTimeNanosUnsafe: () => nanos,
            monotonicTimeNanos: Effect.sync(() => nanos),
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* Deferred.await(reading);
      nanos += 3_000_000_000n;
      yield* Fiber.interrupt(worker);
      expect(messages).toEqual([
        [
          "Slow workflow session list",
          {
            completed: false,
            phase: "runtime",
            phasesMs: { scope: 0, state: 0, metadata: 0, rows: 0, resolution: 0, runtime: 3_000 },
            totalMs: 3_000,
            launches: 1,
            directories: 1,
            matched: 0,
            returned: 0,
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            if (Array.isArray(message) && message[0] === "Slow workflow session list")
              messages.push(message);
          }),
        ]),
      ),
    );
  },
);

it.effect("session APIs expose User-first purpose and stop directing converted assignments", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const storage = Context.get(f.context, SessionFamilyStorage);
    yield* storage.registerPurpose({
      sessionId: target,
      projectPath: "/project",
      purpose: "delegated",
      createdPurpose: "delegated",
    });
    yield* storage.registerSpawn(workflowLaunch(target, "Human takeover"));
    expect(yield* f.direct("sessions.list", {})).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: target, purpose: "delegated" }),
      ]),
    });
    const list = yield* f.directText("sessions.list", {});
    assert.ok(typeof list === "string");
    expect(list.indexOf(source)).toBeLessThan(list.indexOf(target));
    expect(list).toContain("delegated |");
    expect(yield* f.direct("sessions.info", { sessionId: target })).toMatchObject({
      session: { purpose: "delegated" },
    });
    yield* storage.moveToUser(target);
    expect(yield* f.direct("sessions.info", { sessionId: target })).toMatchObject({
      session: { purpose: "user" },
    });
    expect(
      yield* f.direct("sessions.list", { projection: "workflow" }, workflowCaller),
    ).toMatchObject({
      projection: "workflow",
      sessions: expect.arrayContaining([
        expect.objectContaining({
          sessionId: target,
          purpose: "user",
          next: "human-led; no autonomous assignment",
        }),
      ]),
    });
    const workflow = yield* f.directText(
      "sessions.list",
      { projection: "workflow" },
      workflowCaller,
    );
    expect(workflow).toContain("human-led; no autonomous assignment");
    expect(workflow).toContain("\tuser");
    expect((yield* storage.state()).spawnedSessions[0]?.requester.sessionId).toBe(
      CAKE_CHAT_SESSION_ID,
    );
  }),
);

it.effect(
  "workflow roster separates execution done, lifecycle resolution, and handled review decisions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      for (const id of [source, target, third])
        yield* storage.registerSpawn({
          ...workflowLaunch(
            id,
            id === source
              ? "Execution only"
              : id === target
                ? "Resolved task"
                : "Explicit ready result",
          ),
          lastReport: { status: "completed", summary: "Work finished", reportedAt: "2026-01-02" },
        });
      yield* storage.recordCompletion({
        id: "ready",
        sessionId: third,
        coordinatorSessionId: CAKE_CHAT_SESSION_ID,
        title: "Explicit ready result",
        summary: "Tests passed; review requested",
        reportedAt: "2026-01-02",
        kind: "ready",
        state: "handled",
        decisions: ["review", "merge", "resolve"],
      });
      f.resolve();
      const current = yield* f.directText(
        "sessions.list",
        { projection: "workflow" },
        workflowCaller,
      );
      assert.equal(typeof current, "string");
      expect(current).toContain(
        `working\tExecution only\tcake://session/${source}\topen\tcompleted`,
      );
      expect(current).toContain(
        `ready-for-review/merge\tExplicit ready result\tcake://session/${third}\topen\tcompleted`,
      );
      expect(current).toContain("\thandled\tnone\tunknown\treview result; verify merge");
      expect(current).not.toContain("Resolved task");
      expect(current).toContain("2 launches");
      expect(current).not.toContain("resolved=");
      expect(yield* f.direct("sessions.info", { sessionId: target })).toMatchObject({
        session: { lifecycle: "resolved", outcome: "completed" },
      });
      expect(
        yield* f.directText(
          "sessions.list",
          { projection: "workflow", status: "done" },
          workflowCaller,
        ),
      ).toContain("2 launches");
    }),
);

it.effect(
  "workflow roster reports stopped and blocked reasons without treating completion as readiness",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      for (const [id, status, summary] of [
        [target, "blocked", "Need repository credentials"],
        [third, "stopped", "Stopped by user"],
        [source, "failed", "Typecheck failed"],
      ] as const)
        yield* storage.registerSpawn({
          ...workflowLaunch(id, status),
          lastReport: { status, summary, reportedAt: "2026-01-02" },
        });
      const result = yield* f.directText(
        "sessions.list",
        { projection: "workflow" },
        workflowCaller,
      );
      expect(result).toContain("blocked/stopped=3");
      expect(result).toContain("Need repository credentials");
      expect(result).toContain("Stopped by user");
      expect(result).toContain("Typecheck failed");
      expect(result).toContain("\tunknown\tinspect blocker/stop");
      expect(result).toContain("ready-for-review/merge=0");
    }),
);

it.effect(
  "workflow roster exposes live pending user input before running and removes the wait on cancellation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).registerSpawn(
        workflowLaunch(source, "Choose deployment"),
      );
      f.active.add(source);
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      const uiEvents = yield* Queue.unbounded<void>();
      const uiReady = yield* Deferred.make<void>();
      yield* Context.get(f.context, ClientEvents)
        .artifacts(11)
        .pipe(
          Stream.runForEach((event) =>
            event.type === "renderer-events-ready"
              ? Deferred.succeed(uiReady, undefined)
              : event.type === "ui-request"
                ? Queue.offer(uiEvents, undefined)
                : Effect.void,
          ),
          Effect.forkScoped,
        );
      yield* Deferred.await(uiReady);
      const request = yield* f.requests
        .requestUi(source, {
          kind: "text",
          title: "Which region?",
          message: "Do not expose this full input body",
        })
        .pipe(Effect.forkChild);
      yield* Queue.take(uiEvents);
      const waiting = yield* f.directText(
        "sessions.list",
        { projection: "workflow" },
        workflowCaller,
      );
      expect(waiting).toContain(
        `waiting-for-input\tChoose deployment\tcake://session/${source}\topen\twaiting\tWhich region?`,
      );
      expect(waiting).toContain("answer input");
      expect(waiting).not.toContain("Do not expose");
      yield* Fiber.interrupt(request);
      const running = yield* f.directText(
        "sessions.list",
        { projection: "workflow" },
        workflowCaller,
      );
      expect(running).toContain(
        `working\tChoose deployment\tcake://session/${source}\topen\trunning`,
      );
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect(
  "workflow roster fails on unknown resolution rather than exposing potential history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Context.get(f.context, SessionFamilyStorage).registerSpawn(
        workflowLaunch(target, "Recover interrupted work"),
      );
      const archive = Context.get(f.context, SessionArchiveStorage);
      const runtimes = Context.get(f.context, CakeSessionRuntimes);
      const result = yield* agentControl
        .invoke("sessions.list", { projection: "workflow" }, workflowCaller)
        .pipe(
          Effect.provideService(SessionArchiveStorage, {
            ...archive,
            recordedResolvedIds: () =>
              Effect.fail(
                new SessionArchiveStorageError({
                  operation: "recordedResolvedIds",
                  sessionId: "",
                  message: "Index unavailable",
                }),
              ),
          }),
          Effect.provideService(CakeSessionRuntimes, {
            ...runtimes,
            currentStatus: () =>
              Effect.succeed({
                streaming: false,
                pending: false,
                persisted: true,
                recoveryIssue: "Unfinished tool requires user review",
              }),
          }),
          Effect.provide(f.context),
          Effect.exit,
        );
      expect(result).toMatchObject({ _tag: "Failure" });
      expect(f.inspections).toEqual([]);
      expect(f.runtimeCreates).toEqual([source]);
    }),
);

it.effect(
  "workflow roster uses recorded landing state and never suggests merging already-landed work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      yield* storage.registerSpawn({ ...workflowLaunch(target), workingDirectory: "/managed" });
      f.worktreeRecords.push({
        projectPath: "/project",
        worktreePath: "/managed",
        branch: "agent/launch-roster",
        baseBranch: "main",
        createdAt: "2026-01-01",
        state: "resolved",
        resolvedFrom: "landed",
        landedSourceCommit: "abc123",
        baseCommit: "base123",
      });
      const result = yield* f.directText(
        "sessions.list",
        { projection: "workflow" },
        workflowCaller,
      );
      expect(result).toContain("Worktree: launch-roster");
      expect(result).toContain("landed-source=abc123; head/dirty=unknown");
      expect(result).toContain("already-landed\treview/resolve; already landed");
      expect(result).toContain("\topen\tunknown");
      expect(f.listReads.titles).toEqual([]);
    }),
);

it.effect(
  "workflow roster scopes exact invoking-chat launches before filtering and bounded pagination",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, SessionFamilyStorage);
      const projectChat = { ...workflowCaller, sessionId: projectChatSessionId("/project") };
      for (let i = 0; i < 55; i++)
        yield* storage.registerSpawn({
          ...workflowLaunch(
            `00000000-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`,
            `Task ${i}`,
          ),
          requester: { kind: "cake-chat", sessionId: projectChat.sessionId, title: "Project Chat" },
        });
      yield* storage.registerSpawn({
        ...workflowLaunch(target, "Resolved project task"),
        requester: { kind: "cake-chat", sessionId: projectChat.sessionId, title: "Project Chat" },
      });
      f.resolve();
      yield* storage.registerSpawn(workflowLaunch(source, "Global chat task"));
      yield* storage.registerSpawn({
        ...workflowLaunch("00000000-0000-4000-8000-000000000077", "Global foreign task"),
        projectPath: "/other",
      });
      yield* storage.registerSpawn({
        ...workflowLaunch(third, "Foreign project launch"),
        projectPath: "/other",
        requester: { kind: "cake-chat", sessionId: projectChat.sessionId, title: "Project Chat" },
      });
      const first = yield* f.directText(
        "sessions.list",
        { projection: "workflow", limit: 50 },
        projectChat,
      );
      expect(first).toContain("55 launches; next=50");
      expect(first).not.toContain("Global chat task");
      expect(first).not.toContain("Foreign project launch");
      expect(first).not.toContain("Resolved project task");
      expect(first).toContain("\t/project");
      const second = yield* f.directText(
        "sessions.list",
        { projection: "workflow", limit: 50, offset: 50 },
        projectChat,
      );
      expect(second).toContain("55 launches |");
      assert.ok(typeof second === "string");
      expect(second.split("\n").filter((line) => line.startsWith("working\t"))).toHaveLength(5);
      expect(
        yield* f.directText(
          "sessions.list",
          { projection: "workflow", query: "Task 54", limit: 1 },
          projectChat,
        ),
      ).toContain("1 launches |");
      expect(
        yield* f.directText(
          "sessions.list",
          { projection: "workflow", projectPath: "/other" },
          projectChat,
        ),
      ).toContain("1 launches");
      const global = yield* f.directText(
        "sessions.list",
        { projection: "workflow", limit: 1 },
        workflowCaller,
      );
      expect(global).toContain("2 launches; next=1");
      expect(global).not.toContain("Resolved project task");
      const foreign = yield* f.directText(
        "sessions.list",
        { projection: "workflow", projectPath: "/other" },
        workflowCaller,
      );
      expect(foreign).toContain("1 launches");
      expect(foreign).toContain("Global foreign task");
      expect(foreign).toContain("\t/other");
      expect(
        yield* f.directText(
          "sessions.list",
          { projection: "workflow", projectPath: "/project" },
          workflowCaller,
        ),
      ).toContain("1 launches");
      expect(yield* f.directText("sessions.list", { projection: "workflow" })).toMatchObject({
        ok: false,
      });
      expect(
        yield* f
          .direct("sessions.list", { projection: "workflow", limit: 51 }, projectChat)
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" });
      expect(f.listReads.ids).toEqual([]);
    }),
);

it.effect(
  "disconnect/rebind during Pi admission neither repeats delivery nor loses the thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
      f.pauseAdmission();
      const pending = yield* f
        .call("sessions.send", { sessionId: target, text: "Once" })
        .pipe(Effect.forkChild);
      yield* Queue.take(f.admissions);
      yield* f.requests.releaseConnection(11);
      yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 22);
      yield* Deferred.succeed(f.admissionRelease, undefined);
      const result = yield* Fiber.join(pending);
      expect(yield* Queue.take(f.prompts)).toMatchObject({ sessionId: target });
      const { threadId } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ threadId: Schema.String }),
      )(result);
      expect(yield* f.call("sessions.thread", { threadId })).toMatchObject({
        ok: true,
        thread: { messageCount: 1, participants: [{ sessionId: source }, { sessionId: target }] },
      });
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect(
  "backend batch sends retain independent correlation and Cake Chat digest/silent/interrupt policies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const invoke = yield* batchRegistry(f);
      const result = yield* invoke("sessions.send-batch", {
        sessionIds: [target, third],
        text: "Shared instructions",
        maxMessages: 5,
      });
      expect(result.structuredContent).toMatchObject({
        result: {
          status: "complete",
          expectsResponse: true,
          resultDelivery: "notification",
          outcomes: [
            { sessionId: target, status: "accepted" },
            { sessionId: third, status: "accepted" },
          ],
        },
      });
      const messages = yield* Effect.forEach([0, 1], () => Queue.take(f.prompts));
      const envelopes = messages.map((message) => parseCrossSessionMessage(message.text)?.metadata);
      for (const envelope of envelopes)
        expect(envelope).toMatchObject({
          expectsResponse: true,
          resultDelivery: "notification",
          maxMessages: 5,
          sender: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat" },
        });
      expect(envelopes[0]?.threadId).not.toBe(envelopes[1]?.threadId);
      expect(envelopes[0]?.messageId).not.toBe(envelopes[1]?.messageId);
      expect(result.text).not.toContain("Shared instructions");
      yield* invoke("sessions.send", {
        sessionId: target,
        text: "Single follow-up",
        resultDelivery: "ignore",
      });
      const single = parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata;
      expect(single).toMatchObject({ expectsResponse: false });
      expect(single).toHaveProperty("resultDelivery", "ignore");
      expect(
        (yield* invoke("sessions.send-batch", {
          sessionIds: [target],
          text: "FYI",
          resultDelivery: "ignore",
        })).structuredContent,
      ).toMatchObject({
        result: { expectsResponse: false, resultDelivery: "ignore" },
      });
      yield* Queue.take(f.prompts);
      expect(
        JSON.parse(
          (yield* invoke("sessions.send", {
            sessionId: third,
            text: "Ping",
            resultDelivery: "reply",
          })).text,
        ),
      ).toMatchObject({
        expectsResponse: true,
        resultDelivery: "reply",
      });
      expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject(
        {
          expectsResponse: true,
          resultDelivery: "reply",
        },
      );
    }),
);

it.effect("backend corrections start idle recipients and steer busy recipients by default", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.active.add(third);
    f.pauseMessage();
    const invoke = yield* batchRegistry(f);
    expect(
      (yield* invoke("sessions.send-batch", {
        sessionIds: [target, third],
        text: "Ordinary message",
      })).structuredContent,
    ).toMatchObject({
      result: {
        status: "complete",
        outcomes: [
          { sessionId: target, delivery: "prompt", status: "accepted" },
          { sessionId: third, delivery: "steer", status: "accepted" },
        ],
      },
    });
    expect(yield* Queue.take(f.prompts)).toMatchObject({ sessionId: target, delivery: "prompt" });
    expect(yield* Queue.take(f.prompts)).toMatchObject({ sessionId: third, delivery: "steer" });
    // Accepted turns bridge admission to the first streaming event.
    expect(
      yield* f.call("sessions.send", { sessionId: target, text: "While preparing" }),
    ).toMatchObject({
      delivery: "steer",
      status: "accepted",
    });
    yield* Deferred.succeed(f.messageRelease, undefined);
  }),
);

it.effect("backend batches retain failures alongside subsequent successes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.unavailable.add(target);
    const invoke = yield* batchRegistry(f);
    expect(
      (yield* invoke("sessions.send-batch", {
        sessionIds: ["missing", target, third],
        text: "New direction",
        delivery: "steer",
        resultDelivery: "ignore",
      })).structuredContent,
    ).toMatchObject({
      result: {
        status: "partial",
        outcomes: [
          { sessionId: "missing", ok: false, error: "Unknown session reference: missing" },
          { sessionId: target, ok: false, error: expect.stringContaining("Recipient unavailable") },
          { sessionId: third, ok: true, delivery: "steer" },
        ],
      },
    });
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      expectsResponse: false,
    });
    expect(yield* Queue.size(f.prompts)).toBe(0);
  }),
);

it.effect("Cake Chat keeps report policy and protected-task redaction without a renderer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const global = yield* cakeChatRuntime
      .acquireOptions({
        configuration: {
          location: { workingDirectory: "/home", sessionDirectory: "/cake/global" },
          agentDirectory: "/cake",
        },
        target: { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
        newSession: false,
      })
      .pipe(Effect.provide(f.context));
    const control = global.runtime.globalControl;
    assert.ok(control);
    const call = (name: string, input: JsonObject) =>
      Effect.promise(() => control.invoke({ name, arguments: input }, signal()));
    expect(
      yield* call("settings.update", { key: "instructions.global", value: "Coordinator-owned" }),
    ).toMatchObject({ ok: true, value: { value: "Coordinator-owned" } });
    f.protect();
    expect(yield* call("sessions.info", { sessionId: target })).toMatchObject({
      ok: true,
      session: {
        sessionId: target,
        title: "Task session",
        deepLink: `cake://session/${target}`,
        resolved: false,
        lifecycle: "active",
      },
    });
    expect(f.inspections).toEqual([]);
    expect(yield* call("sessions.history", { sessionId: target })).toMatchObject({
      ok: false,
      error: expect.stringContaining("task inputs"),
    });
    const receipt = yield* call("sessions.send", {
      sessionId: target,
      text: "Status?",
      resultDelivery: "notification",
    });
    expect(receipt).toMatchObject({
      ok: true,
      resultDelivery: "notification",
      expectsResponse: true,
    });
    expect(receipt).not.toHaveProperty("targetTitle");
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      sender: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID },
      resultDelivery: "notification",
      expectsResponse: true,
    });
    expect(
      yield* call("sessions.send", { sessionId: target, text: "Quiet", resultDelivery: "ignore" }),
    ).toMatchObject({ ok: true, resultDelivery: "ignore", expectsResponse: false });
    expect(parseCrossSessionMessage((yield* Queue.take(f.prompts)).text)?.metadata).toMatchObject({
      expectsResponse: false,
    });
    expect(f.requestCalls).toEqual([]);
  }),
);

it.effect(
  "omitted sends reach each launch's recorded parent through both runtime routing boundaries",
  () =>
    Effect.gen(function* () {
      for (const parentSessionId of [projectChatSessionId("/project"), CAKE_CHAT_SESSION_ID]) {
        const f = yield* fixture(true);
        yield* Context.get(f.context, SessionFamilyStorage).registerSpawn({
          sessionId: source,
          projectPath: "/project",
          workingDirectory: "/project",
          requester: { kind: "cake-chat", sessionId: parentSessionId, title: "Owner" },
          reportDelivered: true,
          handoffSettled: true,
        });
        for (const sessionId of [undefined, "parent"]) {
          const input = {
            ...(sessionId ? { sessionId } : {}),
            text: "Owner question",
            resultDelivery: "reply",
          };
          const special = yield* f.familyCall("sessions.send", input, "46866");
          expect(special).toMatchObject({
            ok: true,
            target:
              parentSessionId === CAKE_CHAT_SESSION_ID
                ? { kind: "cake-chat" }
                : { sessionId: parentSessionId },
          });
          const envelope = parseCrossSessionMessage((yield* Queue.take(f.prompts)).text);
          expect(envelope).toMatchObject({
            text: "Owner question",
            metadata: {
              sourceMessageRef: messageReference(source, "46866"),
              sender: { sessionId: source },
              resultDelivery: "reply",
            },
          });
          expect(yield* f.call("sessions.send", input, "46867")).toMatchObject({
            ok: true,
            target: { sessionId: parentSessionId },
          });
          expect((yield* Queue.take(f.prompts)).sessionId).toBe(parentSessionId);
        }
        // A concrete destination is never replaced by owner routing.
        expect(
          yield* f.call("sessions.send", {
            sessionId: third,
            text: "Explicit",
            resultDelivery: "ignore",
          }),
        ).toMatchObject({
          ok: true,
          target: { sessionId: third },
        });
        expect((yield* Queue.take(f.prompts)).sessionId).toBe(third);
        expect(f.requestCalls).toEqual([]);
      }
    }),
);

it.effect("independent nested creation retains its owner even when no result is requested", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const createSession = f.createSession;
    assert.ok(createSession);
    const created = yield* Effect.promise(() =>
      createSession(
        {
          name: "Nested",
          initialPrompt: "Work",
          resultDelivery: "ignore",
          model: { provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false },
        },
        signal(),
      ),
    );
    const value = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(created);
    yield* Queue.take(f.prompts);
    const state = yield* Context.get(f.context, SessionFamilyStorage).state();
    expect(state.sessionParents).toContainEqual({
      sessionId: value.sessionId,
      parentSessionId: source,
      projectPath: "/project",
    });
    expect(state.families).toEqual([]);
    expect(state.spawnedSessions).toEqual([]);
    const restarted = yield* Layer.build(familyStorageHarness(f.familyFiles).layer);
    const restartedContext = Context.merge(f.context, restarted);
    for (const sessionId of [undefined, "parent"]) {
      expect(
        yield* agentControl
          .invoke(
            "sessions.send",
            {
              ...(sessionId ? { sessionId } : {}),
              text: "Nested question",
              resultDelivery: "ignore",
            },
            { ...caller, sessionId: value.sessionId },
          )
          .pipe(Effect.provide(restartedContext)),
      ).toMatchObject({
        ok: true,
        target: { sessionId: source },
      });
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(source);
    }
  }),
);

it.effect(
  "a Side Chat-created task returns to that Side Chat and never reopens a resolved one",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const storage = Context.get(f.context, SessionFamilyStorage);
      yield* storage.registerParent({
        sessionId: third,
        parentSessionId: source,
        kind: "side-chat",
      });
      const options = yield* acquireOptions({
        location,
        sessionId: source,
        newSession: false,
        sideChatSessionId: third,
      }).pipe(Effect.provide(f.context));
      yield* Context.get(f.context, CakeSessionRuntimes).acquire({
        ...options,
        profile: { _tag: "DiscussionSession" },
        runtime: {
          ...options.runtime,
          sessionId: third,
          directSessionDir: true,
          sessionDir: "/cake/discussions/third",
        },
      });
      const create = options.runtime.currentSessionControl?.createSession;
      assert.ok(create);
      const created = yield* Effect.promise(() =>
        create(
          {
            name: "Side Chat task",
            initialPrompt: "Work",
            resultDelivery: "ignore",
            model: { provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false },
          },
          signal(),
        ),
      );
      const task = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(created);
      yield* Queue.take(f.prompts);
      let status: "open" | "resolved" = "open";
      const environment = yield* Layer.build(
        Layer.mock(DiscussionSessionEnvironment, {
          list: () =>
            Effect.succeed([
              {
                id: "thread",
                workingDirectory: "/project",
                parentSessionId: source,
                sidecarSessionId: third,
                pendingParts: [],
                status,
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
                anchor: {
                  path: "/project/file",
                  start: { diffLine: 0 },
                  end: { diffLine: 0 },
                  selectedText: "",
                  contextBefore: "",
                  contextAfter: "",
                  diff: "",
                },
              },
            ]),
        }),
      );
      const context = Context.merge(f.context, environment);
      const send = () =>
        agentControl
          .invoke(
            "sessions.send",
            { text: "Side Chat owner", resultDelivery: "ignore" },
            { ...caller, sessionId: task.sessionId },
          )
          .pipe(Effect.provide(context));
      expect(yield* send()).toMatchObject({ ok: true, target: { sessionId: third } });
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(third);
      status = "resolved";
      expect(yield* send().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("parent is resolved") },
      });
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect("omitted sends use immediate family parents, not a root launch's requester", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const storage = Context.get(f.context, SessionFamilyStorage);
    for (const [parentSessionId, childSessionId] of [
      [source, target],
      [target, third],
    ] as const) {
      yield* storage.addChild({
        familyId: crypto.randomUUID(),
        parentSessionId,
        childSessionId,
        parentWorkingDirectory: "/project",
        childWorkingDirectory: "/project",
        requestId: crypto.randomUUID(),
        projectPath: "/project",
        createdAt: "2026-01-01",
      });
      expect(
        yield* f.direct(
          "sessions.send",
          { text: "Immediate parent", resultDelivery: "ignore" },
          { ...caller, sessionId: childSessionId },
        ),
      ).toMatchObject({
        ok: true,
        target: { sessionId: parentSessionId },
      });
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(parentSessionId);
    }
  }),
);

it.effect(
  "missing, permanent-root, resolved and unavailable parents never fall back or restore",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const storage = Context.get(f.context, SessionFamilyStorage);
      const send = (input: JsonValue, sender = caller) =>
        f
          .direct("sessions.send", input, sender)
          .pipe(Effect.catch((error) => Effect.succeed({ ok: false, error: error.message })));
      expect(yield* send({ text: "Legacy" })).toMatchObject({
        ok: false,
        error: expect.stringContaining("No recorded parent"),
      });
      for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")]) {
        for (const target of [undefined, "parent"]) {
          expect(
            yield* f
              .direct(
                "sessions.send",
                { ...(target ? { sessionId: target } : {}), text: "Root" },
                { ...caller, kind: "cake-chat", sessionId },
              )
              .pipe(Effect.catch((error) => Effect.succeed({ ok: false, error: error.message }))),
          ).toMatchObject({
            ok: false,
            error: expect.stringContaining("no parent"),
          });
        }
        expect(
          yield* f.direct("sessions.send", { sessionId, text: "Self" }, { ...caller, sessionId }),
        ).toMatchObject({ ok: false, error: "A session thread requires two different sessions." });
      }
      yield* storage.registerParent({ sessionId: source, parentSessionId: target });
      f.resolve();
      for (const sessionId of [undefined, "parent"])
        expect(
          yield* send({
            ...(sessionId ? { sessionId } : {}),
            text: "Resolved",
          }),
        ).toMatchObject({
          ok: false,
          error: expect.stringContaining("parent is resolved"),
        });
      expect(f.restored()).toBe(0);
      const missing = "00000000-0000-4000-8000-000000000099";
      yield* storage.registerParent({ sessionId: third, parentSessionId: missing });
      expect(yield* send({ text: "Missing" }, { ...caller, sessionId: third })).toMatchObject({
        ok: false,
      });
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.runtimeCreates).not.toContain(missing);
      const orphan = yield* fixture(true);
      const removedProjectChat = projectChatSessionId("/unregistered");
      yield* Context.get(orphan.context, SessionFamilyStorage).registerParent({
        sessionId: source,
        parentSessionId: removedProjectChat,
      });
      expect(
        yield* orphan
          .direct("sessions.send", { text: "Unavailable Project Chat" })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("parent Project Chat is unavailable") },
      });
      expect(yield* Queue.size(orphan.prompts)).toBe(0);
      expect(orphan.runtimeCreates).not.toContain(removedProjectChat);
    }),
);

it.effect("parent schedules follow recorded provenance while omitted schedules stay self", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* scheduledMessages.initialize().pipe(Effect.provide(f.context));
    const families = Context.get(f.context, SessionFamilyStorage);
    expect(
      yield* f.direct("sessions.schedule", {
        sessionId: "parent",
        text: "Top level",
        delaySeconds: 30,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("No recorded parent") });
    yield* families.registerSpawn({
      sessionId: source,
      projectPath: "/project",
      workingDirectory: "/project",
      requester: {
        kind: "cake-chat",
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Unrelated creator",
      },
      reportDelivered: true,
      handoffSettled: true,
    });
    for (const [parentSessionId, childSessionId] of [
      [source, target],
      [target, third],
    ] as const)
      yield* families.addChild({
        familyId: crypto.randomUUID(),
        parentSessionId,
        childSessionId,
        parentWorkingDirectory: "/project",
        childWorkingDirectory: "/project",
        requestId: crypto.randomUUID(),
        projectPath: "/project",
        createdAt: "2026-01-01",
      });
    for (const [sender, destination] of [
      [{ ...caller, sessionId: third }, target],
      [{ ...caller, sessionId: target }, source],
      [caller, CAKE_CHAT_SESSION_ID],
    ] as const) {
      expect(
        yield* f.direct(
          "sessions.schedule",
          { sessionId: "parent", text: "Hierarchy", delaySeconds: 30 },
          sender,
        ),
      ).toMatchObject({
        ok: true,
        target: { sessionId: destination },
        scheduledMessage: { targetSessionId: destination },
      });
      expect(
        yield* f.direct("sessions.schedule", { text: "Self", delaySeconds: 30 }, sender),
      ).toMatchObject({ ok: true, target: { sessionId: sender.sessionId } });
    }
    // Permanent roots have no recorded parent; never create a self-thread or forward.
    expect(
      yield* f
        .direct(
          "sessions.send",
          { sessionId: "parent", text: "No loop" },
          { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
        )
        .pipe(Effect.result),
    ).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("no parent") },
    });
    expect(yield* Queue.size(f.prompts)).toBe(0);
  }),
);

it.effect("parent navigation resolves before the existing window permission boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const projectChat = projectChatSessionId("/project");
    yield* Context.get(f.context, SessionFamilyStorage).registerParent({
      sessionId: source,
      parentSessionId: projectChat,
    });
    yield* f.requests.bind({ _tag: "ProjectSession", sessionId: source }, 11);
    const opening = yield* f.call("sessions.open", { sessionId: "parent" }).pipe(Effect.forkChild);
    const request = yield* Queue.take(f.deliveries);
    assert.equal(request.event.type, "project-session-control-requested");
    expect(f.requestCalls.at(-1)).toMatchObject({
      command: "sessions.open",
      input: { sessionId: projectChat },
    });
    const denied = { ok: false, command: "sessions.open", error: "Agent navigation is disabled" };
    yield* f.requests.respondProjectControl(11, source, request.event.controlRequestId, denied);
    expect(yield* Fiber.join(opening)).toEqual(denied);

    const companion = yield* cakeChatRuntime
      .acquireOptions({
        configuration: {
          location: { workingDirectory: "/chat", sessionDirectory: "/chats/companion" },
          agentDirectory: "/agent",
        },
        target: { sessionId: SESSION_ASSISTANT_ID, tools: [] },
        newSession: false,
      })
      .pipe(Effect.provide(f.context));
    const control = companion.runtime.globalControl;
    assert.ok(control);
    f.setCompanionContext(target);
    yield* f.requests.bind({ _tag: "CakeChatSession", sessionId: SESSION_ASSISTANT_ID }, 11);
    const pending = yield* Effect.promise(() =>
      control.invoke({ name: "sessions.open", arguments: { sessionId: "parent" } }, signal()),
    ).pipe(Effect.forkChild);
    const requests = yield* f.requests.cakeChatControlSnapshots(11).pipe(
      Stream.filter((items) => items.length > 0),
      Stream.runHead,
    );
    assert.ok(requests._tag === "Some" && requests.value[0]);
    const chatRequest = requests.value[0];
    expect(chatRequest.invocation).toEqual({
      name: "sessions.open",
      arguments: { sessionId: target },
    });
    // Changing the viewed session cannot change an already-admitted navigation request.
    f.setCompanionContext(source);
    yield* f.requests.respondCakeChatControl(11, chatRequest.controlRequestId, denied);
    expect(yield* Fiber.join(pending)).toEqual(denied);
  }),
);

it.effect(
  "the projectless companion schedules to parent once, survives navigation, and can remind itself",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const projectChat = projectChatSessionId("/project");
      const companion = yield* cakeChatRuntime
        .acquireOptions({
          configuration: {
            location: { workingDirectory: "/chat", sessionDirectory: "/chats/companion" },
            agentDirectory: "/agent",
          },
          target: { sessionId: SESSION_ASSISTANT_ID, tools: [] },
          newSession: false,
        })
        .pipe(Effect.provide(f.context));
      const control = companion.runtime.globalControl;
      assert.ok(control);
      const call = (name: string, input: JsonObject) =>
        Effect.promise(() => control.invoke({ name, arguments: input }, signal()));
      yield* scheduledMessages.initialize().pipe(Effect.provide(f.context));
      f.setCompanionContext(projectChat);
      expect(
        yield* call("sessions.schedule", { sessionId: "parent", text: "hello", delaySeconds: 30 }),
      ).toMatchObject({
        ok: true,
        target: { sessionId: projectChat },
        targetTitle: "Project / Project Chat",
        scheduledMessage: { targetSessionId: projectChat, sendAt: "1970-01-01T00:00:30.000Z" },
      });
      // Original reported invocation now means a valid companion self-reminder, not Project Chat.
      expect(
        yield* call("sessions.schedule", { text: "Own reminder", delaySeconds: 60 }),
      ).toMatchObject({
        ok: true,
        target: { sessionId: SESSION_ASSISTANT_ID },
        targetTitle: "Companion",
      });
      expect(
        yield* call("sessions.schedule", {
          sessionId: SESSION_ASSISTANT_ID,
          text: "Explicit self",
          delaySeconds: 60,
        }),
      ).toMatchObject({ ok: true, targetTitle: "Companion" });
      expect(f.storedSchedules()).toMatchObject([
        { targetSessionId: projectChat, createdBySessionId: SESSION_ASSISTANT_ID },
        { targetSessionId: SESSION_ASSISTANT_ID, createdBySessionId: SESSION_ASSISTANT_ID },
        { targetSessionId: SESSION_ASSISTANT_ID, createdBySessionId: SESSION_ASSISTANT_ID },
      ]);
      f.setCompanionContext(target);
      const worker = yield* Effect.forkScoped(
        scheduledMessages.runWorker.pipe(Effect.provide(f.context)) as Effect.Effect<never>,
      );
      yield* TestClock.adjust("31 seconds");
      const delivered = yield* Queue.take(f.prompts);
      expect(delivered.sessionId).toBe(projectChat);
      expect(parseScheduledMessage(delivered.text)).toMatchObject({
        text: "hello",
        origin: { createdBySessionId: SESSION_ASSISTANT_ID },
      });
      yield* Context.get(f.context, ScheduledMessages)
        .changes()
        .pipe(
          Stream.filter((s) => s.messages.length === 2),
          Stream.runHead,
        );
      yield* TestClock.adjust("30 seconds");
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(SESSION_ASSISTANT_ID);
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(SESSION_ASSISTANT_ID);
      yield* Fiber.interrupt(worker);
      expect(yield* Queue.size(f.prompts)).toBe(0);
    }),
);

it.effect(
  "companion parent requires valid context and keeps target validation and sending defaults",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const sender = {
        kind: "cake-chat" as const,
        sessionId: SESSION_ASSISTANT_ID,
        title: "Companion",
      };
      yield* scheduledMessages.initialize().pipe(Effect.provide(f.context));
      const schedule = () =>
        f.direct(
          "sessions.schedule",
          { sessionId: "parent", text: "hello", delaySeconds: 30 },
          sender,
        );
      expect(yield* schedule()).toMatchObject({
        ok: false,
        error: "Companion invoking context is unavailable",
      });
      f.setCompanionContext("parent");
      expect(yield* schedule()).toMatchObject({
        ok: false,
        error: "Companion invoking context has no valid session identity",
      });
      f.setCompanionContext(projectChatSessionId("/unregistered"));
      expect(yield* schedule()).toMatchObject({
        ok: false,
        error: "Project Chat belongs to no registered project",
      });
      f.setCompanionContext("00000000-0000-4000-8000-000000000099");
      expect(yield* schedule()).toMatchObject({ ok: false });
      expect(f.storedSchedules()).toEqual([]);
      f.setCompanionContext(target);
      expect(yield* schedule()).toMatchObject({ ok: true, target: { sessionId: target } });
      expect(
        yield* f.direct(
          "sessions.send",
          { sessionId: "parent", text: "Viewed session", resultDelivery: "ignore" },
          sender,
        ),
      ).toMatchObject({ ok: true, target: { sessionId: target } });
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(target);
      // Sends default to the same invoking parent; unrelated tools still require targets.
      expect(
        yield* f.direct(
          "sessions.send",
          { text: "Default parent", resultDelivery: "ignore" },
          sender,
        ),
      ).toMatchObject({ ok: true, target: { sessionId: target } });
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(target);
      expect(yield* f.direct("sessions.info", {}, sender).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      expect(
        yield* f.direct(
          "sessions.schedule",
          { sessionId: "current", text: "No alias", delaySeconds: 30 },
          sender,
        ),
      ).toMatchObject({ ok: false });
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect(
  "a Project Chat schedules to itself and other chats, lists, cancels and is woken by its schedule",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const projectChat = projectChatSessionId("/project");
      const chat = yield* cakeChatRuntime
        .acquireOptions({
          configuration: {
            location: { workingDirectory: "/project", sessionDirectory: "/chats/project" },
            agentDirectory: "/agent",
          },
          target: { sessionId: projectChat, tools: [] },
          newSession: false,
        })
        .pipe(Effect.provide(f.context));
      const control = chat.runtime.globalControl;
      assert.ok(control);
      const call = (name: string, input: JsonObject) =>
        Effect.promise(() => control.invoke({ name, arguments: input }, signal()));
      yield* scheduledMessages.initialize().pipe(Effect.provide(f.context));

      // Omitting sessionId targets the calling chat; a recurring check-in needs no sendAt.
      expect(
        yield* call("sessions.schedule", { text: "Check the PR status", repeatEverySeconds: 180 }),
      ).toMatchObject({
        ok: true,
        command: "sessions.schedule",
        targetTitle: "Project / Project Chat",
        scheduledMessage: { sendAt: "1970-01-01T00:03:00.000Z", repeatEverySeconds: 180 },
        status: "scheduled",
      });
      // Every chat address form resolves, including the forms that previously failed.
      for (const sessionId of [projectChat, projectChat.slice("project-chat:".length)])
        expect(
          yield* call("sessions.schedule", { sessionId, text: "hi", delaySeconds: 15 }),
        ).toMatchObject({ ok: true, targetTitle: "Project / Project Chat" });
      expect(
        yield* call("sessions.schedule", {
          sessionId: "cake-chat",
          text: "Tell Cake Chat",
          sendAt: "1970-01-01T01:00:00Z",
        }),
      ).toMatchObject({
        ok: true,
        targetTitle: "Cake Chat",
        scheduledMessage: { sendAt: "1970-01-01T01:00:00.000Z" },
      });
      // Canonical addresses are validated by the registered-project route before scheduling.
      expect(
        yield* call("sessions.schedule", {
          sessionId: projectChatSessionId("/unregistered"),
          text: "Nobody",
          delaySeconds: 15,
        }),
      ).toMatchObject({ ok: false, error: "Project Chat belongs to no registered project" });
      expect(
        yield* call("sessions.schedule", { text: "Both", delaySeconds: 1, sendAt: "2030-01-01" }),
      ).toMatchObject({ ok: false, error: "Provide sendAt or delaySeconds, not both." });
      expect(
        yield* call("sessions.schedule", { text: "Past", sendAt: "1960-01-01T00:00:00Z" }),
      ).toMatchObject({ ok: false, error: "Scheduled send time must be in the future" });

      const stored = f.storedSchedules();
      expect(stored.map((item) => item.targetSessionId)).toEqual([
        projectChat,
        projectChat,
        projectChat,
        CAKE_CHAT_SESSION_ID,
      ]);
      expect(stored.every((item) => item.createdBySessionId === projectChat)).toBe(true);
      const [first, second, recurring] = stored;
      assert.ok(first && second && recurring);
      expect(recurring).toMatchObject({ repeatEverySeconds: 180 });

      const page = yield* call("sessions.scheduled", { sessionId: projectChat });
      expect(page).toMatchObject({ ok: true, total: 3, nextOffset: null });
      expect(page).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ id: recurring.id, repeatEverySeconds: 180 }),
        ]),
      });
      expect(
        yield* call("sessions.scheduled-info", { id: recurring.id, maxChars: 5 }),
      ).toMatchObject({ ok: true, message: { text: "Check", totalChars: 19, nextOffset: 5 } });
      expect(yield* call("sessions.cancel-scheduled", { id: second.id })).toEqual({
        ok: true,
        command: "sessions.cancel-scheduled",
        id: second.id,
        target: { sessionId: projectChat },
        status: "cancelled",
      });
      expect(yield* call("sessions.cancel-scheduled", { id: second.id })).toMatchObject({
        ok: false,
      });

      // The due message wakes the Project Chat as an ordinary input carrying its origin.
      // SAFETY: the fixture context provides the worker's chat and Project Session services.
      const worker = yield* Effect.forkScoped(
        scheduledMessages.runWorker.pipe(Effect.provide(f.context)) as Effect.Effect<never>,
      );
      yield* TestClock.adjust("16 seconds");
      const woken = yield* Queue.take(f.prompts);
      expect(woken.sessionId).toBe(projectChat);
      expect(parseScheduledMessage(woken.text)).toMatchObject({
        text: "hi",
        origin: { id: first.id, createdBySessionId: projectChat },
      });
      // The fixture acknowledges Pi consumption separately from admission; await reconciliation.
      yield* Context.get(f.context, ScheduledMessages)
        .changes()
        .pipe(
          Stream.filter((snapshot) => snapshot.messages.length === 2),
          Stream.runHead,
        );
      yield* Fiber.interrupt(worker);
      expect(yield* Queue.size(f.prompts)).toBe(0);
      expect(f.storedSchedules().map((item) => item.id)).toEqual([recurring.id, stored[3]?.id]);

      yield* call("sessions.cancel-scheduled", { id: recurring.id });
      expect(yield* call("sessions.scheduled", { sessionId: projectChat })).toMatchObject({
        total: 0,
      });
      expect(f.requestCalls).toEqual([]);
    }),
);

it.effect("a Project Session schedules to itself when it omits sessionId", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* scheduledMessages.initialize().pipe(Effect.provide(f.context));
    expect(
      yield* f.call("sessions.schedule", { text: "Re-run the flaky test", delaySeconds: 60 }),
    ).toMatchObject({
      ok: true,
      scheduledMessage: { sendAt: "1970-01-01T00:01:00.000Z" },
      status: "scheduled",
    });
    expect(f.storedSchedules()).toMatchObject([
      { targetSessionId: source, createdBySessionId: source, text: "Re-run the flaky test" },
    ]);
    expect(
      yield* f.direct("sessions.schedule", {
        sessionId: projectChatSessionId("/unregistered"),
        text: "Nobody",
        delaySeconds: 15,
      }),
    ).toMatchObject({ ok: false, command: "sessions.schedule" });
    expect(f.storedSchedules()).toHaveLength(1);
    expect(f.requestCalls).toEqual([]);
  }),
);

// The backend fixture configures Cake Chat at /chat. The window either agrees (the
// supported wiring) or, defensively, resolves another working directory.
const windowChat = (workingDirectory: string) => ({
  location: { workingDirectory, sessionDirectory: "/chats" },
  agentDirectory: "/agent",
});
const cakeChatRuntimeCount = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  f.runtimeCreates.filter((id) => id === CAKE_CHAT_SESSION_ID).length;

for (const windowDirectory of ["/chat", "/home"])
  for (const order of ["window first", "agent first"] as const)
    it.effect(
      `an agent send and the open Cake Chat window share one runtime (${order}, window at ${windowDirectory})`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(true);
          const openWindow = cakeChatOperations
            .open({ sessionId: CAKE_CHAT_SESSION_ID, tools: [] }, windowChat(windowDirectory))
            .pipe(Effect.provide(f.context));
          const send = f.direct(
            "sessions.send",
            { sessionId: CAKE_CHAT_SESSION_ID, text: "Project result" },
            caller,
          );
          if (order === "window first") yield* openWindow;
          expect(yield* send).toMatchObject({ ok: true, command: "sessions.send" });
          if (order === "agent first") yield* openWindow;
          expect((yield* Queue.take(f.prompts)).sessionId).toBe(CAKE_CHAT_SESSION_ID);
          // The user's own send resolves the chat by ID, which failed on a collision.
          yield* Context.get(f.context, CakeSessionRuntimes).acquireSession(CAKE_CHAT_SESSION_ID);
          expect(cakeChatRuntimeCount(f)).toBe(1);
        }),
    );

it.effect("restart recovery resumes Cake Chat through the runtime the window opened", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* cakeChatOperations
      .open({ sessionId: CAKE_CHAT_SESSION_ID, tools: [] }, windowChat("/home"))
      .pipe(Effect.provide(f.context));
    const record: RuntimeRecoveryRecord = {
      sessionId: CAKE_CHAT_SESSION_ID,
      workingDirectory: "/chat",
      sessionDirectory: "/chats",
      profile: "CakeChatSession",
      transcriptPersisted: true,
      state: "active",
      inputs: [
        {
          turnId: "interrupted",
          text: "Interrupted request",
          delivery: "prompt",
          attachments: [],
          markdown: false,
        },
      ],
    };
    const recoveryContext = yield* Layer.build(makeRuntimeRecoveryStorageTestLayer([record]));
    const context = Context.merge(f.context, recoveryContext);
    yield* runtimeRecovery.initialize().pipe(Effect.provide(context));
    expect(
      (yield* Context.get(recoveryContext, RuntimeRecoveryStorage).get(CAKE_CHAT_SESSION_ID))
        ?.state,
    ).toBe("active");
    expect(cakeChatRuntimeCount(f)).toBe(1);
  }),
);

it.effect(
  "an exact non-family reply settles only its persisted obligation and retains response provenance instead of creating a second generic notice",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const sent = yield* f.call("sessions.send", {
        sessionId: target,
        text: "Investigate the merge responsiveness issue",
        resultDelivery: "notification",
      });
      const request = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ messageId: Schema.String, threadId: Schema.String }),
      )(sent);
      const storage = Context.get(f.context, SessionFamilyStorage);
      const recorded = (yield* storage.state()).turns.find(
        (turn) => turn.requestMessageId === request.messageId,
      );
      assert.ok(recorded);
      const turnId = recorded.turnId;
      const replyOptions = yield* acquireOptions({
        location,
        sessionId: target,
        newSession: false,
      }).pipe(Effect.provide(f.context));
      yield* Context.get(f.context, CakeSessionRuntimes).acquire(replyOptions);
      yield* storage.recordTurn({
        sessionId: target,
        senderSessionId: source,
        turnId: "other-turn",
        requestMessageId: "other-request",
        threadId: "other-thread",
        reported: false,
        resultDelivery: "notification",
      });
      const ref = messageReference(target, "46866");
      yield* f.direct(
        "sessions.reply",
        {
          threadId: request.threadId,
          resultDelivery: "ignore",
          text: `The task session sent a response. Open the Project Session to read it.\n\n[Full original](${ref})`,
        },
        { ...caller, sessionId: target, sourceEntryId: "46866" },
      );
      const state = yield* storage.state();
      expect(state.turns.map((turn) => turn.turnId)).toEqual(["other-turn"]);
      expect(state.deferredReferences).toMatchObject([
        { responseKey: turnId, resultMessageRef: ref },
      ]);
      expect(state.deferredReferences).toHaveLength(1);
    }).pipe(Effect.scoped),
);

for (const state of ["active", "blocked", "stopped"] as const) {
  it.effect(
    `restart recovery preserves ${state} input when the committed transcript is missing or colliding`,
    () =>
      Effect.gen(function* () {
        for (const collision of [false, true]) {
          const f = yield* fixture();
          const record: RuntimeRecoveryRecord = {
            sessionId: target,
            workingDirectory: "/project",
            sessionDirectory: "/cake/sessions",
            profile: "ProjectSession",
            transcriptPersisted: true,
            state,
            inputs: [
              {
                turnId: "retained-input",
                text: "Do not replay missing history",
                delivery: "prompt",
                attachments: [],
                markdown: false,
              },
            ],
          };
          const recovery = yield* Layer.build(makeRuntimeRecoveryStorageTestLayer([record]));
          const sessions = Context.get(f.context, CakeSessionRuntimes);
          const context = Context.merge(f.context, recovery).pipe(
            Context.add(CakeSessionRuntimes, {
              ...sessions,
              catalogEntry: () => Effect.die("Recovery must not read titles"),
              hasTranscript: () =>
                collision
                  ? Effect.fail(
                      new PiSessionError({
                        operation: "hasTranscript",
                        message: "Session ID collision detected",
                      }),
                    )
                  : Effect.succeed(false),
            }),
          );
          yield* runtimeRecovery.initialize().pipe(Effect.provide(context));
          const retained = yield* Context.get(recovery, RuntimeRecoveryStorage).get(target);
          expect(retained).toMatchObject({
            state: state === "stopped" ? "stopped" : "blocked",
            inputs: record.inputs,
          });
          expect(retained?.issue).toMatch(
            collision ? /collision/ : /saved Pi transcript is missing/,
          );
          expect(f.runtimeCreates).not.toContain(target);
          expect(f.listReads.entries).toEqual([]);
        }
      }),
  );
}

it.effect(
  "restart recovery admits crash-before-transcript input exactly once without a catalog title",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const record: RuntimeRecoveryRecord = {
        sessionId: target,
        workingDirectory: "/project",
        sessionDirectory: "/cake/sessions",
        profile: "ProjectSession",
        transcriptPersisted: false,
        state: "active",
        inputs: [
          {
            turnId: "crash-input",
            text: "Retain the accepted task",
            delivery: "prompt",
            attachments: [],
            markdown: false,
          },
        ],
      };
      yield* Context.get(f.context, RuntimeRecoveryStorage).update(record);
      const sessions = Context.get(f.context, CakeSessionRuntimes);
      const context = f.context.pipe(
        Context.add(CakeSessionRuntimes, {
          ...sessions,
          catalogEntry: () => Effect.die("Recovery must not read titles"),
          hasTranscript: () => Effect.succeed(false),
        }),
      );
      yield* runtimeRecovery.initialize().pipe(Effect.provide(context));
      yield* runtimeRecovery.initialize().pipe(Effect.provide(context));
      expect((yield* Queue.take(f.prompts)).sessionId).toBe(target);
      expect(f.runtimeCreates.filter((id) => id === target)).toHaveLength(1);
      expect(f.listReads.entries).toEqual([]);
    }),
);

it.effect(
  "cancelling recovery discovery preserves committed input instead of marking it blocked",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const storage = Context.get(f.context, RuntimeRecoveryStorage);
      const record: RuntimeRecoveryRecord = {
        sessionId: target,
        workingDirectory: "/project",
        sessionDirectory: "/cake/sessions",
        profile: "ProjectSession",
        transcriptPersisted: true,
        state: "active",
        inputs: [
          {
            turnId: "interrupted-check",
            text: "Keep this input",
            delivery: "prompt",
            attachments: [],
            markdown: false,
          },
        ],
      };
      yield* storage.update(record);
      const entered = yield* Deferred.make<void>();
      let cancelled = false;
      const sessions = Context.get(f.context, CakeSessionRuntimes);
      const context = f.context.pipe(
        Context.add(CakeSessionRuntimes, {
          ...sessions,
          hasTranscript: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelled = true;
                }),
              ),
            ),
        }),
      );
      const pending = yield* runtimeRecovery
        .initialize()
        .pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(pending);
      expect(cancelled).toBe(true);
      expect(yield* storage.get(target)).toEqual(record);
      expect(f.runtimeCreates).not.toContain(target);
    }),
);
