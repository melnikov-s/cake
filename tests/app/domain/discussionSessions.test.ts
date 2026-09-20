import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as discussionSessions from "../../../src/domain/discussion-sessions/discussionSessions";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import {
  makeDiscussionSessionEnvironmentLayer,
  type DiscussionSessionRecord,
} from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import {
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-session-runtime";
import { makeProjectSessionRuntimeTestLayer } from "./projectSessionRuntimeTestLayer";
import type { ConversationSnapshot } from "../../../src/ipc/session-contract";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { sessionAssistantThreadPath } from "../../../src/domain/discussion-sessions/discussion-session-data";
import { defaultApplicationState } from "../../../src/domain/application/application-data";

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

const makeLayer = (options: { readonly assistant?: boolean } = {}) => {
  let record: DiscussionSessionRecord = {
    id: "thread-1",
    workingDirectory: "/project",
    parentSessionId: "parent-1",
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
    anchor: options.assistant
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
  const runtimeOptions: CakeSessionRuntimeOptions[] = [];
  const modelSelections: Array<{ provider: string; modelId: string }> = [];
  const controlInvocations: unknown[] = [];
  let stagedProjections = 0;
  const prompts: Parameters<CakeSessionRuntime["prompt"]>[] = [];
  const queueOperations: string[] = [];
  let preparedContexts = 0;
  let parentIndexRefreshes = 0;
  const runtime = (options: CakeSessionRuntimeOptions): CakeSessionRuntime => {
    const sessionId = options.sessionId ?? "generated";
    const sessionFile = options.auxiliary
      ? `/reviews/${sessionId}.jsonl`
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
      snapshot: async () => makeSnapshot(sessionId, sessionFile),
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
      compact: async () => undefined,
      abort: async () => undefined,
      setModel: async (provider, modelId) => {
        modelSelections.push({ provider, modelId });
      },
      setThinkingLevel: async () => undefined,
      applyConfiguration: async () => undefined,
      setPiSetting: async () => undefined,
      recordReviewRun: () => undefined,
      login: async () => undefined,
      logout: async () => undefined,
      rename: async () => undefined,
      fork: async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl", artifactPointers: [] }),
      toolCompact: async () => ({ sessionId: "toolCompact", sessionFile: "/toolCompact.jsonl" }),
      navigate: async () => undefined,
      dispose: () => undefined,
    };
  };
  const adapter: CakeSessionRuntimesAdapter = {
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
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
    create: () => Effect.succeed(record),
    ensure: () => Effect.succeed(record),
    linkSidecar: (current, sidecar) =>
      Effect.sync(() => {
        record = {
          ...current,
          sidecarSessionId: sidecar.sessionId,
          sidecarSessionFile: sidecar.sessionFile,
        };
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
    refreshParentIndex: () =>
      Effect.sync(() => {
        parentIndexRefreshes += 1;
      }),
  });
  const projectRuntime = makeProjectSessionRuntimeTestLayer();
  return {
    layer: Layer.mergeAll(
      makeCakeSessionRuntimesLayer(adapter),
      discussions,
      projectRuntime,
      Layer.mock(RendererRequestCoordinator, {
        requestProjectControl: (sessionId, invocation) =>
          Effect.sync(() => {
            controlInvocations.push({ sessionId, invocation });
            return { ok: true };
          }),
      }),
      Layer.mock(ApplicationState, {
        snapshot: () => ({
          ...defaultApplicationState(),
          utilityModel: {
            provider: "google",
            modelId: "gemini-3.5-flash-lite",
            thinkingLevel: "low",
          },
          projects: [
            {
              path: "/project",
              name: "Project",
              addedAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          trustedProjectPaths: ["/project"],
        }),
      }),
    ),
    options: runtimeOptions,
    prompts,
    queueOperations,
    preparedContexts: () => preparedContexts,
    parentIndexRefreshes: () => parentIndexRefreshes,
    stagedProjections: () => stagedProjections,
    modelSelections,
    controlInvocations,
    record: () => record,
  };
};

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
        assert.deepEqual(sidecar.tools, ["read", "bash", "cake"]);
        assert.match(sidecar.additionalSystemPrompt ?? "", /Session Assistant attached to/);
        assert.match(sidecar.additionalSystemPrompt ?? "", /run shell commands with the bash tool/);
        assert.match(sidecar.additionalSystemPrompt ?? "", /sessions\.open/);
        assert.deepEqual(fixture.modelSelections.at(-1), {
          provider: "google",
          modelId: "gemini-3.5-flash-lite",
        });

        // The control gateway reaches the parent's renderer-owned application control.
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
