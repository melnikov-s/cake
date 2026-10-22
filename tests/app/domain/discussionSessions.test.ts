import { makeRuntimeRecoveryStorageTestLayer } from "../helpers/piRuntimeFixture";
import assert from "node:assert/strict";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { it } from "@effect/vitest";
import { Effect, Layer, Scope, Stream } from "effect";
import { describe, expect } from "vitest";
import * as discussionSessions from "../../../src/domain/discussion-sessions/discussionSessions";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import {
  makeDiscussionSessionEnvironmentLayer,
  type DiscussionSessionRecord,
} from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import {
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimesAdapter,
  type CakeSessionRuntimeSetup,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { CakeSessionRuntime } from "../../../src/services/pi/runtime/cake-session-runtime";
import { makeProjectSessionRuntimeTestLayer } from "./projectSessionRuntimeTestLayer";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { sessionAssistantThreadPath } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";

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

const cakeChatParts: ConversationSnapshot["parts"] = [
  { id: "user-1", kind: "text", role: "user", text: "Which tasks are open?", status: "complete" },
  {
    id: "assistant-1",
    kind: "text",
    role: "assistant",
    text: "Two tasks are open.",
    status: "complete",
  },
  {
    id: "tool-1",
    kind: "tool",
    toolCallId: "call-1",
    name: "cake",
    input: {},
    state: "complete",
  } as unknown as ConversationSnapshot["parts"][number],
  { id: "user-2", kind: "text", role: "user", text: "Compare them.", status: "complete" },
  {
    id: "assistant-2",
    kind: "text",
    role: "assistant",
    entryId: "entry-assistant-2",
    text: "The first is larger.",
    status: "complete",
  },
  { id: "user-3", kind: "text", role: "user", text: "Later question", status: "complete" },
];

const makeLayer = (
  options: {
    readonly assistant?: boolean;
    readonly persistedSidecar?: boolean;
    readonly cakeChat?: boolean;
    /** Cake Chat forks natively into this Durable conversation instead of refusing. */
    readonly durableFork?: number;
    readonly backendControl?: boolean;
  } = {},
) => {
  const durableFork = options.durableFork;
  const forkedEntries: string[] = [];
  let record: DiscussionSessionRecord = {
    id: "thread-1",
    workingDirectory: options.cakeChat ? "/home" : "/project",
    parentSessionId: options.cakeChat ? CAKE_CHAT_SESSION_ID : "parent-1",
    ...(options.persistedSidecar
      ? {
          sidecarSessionId: "persisted-sidecar",
          sidecarSessionFile: "/cake/reviews/thread-1/persisted-sidecar.jsonl",
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
    anchor: options.cakeChat
      ? cakeChatAnchor
      : options.assistant
        ? {
            path: sessionAssistantThreadPath("parent-1"),
            view: "session",
            start: { diffLine: 0 },
            end: { diffLine: 0 },
            selectedText: "",
            contextBefore: "",
            contextAfter: "",
            diff: "",
          }
        : anchor,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const runtimeOptions: CakeSessionRuntimeSetup[] = [];
  const modelSelections: Array<{ provider: string; modelId: string }> = [];
  const controlInvocations: unknown[] = [];
  const forwardedInputs: unknown[] = [];
  let stagedProjections = 0;
  const prompts: Parameters<CakeSessionRuntime["prompt"]>[] = [];
  const queueOperations: string[] = [];
  let preparedContexts = 0;
  let parentIndexRefreshes = 0;
  const createdRecords: Array<{ workingDirectory: string; parentSessionId: string }> = [];
  const branchContexts: unknown[] = [];
  const runtime = (options: CakeSessionRuntimeSetup): CakeSessionRuntime => {
    const sessionId = options.sessionId ?? "generated";
    const sessionFile = options.auxiliary
      ? `${options.sessionDir}/${sessionId}.jsonl`
      : `/sessions/${sessionId}.jsonl`;
    return {
      sessionId,
      sessionFile,
      streaming: false,
      getReviewParentContext: options.auxiliary
        ? undefined
        : () => ({
            sessionId,
            sessionFile,
            leafId: "leaf-1",
          }),
      snapshot: async () =>
        sessionId === CAKE_CHAT_SESSION_ID
          ? { ...makeSnapshot(sessionId, sessionFile), parts: cakeChatParts }
          : makeSnapshot(sessionId, sessionFile),
      listQueuedMessages: async () => ({ steering: [], followUp: [] }),
      pendingMessages: async () => ({ items: [] }),
      reorderPendingMessage: async () => ({ items: [] }),
      clearQueue: async () => ({ steering: [], followUp: [] }),
      cancelSteering: async () => {
        queueOperations.push(`${sessionId}:cancelSteering`);
        return { steering: [], followUp: [] };
      },
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
        options.onEvent({ type: "streaming", sessionId, streaming: false });
      },
      setUserMessageMarkdown: async () => undefined,
      queueCommand: async () => {
        throw new Error("Unexpected queueCommand");
      },
      inspectSession: async () => {
        throw new Error("Unexpected inspectSession");
      },
      compact: async () => undefined,
      abort: async () => undefined,
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
        if (durableFork === undefined) throw new Error("Durable fork is unavailable");
        return {
          sessionId: cakeChatSideChatSessionId(durableFork),
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
    inspect: () => Effect.succeed(undefined),
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
        trusted: true,
      }),
    sidecarSystemPrompt: () =>
      Effect.succeed("Read the bounded parent projection at /cake/reviews/context/parent.md"),
    prepareParentContext: () =>
      Effect.sync(() => {
        preparedContexts += 1;
      }),
    prepareStagedParentContext: () =>
      Effect.sync(() => {
        stagedProjections += 1;
      }),
    prepareCakeChatBranchContext: (_record, messages) =>
      Effect.sync(() => {
        branchContexts.push(messages);
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
    trustedProjectPaths: ["/project"],
  };
  return {
    layer: Layer.mergeAll(
      WorkflowTestLive,
      makeCakeSessionRuntimesLayer(adapter).pipe(
        Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
      ),
      discussions,
      projectRuntime,
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
    prompts,
    queueOperations,
    preparedContexts: () => preparedContexts,
    parentIndexRefreshes: () => parentIndexRefreshes,
    stagedProjections: () => stagedProjections,
    createdRecords,
    branchContexts,
    forkedEntries,
    modelSelections,
    controlInvocations,
    forwardedInputs,
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
        trusted: true,
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

describe("Cake Chat side chats", () => {
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
      // No text copy: the fork already holds Cake Chat's exact context.
      assert.deepEqual(fixture.branchContexts, []);
      assert.equal(fixture.record().sidecarSessionId, sessionId);
      // The fork lives in Cake Chat's database, never a Discussion transcript file.
      assert.equal(fixture.record().sidecarSessionFile, undefined);
      const sidecar = fixture.options.find((options) => options.auxiliary);
      assert.equal(sidecar?.sessionId, sessionId);
      assert.equal(sidecar?.newSession, false);
      assert.equal(sidecar?.globalControl, undefined);
      assert.equal(sidecar?.additionalSystemPrompt, "");
      assert.deepEqual(fixture.modelSelections.at(-1), {
        provider: "anthropic",
        modelId: "claude",
      });
      assert.equal(fixture.prompts.at(-1)?.[0], "Why is it larger?");
      assert.equal(accepted.thread.sidecarSessionId, sessionId);
      assert.equal(fixture.preparedContexts(), 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("branches a tool-free side chat with the conversation through its message", () => {
    const fixture = makeLayer({ cakeChat: true });
    return Effect.gen(function* () {
      yield* assembleCakeChat;
      const accepted = yield* discussionSessions.startCakeChatSideChat(
        { anchor: cakeChatAnchor, text: "Why is it larger?" },
        "/home",
      );
      yield* Effect.yieldNow;

      assert.deepEqual(fixture.createdRecords, [
        { workingDirectory: "/home", parentSessionId: CAKE_CHAT_SESSION_ID },
      ]);
      // Cake Chat could not fork, so the side chat falls back to copied context.
      assert.deepEqual(fixture.forkedEntries, ["entry-assistant-2"]);
      // Tool activity and messages after the branch point stay out of the context.
      assert.deepEqual(fixture.branchContexts, [
        [
          { role: "user", text: "Which tasks are open?" },
          { role: "assistant", text: "Two tasks are open." },
          { role: "user", text: "Compare them." },
          { role: "assistant", text: "The first is larger." },
        ],
      ]);
      const sidecar = fixture.options.find((options) => options.auxiliary);
      assert.deepEqual(sidecar?.tools, []);
      assert.equal(sidecar?.globalControl, undefined);
      assert.equal(fixture.prompts.at(-1)?.[0], "Why is it larger?");
      assert.equal(accepted.thread.parentSessionId, CAKE_CHAT_SESSION_ID);
      // The branch context is frozen: no Project Session parent projection is read.
      assert.equal(fixture.preparedContexts(), 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "rejects a branch message that is no longer in Cake Chat without storing a thread",
    () => {
      const fixture = makeLayer({ cakeChat: true });
      return Effect.gen(function* () {
        yield* assembleCakeChat;
        const error = yield* discussionSessions
          .startCakeChatSideChat(
            { anchor: { ...cakeChatAnchor, messageId: "gone", entryId: "gone" }, text: "Hi" },
            "/home",
          )
          .pipe(Effect.flip);
        assert.equal(error.message, "That Cake Chat message is no longer available");
        assert.deepEqual(fixture.createdRecords, []);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("rejects a Cake Chat side chat that is not anchored to a message", () => {
    const fixture = makeLayer({ cakeChat: true });
    return Effect.gen(function* () {
      const error = yield* discussionSessions
        .startCakeChatSideChat({ anchor: { ...anchor, view: "session" }, text: "Hi" }, "/home")
        .pipe(Effect.flip);
      assert.equal(error.message, "A Cake Chat side chat must branch from a message");
      assert.deepEqual(fixture.createdRecords, []);
    }).pipe(Effect.provide(fixture.layer));
  });
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

  it.effect("starts on a constrained sidecar runtime with regenerated parent context", () => {
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
      const sidecar = fixture.options.find((options) => options.auxiliary);
      assert.deepEqual(sidecar?.tools, ["read", "grep", "find", "ls"]);
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
        assert.equal(fixture.options.filter((options) => options.auxiliary).length, 1);
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

  it.effect(
    "acquires the session assistant as a side chat on the utility model with Cake control",
    () => {
      const fixture = makeLayer({ assistant: true });
      const tool = {
        command: "sessions.open",
        topic: "sessions",
        summary: "Open a session",
        parameters: { type: "object", properties: {} },
      };
      const ensureInput = {
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        tools: [tool],
        staged: false,
        stagedMessages: [],
      };
      return Effect.gen(function* () {
        const ensured = yield* discussionSessions.ensureSessionAssistant({
          ...ensureInput,
          firstPrompt: { text: "Where is the plan?" },
        });
        const thread = ensured.thread;
        assert.equal(typeof thread.sidecarSessionId, "string");
        // A brand-new assistant starts with its first message, as any side chat
        // does, so Pi persists the sidecar before the renderer observes it.
        assert.match(ensured.turnId ?? "", /^[0-9a-f-]{36}$/);
        yield* Effect.yieldNow;
        assert.equal(fixture.prompts.length, 1);
        assert.equal(fixture.prompts[0]?.[0], "Where is the plan?");
        assert.equal(fixture.stagedProjections(), 0);

        const sidecar = fixture.options.find((options) => options.auxiliary)!;
        // Same profile and runtime as a side chat; only the configuration differs.
        assert.equal(sidecar.auxiliary, true);
        assert.equal(sidecar.globalControl, undefined);
        // The assistant can run shell commands, unlike a read-only side chat.
        assert.deepEqual(sidecar.tools, [
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          "cake",
        ]);
        assert.match(sidecar.additionalSystemPrompt ?? "", /Session Assistant attached to/);
        assert.match(
          sidecar.additionalSystemPrompt ?? "",
          /standard read, search, edit, write, and shell tools/,
        );
        assert.match(
          sidecar.additionalSystemPrompt ?? "",
          /sessions — Create, fork, inspect, message/,
        );
        assert.match(sidecar.additionalSystemPrompt ?? "", /<operation>\.help supplies input/);
        assert.deepEqual(fixture.modelSelections.at(-1), {
          provider: "google",
          modelId: "gemini-3.5-flash-lite",
        });

        // Backend-owned inspection/settings do not visit the parent renderer.
        const settings = yield* Effect.promise(() =>
          sidecar.sessionControl!.invoke(
            { name: "settings.models.get", arguments: {} },
            new AbortController().signal,
          ),
        );
        expect(settings).toMatchObject({
          ok: true,
          value: { utilityModel: { modelId: "gemini-3.5-flash-lite" } },
        });
        assert.deepEqual(fixture.controlInvocations, []);
        // Window-owned controls still reach the parent renderer.
        assert.deepEqual(
          sidecar.sessionControl?.tools.map((candidate) => candidate.command),
          ["sessions.open"],
        );
        yield* Effect.promise(() =>
          sidecar.sessionControl!.invoke(
            { name: "sessions.open", arguments: { sessionId: "other" } },
            new AbortController().signal,
          ),
        );
        assert.deepEqual(fixture.controlInvocations, [
          {
            sessionId: "parent-1",
            invocation: {
              _tag: "InvokeAppControl",
              command: "sessions.open",
              input: { sessionId: "other" },
            },
          },
        ]);

        // Later turns are ordinary shared Session Chat prompts to the sidecar.
        yield* sessionChats.deliver(
          {
            sessionId: thread.sidecarSessionId!,
            text: "Open the other session",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          "prompt",
        );
        yield* Effect.yieldNow;
        assert.equal(fixture.prompts.length, 2);
        assert.equal(fixture.preparedContexts(), 2);
        assert.equal(fixture.options.filter((options) => options.auxiliary).length, 1);

        // Once the sidecar exists, ensure is a lookup and never re-prompts.
        const again = yield* discussionSessions.ensureSessionAssistant({
          ...ensureInput,
          firstPrompt: { text: "Ignored" },
        });
        assert.equal(again.turnId, undefined);
        assert.equal(again.thread.sidecarSessionId, thread.sidecarSessionId);
        assert.equal(fixture.prompts.length, 2);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect(
    "session assistant sends with parent identity and scoped attachment authorization, not sidecar identity",
    () => {
      const f = makeLayer({ assistant: true, backendControl: true });
      return Effect.gen(function* () {
        const ensured = yield* discussionSessions.ensureSessionAssistant({
          parentSessionId: "parent-1",
          workingDirectory: "/project",
          tools: [],
          staged: false,
          stagedMessages: [],
          firstPrompt: { text: "Coordinate" },
        });
        yield* Effect.yieldNow;
        const sidecar = f.options.find((options) => options.auxiliary);
        assert.ok(sidecar?.sessionControl);
        const recipient = "00000000-0000-4000-8000-000000000044";
        const result = yield* Effect.promise(() =>
          sidecar.sessionControl!.invoke(
            {
              name: "sessions.send",
              arguments: {
                sessionId: recipient,
                text: "Parent-scoped task",
                inputRefs: ["selected"],
              },
            },
            new AbortController().signal,
          ),
        );
        expect(result).toMatchObject({
          ok: true,
          expectsResponse: true,
          target: { sessionId: recipient },
        });
        yield* Effect.yieldNow;
        const message = f.prompts
          .map((input) => parseCrossSessionMessage(input[0]))
          .find((input) => input?.text === "Parent-scoped task");
        expect(message?.metadata.sender).toMatchObject({
          kind: "project-session",
          sessionId: "parent-1",
          title: "Parent authority",
          workingDirectory: "/project",
        });
        expect(message?.metadata.sender.sessionId).not.toBe(ensured.thread.sidecarSessionId);
        expect(f.forwardedInputs).toEqual([{ owner: "parent-1", refs: ["selected"], recipient }]);
        expect(f.controlInvocations).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "projects a staged parent's messages for the assistant instead of its transcript",
    () => {
      const fixture = makeLayer({ assistant: true });
      return Effect.gen(function* () {
        const ensured = yield* discussionSessions.ensureSessionAssistant({
          parentSessionId: "parent-1",
          workingDirectory: "/project",
          tools: [],
          staged: true,
          stagedMessages: [{ role: "user", text: "Draft the plan" }],
        });
        assert.equal(fixture.stagedProjections(), 1);
        // Without a first message there is nothing to persist: no sidecar yet.
        assert.equal(ensured.thread.sidecarSessionId, undefined);
        assert.equal(fixture.options.filter((options) => options.auxiliary).length, 0);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
});
