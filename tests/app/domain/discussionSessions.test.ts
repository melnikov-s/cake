import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { SubagentCoordinator } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../../src/services/subagents/SubagentEnvironment";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { AgentControlTestLive } from "../helpers/agentControlTestLayer";
import { toJsonValue } from "../../../src/utils/to-json-value";
import { makeRuntimeRecoveryStorageTestLayer } from "../helpers/piRuntimeFixture";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import assert from "node:assert/strict";
import { AttachmentUploadError } from "../../../src/contracts/filesystem/attachment-uploads-errors";
import { DurableChatError } from "../../../src/services/pi-durable/durable-chat-data";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Logger, Queue, Scope, Stream, Schema } from "effect";
import { DiscussionTitleRequests } from "../../../src/services/discussion-sessions/DiscussionTitleRequests";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { describe, expect } from "vitest";
import * as discussionSessions from "../../../src/domain/discussion-sessions/discussionSessions";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import * as messageReferences from "../../../src/domain/conversations/messageReferences";
import { describeMessageReferences } from "../../../src/domain/conversations/messageReferenceForwarding";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import * as agentControl from "../../../src/domain/application/agentControl";
import {
  makeDiscussionSessionEnvironmentLayer,
  type DiscussionSessionRecord,
} from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import {
  makeCakeSessionRuntimesLayer,
  PiSessionError,
  type CakeSessionRuntimesAdapter,
  type CakeSessionRuntimeSetup,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { CakeSessionRuntime } from "../../../src/services/pi/runtime/cake-session-runtime";
import {
  SideChatHistoryBusy,
  type SideChatHistoryMessage,
} from "../../../src/services/pi/side-chat-history";
import { makeProjectSessionRuntimeTestLayer } from "./projectSessionRuntimeTestLayer";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { CakeChatDurable } from "../../../src/services/pi-durable/CakeChatDurable";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { acquireOptions as acquireChatOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { listAppControlTools } from "../../../src/renderer/app-control/AppControlBridge";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";

const makeSnapshot = (sessionId: string, sessionFile: string): ConversationSnapshot => ({
  workspacePath: "/project",
  sessionId,
  sessionFile,
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

const anchor = {
  path: "src/app.ts",
  view: "file" as const,
  start: { diffLine: 1, newLine: 4 },
  end: { diffLine: 1, newLine: 4 },
  selectedText: "value",
  contextBefore: "const ",
  contextAfter: " = 1",
  diff: "+value",
};

const cakeChatAnchor = {
  path: `session:${CAKE_CHAT_SESSION_ID}/message/assistant-2`,
  view: "message" as const,
  start: { diffLine: 0 },
  end: { diffLine: 0 },
  selectedText: "",
  contextBefore: "",
  contextAfter: "",
  diff: "",
  messageId: "assistant-2",
  entryId: "entry-assistant-2",
};

const attachmentReference = {
  kind: "input" as const,
  id: "10000000-0000-4000-8000-000000000001",
  name: "Notes",
  mimeType: "text/plain",
  byteLength: 17,
};

const makeLayer = (
  options: {
    readonly inspectSession?: CakeSessionRuntime["inspectSession"];
    readonly investigator?: boolean;
    readonly persistedSidecar?: boolean;
    readonly queuedUser?: boolean;
    readonly cakeChat?: boolean;
    /** Cake Chat forks natively into this Durable conversation instead of refusing. */
    readonly durableFork?: number;
    readonly forkFailure?: string;
    readonly forkSessionId?: string;
    readonly backendControl?: boolean;
    readonly mergeBusy?: "parent" | "source" | "both";
    readonly mergeCheck?: Deferred.Deferred<void>;
    readonly mergeQueued?: "parent" | "source";
    readonly mergeReferences?: readonly string[];
    readonly mergeFailure?: boolean;
    readonly lateImportDialogue?: boolean;
    readonly mergeGate?: { entered: Deferred.Deferred<void>; complete: Deferred.Deferred<void> };
    readonly activityGate?: { entered: Deferred.Deferred<void>; complete: Deferred.Deferred<void> };
  } = {},
) => {
  const durableFork = options.durableFork;
  const forkedEntries: string[] = [];
  const isolatedInputs: unknown[] = [];
  const importedHistories: unknown[] = [];
  const grantedInputs: unknown[] = [];
  const mergeOptions = options;
  const busyChats = new Set(
    options.mergeBusy === "both"
      ? ["parent", "source"]
      : options.mergeBusy
        ? [options.mergeBusy]
        : [],
  );
  const queuedChats = new Set(options.mergeQueued ? [options.mergeQueued] : []);
  const historyMessages: SideChatHistoryMessage[] = [
    {
      sourceEntryId: "side-user-1",
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: "Which deployment option should we use?" }],
      attachments: (options.mergeReferences ?? []).map((id) => ({
        kind: "input",
        id,
        name: "notes.txt",
        mimeType: "text/plain",
        byteLength: 10,
      })),
      markdown: false,
    },
    {
      sourceEntryId: "side-assistant-1",
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "The simpler deployment fits this project." }],
      attachments: [],
      markdown: true,
    },
  ];
  let record: DiscussionSessionRecord = {
    id: "thread-1",
    workingDirectory: options.cakeChat ? "/home" : "/project",
    parentSessionId: options.cakeChat ? CAKE_CHAT_SESSION_ID : "parent-1",
    ...(options.persistedSidecar
      ? {
          sidecarSessionId: options.cakeChat ? cakeChatSideChatSessionId(7) : "persisted-sidecar",
          ...(options.cakeChat
            ? {}
            : { sidecarSessionFile: "/cake/reviews/thread-1/persisted-sidecar.jsonl" }),
        }
      : {}),
    pendingParts: [
      {
        id: "pending-question",
        kind: "text",
        role: "user",
        text: "Why is this exported?",
        status: "complete",
        deliveryState: "sending",
      },
    ],
    anchor: options.cakeChat ? cakeChatAnchor : anchor,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const runtimeOptions: CakeSessionRuntimeSetup[] = [];
  const modelSelections: Array<{ provider: string; modelId: string }> = [];
  const controlInvocations: unknown[] = [];
  const forwardedInputs: unknown[] = [];
  const rendererBindings: Array<{ sessionId: string; connectionId: number; prompts: number }> = [];
  const interviewRequests: unknown[] = [];
  const prompts: Parameters<CakeSessionRuntime["prompt"]>[] = [];
  const queueOperations: string[] = [];
  let preparedContexts = 0;
  let parentIndexRefreshes = 0;
  let inspections = 0;
  let lateImportDialogue = options.lateImportDialogue;
  const createdRecords: Array<{ workingDirectory: string; parentSessionId: string }> = [];
  const linkedSidecars: string[] = [];
  const runtime = (options: CakeSessionRuntimeSetup): CakeSessionRuntime => {
    const sessionId = options.sessionId ?? "generated";
    let answered = false;
    const sessionFile = options.directSessionDir
      ? `${options.sessionDir}/${sessionId}.jsonl`
      : `/sessions/${sessionId}.jsonl`;
    return {
      sessionId,
      sessionFile,
      get streaming() {
        return busyChats.has(sessionId === CAKE_CHAT_SESSION_ID ? "parent" : "source");
      },
      exportSideChatHistory: async () => ({
        sourceSessionId: sessionId,
        inputReferenceIds: [...(mergeOptions.mergeReferences ?? [])],
        messages: historyMessages,
      }),
      importSideChatHistory: async (history) => {
        if (lateImportDialogue) {
          lateImportDialogue = false;
          historyMessages.push({ ...historyMessages[1]!, sourceEntryId: "during-import" });
          options.onEvent({ type: "streaming", sessionId, streaming: false });
          throw new SideChatHistoryBusy({ message: "Source changed during import" });
        }
        if (mergeOptions.mergeGate) {
          await Effect.runPromise(Deferred.succeed(mergeOptions.mergeGate.entered, undefined));
          await Effect.runPromise(Deferred.await(mergeOptions.mergeGate.complete));
        }
        if (mergeOptions.mergeFailure) throw new Error("Import failed");
        importedHistories.push(history);
        return { importedMessages: 2 };
      },
      getReviewParentContext: options.directSessionDir
        ? undefined
        : () => ({
            sessionId,
            sessionFile,
            leafId: "leaf-1",
          }),
      snapshot: async () => ({
        ...makeSnapshot(sessionId, sessionFile),
        ...(mergeOptions.investigator
          ? {
              model: { provider: "test", id: "model", name: "Model" },
              models: [
                {
                  provider: "test",
                  providerName: "Test",
                  id: "model",
                  name: "Model",
                  reasoning: false,
                  availableThinkingLevels: ["off"],
                  fastMode: false,
                  input: ["text"],
                  authenticated: true,
                  available: true,
                  authTypes: [],
                },
              ],
              parts:
                answered && options.auxiliary
                  ? [
                      {
                        id: "original-answer",
                        entryId: "original-answer",
                        kind: "text",
                        role: "assistant",
                        text: "Read-only findings with cake://session/source?message=exact",
                        status: "complete",
                      },
                    ]
                  : [],
            }
          : {}),
        ...(mergeOptions.queuedUser && sessionId === CAKE_CHAT_SESSION_ID
          ? {
              parts: [
                {
                  id: "queued-user",
                  kind: "text" as const,
                  role: "user" as const,
                  status: "complete" as const,
                  deliveryState: "queued" as const,
                  text: "Waiting",
                  queuedInput: {
                    itemId: "user",
                    turnId: "user",
                    text: "Waiting",
                    renderUserMessageAsMarkdown: true,
                    attachments: [attachmentReference],
                  },
                },
              ],
            }
          : {}),
        streaming: busyChats.has(sessionId === CAKE_CHAT_SESSION_ID ? "parent" : "source"),
      }),
      listQueuedMessages: async () => ({ steering: [], followUp: [] }),
      pendingMessages: async () => {
        if (mergeOptions.mergeCheck)
          await Effect.runPromise(Deferred.succeed(mergeOptions.mergeCheck, undefined));
        return {
          items: queuedChats.has(sessionId === CAKE_CHAT_SESSION_ID ? "parent" : "source")
            ? [
                {
                  itemId: "00000000-0000-4000-8000-000000000001",
                  lane: "follow-up",
                  position: 1,
                  state: "queued",
                  text: "Continue discussing",
                },
              ]
            : [],
        };
      },
      reorderPendingMessage: async () => ({ items: [] }),
      clearQueue: async () => ({ steering: [], followUp: [] }),
      cancelSteering: async () => {
        queueOperations.push(`${sessionId}:cancelSteering`);
        return { steering: [], followUp: [] };
      },
      updateQueuedMessage: async () => ({ steering: [], followUp: [] }),
      removeQueuedMessage: async (partId) => {
        queueOperations.push(`${sessionId}:remove:${partId}`);
        return { steering: [], followUp: [] };
      },
      steerQueuedMessage: async (partId) => {
        queueOperations.push(`${sessionId}:steer:${partId}`);
        return { steering: [], followUp: [] };
      },
      sendQueuedMessageNow: async () => ({
        queued: { steering: [], followUp: [] },
        abortedTurnIds: [],
      }),
      prompt: async (...input) => {
        prompts.push(input);
        if (mergeOptions.activityGate) {
          await Effect.runPromise(Deferred.succeed(mergeOptions.activityGate.entered, undefined));
          await Effect.runPromise(Deferred.await(mergeOptions.activityGate.complete));
          const turnId = input[4];
          if (turnId)
            options.onTurnResult?.(turnId, {
              stopReason: "stop",
              text: "Implemented the agreed small fix.",
              entryId: "task-answer",
              respondsToSessionId: parseCrossSessionMessage(input[0])?.metadata.sender.sessionId,
            });
        }
        answered = true;
        options.onEvent({ type: "streaming", sessionId, streaming: false });
      },
      setUserMessageMarkdown: async () => undefined,
      queueCommand: async () => {
        throw new Error("Unexpected queueCommand");
      },
      inspectSession:
        mergeOptions.inspectSession ??
        (async () => {
          throw new Error("Unexpected inspectSession");
        }),
      compact: async () => undefined,
      abort: async () => {
        queueOperations.push(`${sessionId}:abort`);
      },
      setModel: async (provider, modelId) => {
        modelSelections.push({ provider, modelId });
      },
      setThinkingLevel: async () => undefined,
      applyConfiguration: async () => undefined,
      setPiSetting: async () => undefined,
      recordReviewRun: () => undefined,
      rename: async () => undefined,
      fork: async (entryId) => {
        if (sessionId !== CAKE_CHAT_SESSION_ID)
          return { sessionId: "fork", sessionFile: "/fork.jsonl", artifactPointers: [] };
        forkedEntries.push(entryId);
        if (entryId !== cakeChatAnchor.entryId)
          throw new Error("That Cake Chat message is no longer available");
        if (mergeOptions.forkFailure) throw new Error(mergeOptions.forkFailure);
        if (durableFork === undefined && mergeOptions.forkSessionId === undefined)
          throw new Error("Durable fork is unavailable");
        return {
          sessionId: mergeOptions.forkSessionId ?? cakeChatSideChatSessionId(durableFork ?? 7),
          sessionFile: "/cake/cake-chat/coordinator.sqlite",
          artifactPointers: [],
        };
      },
      toolCompact: async () => ({ sessionId: "toolCompact", sessionFile: "/toolCompact.jsonl" }),
      navigate: async () => undefined,
      dispose: () => undefined,
    };
  };
  const adapter: CakeSessionRuntimesAdapter = {
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: (_query, id) =>
      Effect.succeed(
        options.backendControl
          ? {
              id,
              title: "Parent authority",
              created: "2026-01-01",
              modified: "2026-01-01",
              messageCount: 1,
              resolved: false,
            }
          : undefined,
      ),
    inspect: () =>
      Effect.sync(() => {
        inspections++;
        return undefined;
      }),
    createRuntime: (options) =>
      Effect.sync(() => {
        runtimeOptions.push(options);
        return runtime(options);
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
  const discussions = makeDiscussionSessionEnvironmentLayer({
    list: () => Effect.succeed([record]),
    get: () => Effect.succeed(record),
    create: (workingDirectory, parentSessionId) =>
      Effect.sync(() => {
        createdRecords.push({ workingDirectory, parentSessionId });
        return record;
      }),
    ensure: () => Effect.succeed(record),
    linkSidecar: (current, sidecar) =>
      Effect.sync(() => {
        linkedSidecars.push(sidecar.sessionId);
        record = { ...current, sidecarSessionId: sidecar.sessionId };
        if (sidecar.sessionFile !== undefined)
          record = { ...record, sidecarSessionFile: sidecar.sessionFile };
        return record;
      }),
    setResolved: (current, resolved) =>
      Effect.sync(() => {
        record = { ...current, status: resolved ? "resolved" : "open" };
        return record;
      }),
    location: () =>
      Effect.succeed({
        agentDirectory: "/cake",
        sessionDirectory: "/cake/reviews/thread-1",
        parentSessionDirectory: "/cake/sessions",
      }),
    sidecarSystemPrompt: () =>
      Effect.succeed("Read the bounded parent projection at /cake/reviews/context/parent.md"),
    prepareParentContext: () =>
      Effect.sync(() => {
        preparedContexts += 1;
      }),
    refreshParentIndex: () =>
      Effect.sync(() => {
        parentIndexRefreshes += 1;
      }),
  });
  const projectRuntime = makeProjectSessionRuntimeTestLayer();
  let applicationState: ReturnType<ApplicationState["Service"]["snapshot"]> = {
    ...defaultApplicationState(),
    utilityModel: { provider: "google", modelId: "gemini-3.5-flash-lite", thinkingLevel: "low" },
    projects: [
      {
        path: "/project",
        name: "Project",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  return {
    layer: Layer.mergeAll(
      Layer.mock(CakeChatDurable, {
        inspectSideChatMessages: (_directory, _sessionId, query) =>
          mergeOptions.inspectSession
            ? Effect.promise(() =>
                mergeOptions.inspectSession
                  ? mergeOptions.inspectSession(query)
                  : Promise.reject(new Error("Unexpected message inspection")),
              )
            : Effect.die("Unexpected message inspection"),
      }),
      AgentControlTestLive,
      DiscussionTitleRequests.layer,
      SessionCatalogChanges.layer,
      Layer.succeed(CakeChatConfiguration, {
        location: { workingDirectory: "/home", sessionDirectory: "/cake/cake-chat" },
        agentDirectory: "/cake",
      }),
      makeSubagentStorageTestLayer(),
      makeCakeSessionRuntimesLayer(adapter).pipe(
        Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
      ),
      discussions,
      projectRuntime,
      Layer.mock(TaskInputStorage, {
        resolve: (_session, attachments) => Effect.succeed(attachments),
        authorizeForward: () => Effect.succeed([]),
        isRecipient: () => Effect.succeed(false),
        isolate: (sessionId, attachments) =>
          Effect.sync(() => {
            isolatedInputs.push({ sessionId, attachments });
            return [attachmentReference];
          }),
      }),
      familyStorageHarness().layer,
      ...(options.mergeReferences
        ? [
            Layer.mock(TaskInputStorage, {
              authorizeForward: (owner, refs, recipient) =>
                Effect.sync(() => {
                  forwardedInputs.push({ owner, refs, recipient });
                  return refs.map((ref) => `grant:${ref}`);
                }),
              grant: (recipient, refs) =>
                Effect.sync(() => {
                  grantedInputs.push({ recipient, refs });
                  return [];
                }),
            }),
          ]
        : []),
      ...(options.backendControl
        ? [
            familyStorageHarness().layer,
            Layer.mock(ManagedWorktrees, {
              records: () => Effect.succeed([]),
              awaitSetup: () => Effect.void,
            }),
            Layer.mock(TaskInputStorage, {
              isRecipient: () => Effect.succeed(false),
              authorizeForward: (owner, refs, recipient) =>
                Effect.sync(() => {
                  forwardedInputs.push({ owner, refs, recipient });
                  return refs;
                }),
              resolve: (_session, attachments) => Effect.succeed(attachments),
            }),
          ]
        : []),
      Layer.mock(RendererRequestCoordinator, {
        bind: (target, connectionId) =>
          Effect.sync(() => {
            rendererBindings.push({
              sessionId: target.sessionId,
              connectionId,
              prompts: prompts.length,
            });
          }),
        requestInterview: (sessionId, record) =>
          Effect.sync(() => {
            interviewRequests.push({ sessionId, record });
            return { answer: true };
          }),
        presentAgentAction: () => Effect.void,
        requestProjectControl: (sessionId, invocation) =>
          Effect.sync(() => {
            controlInvocations.push({ sessionId, invocation });
            return { ok: true };
          }),
      }),
      Layer.mock(ApplicationState, {
        snapshot: () => applicationState,
        current: () => Effect.succeed(applicationState),
        transact: (transition) =>
          transition(applicationState).pipe(
            Effect.tap((next) =>
              Effect.sync(() => {
                applicationState = next;
              }),
            ),
          ),
      }),
    ),
    options: runtimeOptions,
    inspections: () => inspections,
    prompts,
    queueOperations,
    preparedContexts: () => preparedContexts,
    parentIndexRefreshes: () => parentIndexRefreshes,
    createdRecords,
    linkedSidecars,
    forkedEntries,
    isolatedInputs,
    importedHistories,
    historyMessages,
    settleChat: (chat: "parent" | "source") => {
      busyChats.delete(chat);
      queuedChats.delete(chat);
      const sessionId = chat === "parent" ? CAKE_CHAT_SESSION_ID : cakeChatSideChatSessionId(7);
      runtimeOptions
        .find((options) => options.sessionId === sessionId)
        ?.onEvent({ type: "streaming", sessionId, streaming: false });
    },
    grantedInputs,
    modelSelections,
    controlInvocations,
    forwardedInputs,
    rendererBindings,
    interviewRequests,
    record: () => record,
  };
};

/** Assembles the permanent Cake Chat runtime, as an open Cake Chat window does. */
const assembleCakeChat = Effect.gen(function* () {
  const sessions = yield* CakeSessionRuntimes;
  const scope = yield* Scope.make();
  yield* sessions
    .acquire({
      profile: { _tag: "CakeChatSession" },
      runtime: {
        cwd: "/home",
        agentDir: "/cake",
        sessionDir: "/cake/cake-chat",
        newSession: false,
        sessionId: CAKE_CHAT_SESSION_ID,
        requestUi: async () => undefined,
        globalControl: { tools: [], invoke: async () => ({ ok: true }) },
      },
    })
    .pipe(Scope.provide(scope));
  return scope;
});

describe("Cake Chat side-chat merge", () => {
  const target = {
    workingDirectory: "/home",
    parentSessionId: CAKE_CHAT_SESSION_ID,
    threadId: "thread-1",
  };

  it.effect("imports to the parent without prompting and resolves the preserved source", () => {
    const fixture = makeLayer({ cakeChat: true, persistedSidecar: true });
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      const result = yield* discussionSessions.merge(target);
      assert.deepEqual(result, { importedMessages: 2 });
      assert.deepEqual(fixture.importedHistories, [
        {
          sourceSessionId: cakeChatSideChatSessionId(7),
          inputReferenceIds: [],
          messages: fixture.historyMessages,
          threadId: "thread-1",
          title: "Side chat",
        },
      ]);
      assert.deepEqual(fixture.prompts, []);
      assert.equal(fixture.record().status, "resolved");
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });

  for (const activity of ["parent", "source", "both", "queued-parent", "queued-source"] as const) {
    it.effect(
      `queues merging during ${activity} activity without interrupting or losing late dialogue`,
      () =>
        Effect.gen(function* () {
          const mergeCheck = yield* Deferred.make<void>();
          const fixture = makeLayer({
            cakeChat: true,
            persistedSidecar: true,
            mergeCheck,
            ...(activity === "queued-parent"
              ? { mergeQueued: "parent" as const }
              : activity === "queued-source"
                ? { mergeQueued: "source" as const }
                : { mergeBusy: activity }),
          });
          yield* Effect.gen(function* () {
            yield* assembleCakeChat;
            const merging = yield* discussionSessions.merge(target).pipe(Effect.forkChild);
            yield* Deferred.await(mergeCheck);
            assert.deepEqual(fixture.importedHistories, []);
            assert.equal(fixture.record().status, "open");
            fixture.historyMessages.push({
              ...fixture.historyMessages[1]!,
              sourceEntryId: "late-answer",
            });
            fixture.settleChat("parent");
            fixture.settleChat("source");
            yield* Fiber.join(merging);
            assert.equal(fixture.importedHistories.length, 1);
            assert.deepEqual(fixture.importedHistories[0], {
              sourceSessionId: cakeChatSideChatSessionId(7),
              inputReferenceIds: [],
              messages: fixture.historyMessages,
              threadId: "thread-1",
              title: "Side chat",
            });
            assert.deepEqual(fixture.prompts, []);
            assert.deepEqual(fixture.queueOperations, []);
            assert.equal(fixture.record().status, "resolved");
          }).pipe(Effect.provide(fixture.layer), Effect.scoped);
        }),
    );
  }

  it.effect("cancels a queued merge without resolving or consuming dialogue", () =>
    Effect.gen(function* () {
      const mergeCheck = yield* Deferred.make<void>();
      const fixture = makeLayer({
        cakeChat: true,
        persistedSidecar: true,
        mergeBusy: "source",
        mergeCheck,
      });
      yield* Effect.gen(function* () {
        yield* assembleCakeChat;
        const merging = yield* discussionSessions.merge(target).pipe(Effect.forkChild);
        yield* Deferred.await(mergeCheck);
        yield* Fiber.interrupt(merging);
        fixture.settleChat("source");
        assert.equal(fixture.record().status, "open");
        assert.equal(fixture.importedHistories.length, 0);
        assert.equal(fixture.historyMessages.length, 2);
        yield* discussionSessions.merge(target);
        assert.equal(fixture.importedHistories.length, 1);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    }),
  );

  it.effect("retries a safe-boundary race using buffered activity and fresh dialogue", () => {
    const fixture = makeLayer({ cakeChat: true, persistedSidecar: true, lateImportDialogue: true });
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      yield* discussionSessions.merge(target);
      assert.equal(fixture.importedHistories.length, 1);
      assert.equal(fixture.historyMessages.at(-1)?.sourceEntryId, "during-import");
      assert.deepEqual(fixture.prompts, []);
      assert.equal(fixture.record().status, "resolved");
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });

  it.effect("grants retained attachments to the actual parent before importing", () => {
    const mergeReferences = Array.from(
      { length: 21 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const fixture = makeLayer({ cakeChat: true, persistedSidecar: true, mergeReferences });
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      yield* discussionSessions.merge(target);
      assert.deepEqual(fixture.forwardedInputs, [
        {
          owner: cakeChatSideChatSessionId(7),
          refs: mergeReferences.slice(0, 20),
          recipient: CAKE_CHAT_SESSION_ID,
        },
        {
          owner: cakeChatSideChatSessionId(7),
          refs: mergeReferences.slice(20),
          recipient: CAKE_CHAT_SESSION_ID,
        },
      ]);
      assert.deepEqual(fixture.grantedInputs, [
        {
          recipient: CAKE_CHAT_SESSION_ID,
          refs: mergeReferences.slice(0, 20).map((ref) => `grant:${ref}`),
        },
        { recipient: CAKE_CHAT_SESSION_ID, refs: [`grant:${mergeReferences[20]}`] },
      ]);
      assert.equal(fixture.importedHistories.length, 1);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });

  it.effect("does not resolve while the dialogue import is pending", () =>
    Effect.gen(function* () {
      const mergeGate = {
        entered: yield* Deferred.make<void>(),
        complete: yield* Deferred.make<void>(),
      };
      const fixture = makeLayer({ cakeChat: true, persistedSidecar: true, mergeGate });
      yield* Effect.gen(function* () {
        yield* assembleCakeChat;
        const merge = yield* discussionSessions.merge(target).pipe(Effect.forkChild);
        yield* Deferred.await(mergeGate.entered);
        assert.equal(fixture.record().status, "open");
        yield* Deferred.succeed(mergeGate.complete, undefined);
        yield* Fiber.join(merge);
        assert.equal(fixture.record().status, "resolved");
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    }),
  );

  it.effect("surfaces import failures without resolving or prompting", () => {
    const fixture = makeLayer({ cakeChat: true, persistedSidecar: true, mergeFailure: true });
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      const error = yield* discussionSessions.merge(target).pipe(Effect.flip);
      assert.match(error.message, /Import failed/);
      assert.deepEqual(fixture.importedHistories, []);
      assert.deepEqual(fixture.prompts, []);
      assert.equal(fixture.record().status, "open");
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });

  it.effect("does not merge coding-session discussions or unstarted side chats", () => {
    const fixture = makeLayer({ cakeChat: true });
    return Effect.gen(function* () {
      const coding = yield* discussionSessions
        .merge({ ...target, parentSessionId: "parent-1" })
        .pipe(Effect.flip);
      assert.match(coding.message, /Only Project Chat and Cake Chat/);
      const unstarted = yield* discussionSessions.merge(target).pipe(Effect.flip);
      assert.match(unstarted.message, /no conversation/);
      assert.deepEqual(fixture.importedHistories, []);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
});

describe("native Side Chat control routing", () => {
  it.effect(
    "reads saved Side Chat originals and forwarding metadata without assembling or resuming a runtime",
    () => {
      const sessionId = cakeChatSideChatSessionId(7);
      const ref = messageReference(sessionId, "42");
      const message = {
        ref,
        link: ref,
        sessionId,
        entryId: "42",
        parentId: null,
        timestamp: "2026-01-01",
        role: "assistant",
        active: true,
        inputRefs: [],
        hasImages: false,
      };
      const queries: string[] = [];
      const fixture = makeLayer({
        cakeChat: true,
        persistedSidecar: true,
        inspectSession: async (query) => {
          queries.push(query.kind);
          return toJsonValue(
            query.kind === "messages-list"
              ? {
                  sessionId,
                  branch: "all",
                  messages: [message],
                  total: 1,
                  offset: 0,
                  nextOffset: null,
                }
              : {
                  message,
                  text: "Exact original report",
                  totalChars: 21,
                  offset: 0,
                  nextOffset: null,
                  truncated: false,
                },
          );
        },
      });
      return Effect.gen(function* () {
        // No sidecar or permanent-chat runtime has been assembled in this process yet.
        const original = yield* messageReferences.read({ ref });
        expect(original.text).toBe("Exact original report");
        const forwarded = yield* describeMessageReferences([ref]);
        expect(forwarded).toEqual([message]);
        expect(queries).toEqual(["messages-read", "messages-list"]);
        expect(fixture.options).toEqual([]);
        expect(fixture.createdRecords).toEqual([]);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );

  it.effect("stops a running native fork without Project Session lookup or a renderer", () => {
    const fixture = makeLayer({ cakeChat: true, persistedSidecar: true, mergeBusy: "source" });
    const sessionId = cakeChatSideChatSessionId(7);
    return Effect.gen(function* () {
      const result = yield* agentControl.invoke(
        "sessions.abort",
        { sessionId, reason: "Preserve recovered work" },
        { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      );
      expect(result).toMatchObject({ ok: true, status: "stopping", target: { sessionId } });
      expect(fixture.queueOperations).toContain(`${sessionId}:abort`);
      expect(fixture.record().status).toBe("open");
      expect(fixture.createdRecords).toEqual([]);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
});

describe("agent-owned context-fork tool boundary", () => {
  it.effect.each([CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")])(
    "routes the actual %s tool to a retained subagent and quiet completion without any Discussion presentation",
    (sessionId) =>
      Effect.gen(function* () {
        const fixture = makeLayer({ cakeChat: true, investigator: true });
        const seeds: string[] = [];
        yield* Effect.gen(function* () {
          const options = yield* acquireChatOptions({
            configuration: {
              location: {
                workingDirectory: sessionId === CAKE_CHAT_SESSION_ID ? "/home" : "/project",
                sessionDirectory: "/cake/chat",
              },
              agentDirectory: "/cake",
            },
            target: { sessionId, tools: listAppControlTools() },
            newSession: false,
          });
          const registry = new CakeOperationRegistry(
            createGlobalControlOperations(options.runtime.globalControl!, () => {
              throw new Error("Context forks inherit the current model");
            }),
          );
          const result = yield* Effect.promise(() =>
            registry.invoke(
              {
                command: "sessions.fork",
                input: {
                  workspacePath: "/project",
                  worktreeName: "investigate",
                  name: "Investigation",
                  initialPrompt: "Unfinished exchange specifics",
                },
              },
              { signal: new AbortController().signal, toolCallId: "actual-fork", runtime: {} },
            ),
          );
          const receipt = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.Struct({
                handleId: SubagentHandleId,
                ref: Schema.String,
                status: Schema.Literal("started"),
                sourceSessionId: Schema.String,
              }),
            }),
          )(result.details);
          expect(receipt.result.sourceSessionId).toBe(sessionId);
          expect(receipt.result.ref).toContain("cake://subagent/");
          const coordinator = yield* SubagentCoordinator;
          while (
            (yield* coordinator.storage.get(receipt.result.handleId))?.completionDisposition !==
            "notified"
          )
            yield* Effect.yieldNow;
          const saved = yield* coordinator.storage.get(receipt.result.handleId);
          expect(saved).toMatchObject({
            parentSessionId: sessionId,
            parentProfile: "CakeChatSession",
            anchorPartId: "tool-actual-fork",
            status: "complete",
            allowMutations: false,
          });
          expect(seeds).toEqual([saved?.privateSessionId]);
          expect(
            fixture.options.find((runtime) => runtime.sessionId === saved?.privateSessionId),
          ).toMatchObject({
            cwd: "/managed/research",
            auxiliary: true,
            projectInvestigation: true,
            allowMutations: false,
          });
          expect((yield* (yield* SessionFamilyStorage).state()).deferredReferences).toEqual([
            expect.objectContaining({
              recipientSessionId: sessionId,
              source: expect.objectContaining({
                kind: "subagent",
                handleId: receipt.result.handleId,
                messageId: "original-answer",
              }),
            }),
          ]);
          expect(fixture.createdRecords).toEqual([]);
          expect(fixture.linkedSidecars).toEqual([]);
          expect(fixture.rendererBindings).toEqual([]);
          expect(fixture.controlInvocations).toEqual([]);
          expect(fixture.preparedContexts()).toBe(0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              fixture.layer,
              Layer.mock(CakeChatDurable, {
                taskContext: () =>
                  Effect.succeed({
                    entryId: "settled",
                    messages: [{ role: "user", content: "Settled parent context", timestamp: 1 }],
                  }),
              }),
              Layer.mock(SubagentEnvironment, {
                location: (workingDirectory) =>
                  Effect.succeed({
                    workingDirectory: workingDirectory ?? "/home",
                    agentDirectory: "/cake",
                    sessionDirectory: "/private",
                  }),
                seedContext: (_workingDirectory, recipient) =>
                  Effect.sync(() => {
                    seeds.push(recipient);
                  }),
              }),
              Layer.mock(ProjectAccess, {
                isAllowed: () => Effect.succeed(true),
                allow: () => Effect.void,
              }),
              Layer.mock(ManagedWorktrees, {
                createCheckout: () =>
                  Effect.succeed({
                    projectPath: "/project",
                    worktreePath: "/managed/research",
                    branch: "agent/research",
                    baseBranch: "main",
                    createdAt: "2026-01-01",
                    state: "active",
                    parentWorktreePath: undefined,
                    baseCommit: "base",
                    resolvedFrom: undefined,
                  }),
                awaitSetup: () => Effect.void,
              }),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );
  for (const sessionId of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")]) {
    it.effect(`exposes native fork help without renderer registration (${sessionId})`, () => {
      const fixture = makeLayer({ cakeChat: true });
      return Effect.gen(function* () {
        const options = yield* acquireChatOptions({
          configuration: {
            location: {
              workingDirectory: sessionId === CAKE_CHAT_SESSION_ID ? "/home" : "/project",
              sessionDirectory: "/cake/chat",
            },
            agentDirectory: "/cake",
          },
          target: { sessionId, tools: listAppControlTools() },
          newSession: false,
        });
        const control = options.runtime.globalControl!;
        const registry = new CakeOperationRegistry(
          createGlobalControlOperations(control, () => {
            throw new Error("A context fork must not select a fresh model");
          }),
        );
        const context = { signal: new AbortController().signal, toolCallId: "help", runtime: {} };
        const help = yield* Effect.promise(() =>
          registry.invoke({ command: "sessions.fork.help" }, context),
        );
        expect(help.text).toContain("parent-owned Subagent Session");
        expect(help.text).not.toContain("context-forked Side Session");
        expect(control.tools.filter((tool) => tool.command === "sessions.fork")).toHaveLength(1);
        const unavailable = yield* Effect.promise(() =>
          registry.invoke(
            {
              command: "sessions.fork",
              input: {
                workspacePath: "/project",
                worktreeName: "fix",
                name: "Fix",
                initialPrompt: "Fix it",
              },
            },
            context,
          ),
        );
        expect(unavailable.details).toMatchObject({
          result: {
            ok: false,
            error: "Agent-owned context forks are unavailable in this runtime",
          },
        });
        expect(fixture.createdRecords).toEqual([]);
        expect(fixture.prompts).toEqual([]);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    });
  }
});

describe("Cake Chat side chats", () => {
  it.effect.each([undefined, "grant", "handoff"] as const)(
    "prepares queued handoff and forwards attachment access before transfer (%s)",
    (failure) => {
      const fixture = makeLayer({ cakeChat: true, durableFork: 8, queuedUser: true });
      const events: string[] = [];
      return Effect.gen(function* () {
        yield* assembleCakeChat;
        const result = yield* discussionSessions
          .startCakeChatSideChat(
            {
              parentSessionId: CAKE_CHAT_SESSION_ID,
              queuedPartId: "queued-user",
              anchor: { ...cakeChatAnchor, view: "session" },
              text: "",
            },
            "/home",
            12,
          )
          .pipe(Effect.result);
        assert.equal(result._tag, failure ? "Failure" : "Success");
        assert.deepEqual(
          events,
          failure === "grant" ? ["authorize", "grant"] : ["authorize", "grant", "handoff"],
        );
        assert.deepEqual(fixture.prompts, []);
        assert.equal(fixture.rendererBindings.at(-1)?.sessionId, cakeChatSideChatSessionId(8));
        assert.equal(fixture.rendererBindings.at(-1)?.connectionId, 12);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            fixture.layer,
            Layer.mock(CakeChatDurable, {
              forkSideChat: () => Effect.succeed(cakeChatSideChatSessionId(8)),
              transferQueuedToSideChat: (parent, source, target, partId) => {
                events.push("handoff");
                assert.deepEqual(
                  [parent, source, target, partId],
                  [
                    CAKE_CHAT_SESSION_ID,
                    CAKE_CHAT_SESSION_ID,
                    cakeChatSideChatSessionId(8),
                    "queued-user",
                  ],
                );
                return failure === "handoff"
                  ? Effect.fail(
                      new DurableChatError({ operation: "transfer", message: "Already consumed" }),
                    )
                  : Effect.succeed("10000000-0000-4000-8000-000000000009");
              },
            }),
            Layer.mock(TaskInputStorage, {
              isRecipient: () => Effect.succeed(false),
              authorizeForward: (owner, refs, recipient) => {
                events.push("authorize");
                assert.deepEqual(
                  [owner, refs, recipient],
                  [CAKE_CHAT_SESSION_ID, [attachmentReference.id], cakeChatSideChatSessionId(8)],
                );
                return Effect.succeed(["forward-token"]);
              },
              grant: (recipient, refs) => {
                events.push("grant");
                assert.deepEqual(
                  [recipient, refs],
                  [cakeChatSideChatSessionId(8), ["forward-token"]],
                );
                return failure === "grant"
                  ? Effect.fail(
                      new AttachmentUploadError({ operation: "grant", message: "Grant failed" }),
                    )
                  : Effect.succeed([attachmentReference]);
              },
            }),
          ),
        ),
      );
    },
  );

  it.effect("keeps session-anchor starts rooted at the main conversation with attachments", () => {
    const fixture = makeLayer({ cakeChat: true, durableFork: 8 });
    const forks: string[] = [];
    const attachments = [{ kind: "text" as const, name: "Notes", text: "Keep this context" }];
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      for (const source of [CAKE_CHAT_SESSION_ID, cakeChatSideChatSessionId(7)]) {
        const accepted = yield* discussionSessions.startCakeChatSideChat(
          {
            parentSessionId: source,
            anchor: {
              ...cakeChatAnchor,
              view: "session",
              entryId: undefined,
              messageId: undefined,
            },
            text: "Separate question",
            attachments,
          },
          "/home",
        );
        assert.equal(accepted.thread.sidecarSessionId, cakeChatSideChatSessionId(8));
      }
      assert.deepEqual(forks, [CAKE_CHAT_SESSION_ID, CAKE_CHAT_SESSION_ID]);
      assert.deepEqual(
        fixture.createdRecords.map((record) => record.parentSessionId),
        [CAKE_CHAT_SESSION_ID, CAKE_CHAT_SESSION_ID],
      );
      assert.deepEqual(fixture.prompts.at(-1)?.slice(0, 3), [
        "Separate question",
        "prompt",
        [attachmentReference],
      ]);
      assert.deepEqual(fixture.isolatedInputs, [
        { sessionId: cakeChatSideChatSessionId(8), attachments },
        { sessionId: cakeChatSideChatSessionId(8), attachments },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          fixture.layer,
          Layer.mock(CakeChatDurable, {
            forkSideChat: (parent, entryId) =>
              Effect.sync(() => {
                assert.equal(entryId, undefined);
                forks.push(parent);
                return cakeChatSideChatSessionId(8);
              }),
          }),
        ),
      ),
    );
  });

  it.effect("forks Cake Chat natively instead of copying its conversation", () => {
    const fixture = makeLayer({ cakeChat: true, durableFork: 7 });
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      const accepted = yield* discussionSessions.startCakeChatSideChat(
        {
          anchor: cakeChatAnchor,
          text: "Why is it larger?",
          model: { provider: "anthropic", id: "claude" },
        },
        "/home",
      );
      yield* Effect.yieldNow;

      const sessionId = cakeChatSideChatSessionId(7);
      assert.deepEqual(fixture.forkedEntries, ["entry-assistant-2"]);
      assert.deepEqual(fixture.createdRecords, [
        { workingDirectory: "/home", parentSessionId: CAKE_CHAT_SESSION_ID },
      ]);
      assert.deepEqual(fixture.linkedSidecars, [sessionId]);
      assert.equal(fixture.record().sidecarSessionId, sessionId);
      // The fork lives in Cake Chat's database, never a Discussion transcript file.
      assert.equal(fixture.record().sidecarSessionFile, undefined);
      const sidecar = fixture.options.find((options) => options.directSessionDir);
      assert.equal(sidecar?.sessionId, sessionId);
      assert.equal(sidecar?.newSession, false);
      assert.ok(sidecar?.globalControl);
      assert.equal(sidecar?.auxiliary, false);
      assert.deepEqual(fixture.modelSelections.at(-1), {
        provider: "anthropic",
        modelId: "claude",
      });
      assert.equal(fixture.prompts.at(-1)?.[0], "Why is it larger?");
      assert.equal(accepted.thread.sidecarSessionId, sessionId);
      assert.equal(fixture.preparedContexts(), 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  const assertNoStartedDiscussion = (fixture: ReturnType<typeof makeLayer>) => {
    assert.deepEqual(fixture.createdRecords, []);
    assert.deepEqual(fixture.linkedSidecars, []);
    assert.equal(fixture.record().sidecarSessionId, undefined);
    assert.equal(
      fixture.options.some((options) => options.directSessionDir),
      false,
    );
    assert.deepEqual(fixture.prompts, []);
  };

  for (const entryId of [undefined, "", "   "]) {
    it.effect(
      `rejects a missing or blank entry ID (${JSON.stringify(entryId)}) before forking`,
      () => {
        const fixture = makeLayer({ cakeChat: true, durableFork: 7 });
        return Effect.gen(function* () {
          yield* assembleCakeChat;
          const error = yield* discussionSessions
            .startCakeChatSideChat({ anchor: { ...cakeChatAnchor, entryId }, text: "Hi" }, "/home")
            .pipe(Effect.flip);
          assert.equal(error.operation, "start");
          assert.match(error.message, /no entry to branch from/);
          assert.deepEqual(fixture.forkedEntries, []);
          assertNoStartedDiscussion(fixture);
        }).pipe(Effect.provide(fixture.layer));
      },
    );
  }

  for (const entryId of ["invalid", "999999"]) {
    it.effect(`surfaces a rejected entry ID (${entryId}) without storing a discussion`, () => {
      const fixture = makeLayer({ cakeChat: true, durableFork: 7 });
      return Effect.gen(function* () {
        yield* assembleCakeChat;
        const error = yield* discussionSessions
          .startCakeChatSideChat({ anchor: { ...cakeChatAnchor, entryId }, text: "Hi" }, "/home")
          .pipe(Effect.flip);
        assert.match(error.message, /Could not create a native Cake Chat side chat/);
        assert.deepEqual(fixture.forkedEntries, [entryId]);
        assertNoStartedDiscussion(fixture);
      }).pipe(Effect.provide(fixture.layer));
    });
  }

  it.effect("reports fork failure safely and retains its real cause in backend logs", () => {
    const cause = "SQLITE_BUSY at /private/coordinator.sqlite";
    const fixture = makeLayer({ cakeChat: true, forkFailure: cause });
    const logs: unknown[] = [];
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      const error = yield* discussionSessions
        .startCakeChatSideChat({ anchor: cakeChatAnchor, text: "Hi" }, "/home")
        .pipe(Effect.flip);
      assert.equal(error.operation, "start");
      assert.equal(
        error.message,
        "Could not create a native Cake Chat side chat. Try again from a completed reply.",
      );
      assert.ok(
        logs.some(
          (message) =>
            Array.isArray(message) &&
            message.some((part) => part instanceof PiSessionError && part.message === cause),
        ),
      );
      assert.deepEqual(fixture.forkedEntries, [cakeChatAnchor.entryId]);
      assertNoStartedDiscussion(fixture);
    }).pipe(
      Effect.provide(fixture.layer),
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
    );
  });

  it.effect("reports an unavailable parent runtime without storing a discussion", () => {
    const fixture = makeLayer({ cakeChat: true, durableFork: 7 });
    return Effect.gen(function* () {
      const error = yield* discussionSessions
        .startCakeChatSideChat({ anchor: cakeChatAnchor, text: "Hi" }, "/home")
        .pipe(Effect.flip);
      assert.match(error.message, /Could not create a native Cake Chat side chat/);
      assert.deepEqual(fixture.forkedEntries, []);
      assertNoStartedDiscussion(fixture);
    }).pipe(Effect.provide(fixture.layer));
  });

  for (const forkSessionId of ["regular-pi-fork", ""]) {
    it.effect(`rejects a non-Durable fork result (${JSON.stringify(forkSessionId)})`, () => {
      const fixture = makeLayer({ cakeChat: true, forkSessionId });
      return Effect.gen(function* () {
        yield* assembleCakeChat;
        const error = yield* discussionSessions
          .startCakeChatSideChat({ anchor: cakeChatAnchor, text: "Hi" }, "/home")
          .pipe(Effect.flip);
        assert.equal(
          error.message,
          "Cake Chat did not return a native Durable side chat. No discussion was created.",
        );
        assert.deepEqual(fixture.forkedEntries, [cakeChatAnchor.entryId]);
        assertNoStartedDiscussion(fixture);
      }).pipe(Effect.provide(fixture.layer));
    });
  }

  it.effect(
    "leaves stored non-Durable conversations untouched instead of recreating a sidecar",
    () => {
      const fixture = makeLayer({ cakeChat: true, persistedSidecar: true });
      Object.assign(fixture.record(), {
        sidecarSessionId: "copied-context-sidecar",
        sidecarSessionFile: "/cake/reviews/thread-1/copied-context-sidecar.jsonl",
      });
      const stored = { ...fixture.record() };
      return Effect.gen(function* () {
        const error = yield* discussionSessions
          .observe({
            workingDirectory: "/home",
            parentSessionId: CAKE_CHAT_SESSION_ID,
            threadId: "thread-1",
          })
          .pipe(Effect.flip);
        assert.match(error.message, /no native Durable conversation/);
        assert.deepEqual(fixture.record(), stored);
        assert.deepEqual(fixture.createdRecords, []);
        assert.deepEqual(fixture.linkedSidecars, []);
        assert.deepEqual(fixture.options, []);
        assert.deepEqual(fixture.prompts, []);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect(
    "rejects a Cake Chat side chat anchored to a file instead of conversation history",
    () => {
      const fixture = makeLayer({ cakeChat: true });
      return Effect.gen(function* () {
        const error = yield* discussionSessions
          .startCakeChatSideChat({ anchor, text: "Hi" }, "/home")
          .pipe(Effect.flip);
        assert.equal(error.message, "A Cake Chat side chat must branch from a message");
        assert.deepEqual(fixture.createdRecords, []);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
});

describe("Discussion Sessions domain", () => {
  it.effect("projects Cake-owned pending comments before a sidecar transcript exists", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const threads = yield* discussionSessions.list({
        workingDirectory: "/project",
        parentSessionId: "parent-1",
      });
      assert.equal(threads.length, 1);
      assert.deepEqual(threads[0]?.parts, fixture.record().pendingParts);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("starts a thread with annotations as the first prompt's attachments", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      yield* discussionSessions.start({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor,
        text: "",
        annotations: [
          {
            id: "91f94663-4a8c-4d54-a3ce-531245f89477",
            messageId: "assistant-1",
            entryId: "entry-1",
            selectedText: "important detail",
            startOffset: 4,
            endOffset: 20,
            contextBefore: "An ",
            contextAfter: " follows.",
            comment: "Explain this",
          },
        ],
      });
      yield* Effect.yieldNow;

      const naming = yield* (yield* DiscussionTitleRequests)
        .requests()
        .pipe(Stream.take(1), Stream.runCollect);
      expect([...naming]).toEqual([
        {
          workingDirectory: "/project",
          parentSessionId: "parent-1",
          threadId: fixture.record().id,
          firstUserMessage: "Explain this",
        },
      ]);
      assert.deepEqual(fixture.prompts.at(-1)?.slice(0, 3), [
        "",
        "prompt",
        [
          {
            kind: "annotation",
            annotations: [
              {
                id: "91f94663-4a8c-4d54-a3ce-531245f89477",
                messageId: "assistant-1",
                entryId: "entry-1",
                selectedText: "important detail",
                startOffset: 4,
                endOffset: 20,
                contextBefore: "An ",
                contextAfter: " follows.",
                comment: "Explain this",
              },
            ],
          },
        ],
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "binds first-prompt, reobserved and later user input to the exact sidecar, never its parent",
    () => {
      const fixture = makeLayer();
      return Effect.gen(function* () {
        const accepted = yield* discussionSessions.start(
          {
            parentSessionId: "parent-1",
            workingDirectory: "/project",
            anchor,
            text: "Ask a question",
          },
          11,
        );
        const sessionId = accepted.thread.sidecarSessionId;
        assert.ok(sessionId);
        expect(fixture.rendererBindings).toEqual([{ sessionId, connectionId: 11, prompts: 0 }]);
        const sidecar = fixture.options.find((options) => options.sessionId === sessionId);
        assert.ok(sidecar?.requestInterview);
        expect(sidecar.allowBlockingUserInput).toBe(true);
        const record = {
          id: "question",
          sessionId,
          request: {
            protocol: "cake.request/v1" as const,
            id: "question",
            title: "Choose",
            responseSchema: { type: "object" as const },
            view: { type: "form" as const, fields: [] },
            fallback: { markdown: "Choose" },
          },
        };
        expect(
          yield* Effect.promise(() =>
            sidecar.requestInterview!(record, new AbortController().signal),
          ),
        ).toEqual({ answer: true });
        expect(fixture.interviewRequests).toEqual([{ sessionId, record }]);
        const _updates = yield* discussionSessions.observe(
          {
            parentSessionId: "parent-1",
            workingDirectory: "/project",
            threadId: "thread-1",
          },
          22,
        );
        yield* sessionChats.bindRenderer(sessionId, 31);
        expect(
          fixture.rendererBindings.map(({ sessionId: id, connectionId }) => [id, connectionId]),
        ).toEqual([
          [sessionId, 11],
          [sessionId, 22],
          [sessionId, 31],
        ]);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("inherits project capabilities with regenerated parent context", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const accepted = yield* discussionSessions.start({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor,
        text: "Explain this",
      });
      assert.match(accepted.turnId, /^[0-9a-f-]{36}$/);
      assert.equal(fixture.preparedContexts(), 1);
      assert.equal(typeof accepted.thread.sidecarSessionId, "string");
      assert.equal(accepted.thread.sidecarSessionId, fixture.record().sidecarSessionId);
      const sidecar = fixture.options.find((options) => options.directSessionDir);
      assert.equal(sidecar?.tools, undefined);
      assert.equal(sidecar?.auxiliary, false);
      assert.ok(sidecar?.currentSessionControl?.invokeAppControl);
      assert.equal(sidecar?.allowedCakeOperations, undefined);
      assert.equal(sidecar?.directSessionDir, true);
      assert.equal(sidecar?.globalControl, undefined);
      // The parent's Discussion catalog learns about the new sidecar right away.
      assert.ok(fixture.parentIndexRefreshes() >= 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "serves every later conversation operation through the shared Session Chat core",
    () => {
      const fixture = makeLayer();
      return Effect.gen(function* () {
        const accepted = yield* discussionSessions.start({
          parentSessionId: "parent-1",
          workingDirectory: "/project",
          anchor,
          text: "Explain this",
        });
        const sidecarId = accepted.thread.sidecarSessionId!;
        const target = { sessionId: sidecarId };

        yield* sessionChats.deliver(
          { ...target, text: "And now?", attachments: [], renderUserMessageAsMarkdown: false },
          "prompt",
        );
        yield* sessionChats.steerQueuedMessage(target, "queued-follow-up-1");
        yield* sessionChats.removeQueuedMessage(target, "queued-follow-up-2");
        yield* sessionChats.cancelSteering(target);
        yield* Effect.yieldNow;

        // The same sidecar runtime the start acquired serves the shared operations,
        // and the read-only parent projection is regenerated before each turn.
        assert.equal(fixture.prompts.length, 2);
        assert.equal(fixture.prompts.at(-1)?.[0], "And now?");
        assert.equal(fixture.preparedContexts(), 2);
        assert.deepEqual(fixture.queueOperations, [
          `${sidecarId}:steer:queued-follow-up-1`,
          `${sidecarId}:remove:queued-follow-up-2`,
          `${sidecarId}:cancelSteering`,
        ]);
        assert.equal(fixture.options.filter((options) => options.directSessionDir).length, 1);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("reopens a resolved thread when a shared prompt reaches its sidecar", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const accepted = yield* discussionSessions.start({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor,
        text: "Explain this",
      });
      const sidecarId = accepted.thread.sidecarSessionId!;
      yield* discussionSessions.setResolved(
        { parentSessionId: "parent-1", workingDirectory: "/project", threadId: "thread-1" },
        true,
      );
      assert.equal(fixture.record().status, "resolved");
      const refreshesBefore = fixture.parentIndexRefreshes();

      yield* sessionChats.deliver(
        {
          sessionId: sidecarId,
          text: "One more thing",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        "prompt",
      );
      yield* Effect.yieldNow;

      assert.equal(fixture.record().status, "open");
      // Delivery and settlement both keep the parent's catalog current.
      assert.ok(fixture.parentIndexRefreshes() > refreshesBefore);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("observes a persisted sidecar from the dedicated thread directory", () => {
    const fixture = makeLayer({ persistedSidecar: true });
    return Effect.gen(function* () {
      const updates = yield* discussionSessions.observe({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        threadId: "thread-1",
      });
      const first = yield* Stream.runHead(updates);
      assert.equal(first._tag === "Some" && first.value._tag, "Snapshot");
      if (first._tag !== "Some" || first.value._tag !== "Snapshot") return;
      assert.equal(first.value.snapshot.conversation.sessionId, "persisted-sidecar");
      assert.equal(
        first.value.snapshot.conversation.sessionFile,
        fixture.record().sidecarSessionFile,
      );
      assert.equal(fixture.options.length, 1);
      assert.equal(fixture.options[0]?.directSessionDir, true);
      assert.equal(fixture.options[0]?.sessionDir, "/cake/reviews/thread-1");
      assert.equal(fixture.options[0]?.newSession, false);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("observes the sidecar in the shared Cake Session update shape", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const accepted = yield* discussionSessions.start({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor,
        text: "Explain this",
      });
      const updates = yield* discussionSessions.observe({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        threadId: "thread-1",
      });
      const first = yield* Stream.runHead(updates.pipe(Stream.take(1)));
      assert.equal(first._tag === "Some" && first.value._tag, "Snapshot");
      if (first._tag !== "Some" || first.value._tag !== "Snapshot") return;
      assert.deepEqual(first.value.snapshot.identity, {
        _tag: "DiscussionSession",
        sessionId: accepted.thread.sidecarSessionId,
        parentSessionId: "parent-1",
      });
      assert.equal(first.value.snapshot.conversation.sessionId, accepted.thread.sidecarSessionId);
    }).pipe(Effect.provide(fixture.layer));
  });
});

it.effect(
  "publishes Discussion own start/settle metadata without a full transcript observation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const f = makeLayer({ activityGate: { entered, complete } });
      yield* Effect.gen(function* () {
        const updates = yield* Queue.unbounded<boolean>();
        const metadata = yield* discussionSessions.observeMetadata({
          workingDirectory: "/project",
          parentSessionId: "parent-1",
        });
        const consumer = yield* metadata.pipe(
          Stream.map((threads) => threads.some((thread) => thread.running)),
          Stream.changes,
          Stream.runForEach((running) => Queue.offer(updates, running)),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(updates)).toBe(false);
        expect(f.inspections()).toBe(0);
        const started = yield* discussionSessions.start({
          workingDirectory: "/project",
          parentSessionId: "parent-1",
          anchor,
          text: "Start the discussion",
        });
        yield* Deferred.await(entered);
        expect(yield* Queue.take(updates)).toBe(true);
        const readsAtStart = f.inspections();
        yield* Deferred.succeed(complete, undefined);
        expect(yield* Queue.take(updates)).toBe(false);
        expect(f.inspections()).toBe(readsAtStart);
        expect(started.thread.sidecarSessionId).toBe(f.linkedSidecars[0]);
        yield* Fiber.interrupt(consumer);
        yield* Deferred.await(stopped);
        expect(yield* Queue.size(updates)).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            f.layer,
            Layer.mock(ReviewStorage, {
              changes: () => Stream.succeed(1).pipe(Stream.concat(Stream.never)),
              agentSessionDirectory: () => "/cake/reviews/thread-1",
              reviewContextPath: () => "/cake/reviews/context.md",
              discussionParentContextPath: () => "/cake/reviews/context/parent.md",
            }),
          ),
        ),
      );
    }),
);
