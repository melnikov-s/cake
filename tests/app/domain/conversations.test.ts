import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { ConversationUpdate } from "../../../src/contracts/conversations/conversation-data";
import { describe, expect } from "vitest";
import {
  deliver,
  deliverWhenAvailable,
  observe,
  projectAttachments,
  projectQueuedMessages,
  projectPreviewSnapshot,
} from "../../../src/domain/conversations/conversations";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import {
  CakeSessionRuntimes,
  type CakeSessionHandle,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const snapshot = (streaming: boolean): ConversationSnapshot => ({
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

const makeHandle = (deliveries: string[], isStreaming: () => boolean): CakeSessionHandle => ({
  currentTurnIds: () => Effect.succeed([]),
  exportSideChatHistory: () => Effect.die("Unexpected history export"),
  importSideChatHistory: () => Effect.die("Unexpected history import"),
  recover: () => Effect.die("Unexpected recover"),
  submit: () => Effect.die("Unexpected submit"),
  profile: "ProjectSession",
  updates: Stream.empty,
  snapshot: () => Effect.succeed(snapshot(isStreaming())),
  prompt: () => Effect.sync(() => deliveries.push("prompt")).pipe(Effect.as("prompt-turn")),
  steer: () => Effect.sync(() => deliveries.push("steer")).pipe(Effect.as("steer-turn")),
  followUp: () => Effect.sync(() => deliveries.push("follow-up")).pipe(Effect.as("follow-up-turn")),
  listQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
  pendingMessages: () => Effect.succeed({ items: [] }),
  reorderPendingMessage: () => Effect.succeed({ items: [] }),
  clearQueue: () => Effect.succeed({ steering: [], followUp: [] }),
  cancelSteering: () => Effect.succeed({ steering: [], followUp: [] }),
  removeQueuedMessage: () => Effect.succeed({ steering: [], followUp: [] }),
  steerQueuedMessage: () => Effect.succeed({ steering: [], followUp: [] }),
  sendQueuedMessageNow: () => Effect.succeed({ steering: [], followUp: [] }),
  editMessage: () => Effect.void,
  setUserMessageMarkdown: () => Effect.void,
  abort: () => Effect.void,
  executeCommand: () => Effect.succeed(undefined),
  applyConfiguration: () => Effect.void,
  setModel: () => Effect.void,
  setFastMode: () => Effect.void,
  setThinkingLevel: () => Effect.void,
  setPiSetting: () => Effect.void,
  navigate: () => Effect.void,
  queueCommand: () => Effect.die("Unexpected queueCommand"),
  inspectSession: () => Effect.die("Unexpected inspectSession"),
  compact: () => Effect.void,
  compactMemory: () => Effect.die("Unexpected compactMemory"),
  compactIfIdle: () => Effect.die("Unexpected compactIfIdle"),
  rename: () => Effect.void,
  fork: () => Effect.die("Unexpected fork"),
  toolCompact: () => Effect.die("Unexpected toolCompact"),
  reviewParentContext: () => Effect.die("Unexpected parent-context request"),
  notifySubagentCompletion: () => Effect.void,
  reload: () => Effect.void,
  publishSessionChanged: () => Effect.void,
  callCakeOperation: () => Effect.succeed(null),
  dispatchExtensionCompanionAction: () => Effect.void,
});

describe("conversation domain", () => {
  it.each(["model", "currentModel"] as const)(
    "projects the saved %s identity before runtime initialization",
    (field) => {
      const preview = projectPreviewSnapshot({
        sessionId: "session-1",
        sessionFile: "/sessions/session-1.jsonl",
        parts: [],
        [field]: { provider: "openai", modelId: "saved-model" },
      });
      expect(preview.model).toEqual({ provider: "openai", id: "saved-model", name: "saved-model" });
      expect(preview.models).toEqual([]);
    },
  );

  it("does not invent a model for history without a persisted selection", () => {
    expect(
      projectPreviewSnapshot({
        sessionId: "session-1",
        sessionFile: "/sessions/session-1.jsonl",
        parts: [],
      }).model,
    ).toBeUndefined();
  });

  it.effect("encodes snapshots with and without selected preset guidance across RPC", () =>
    Effect.gen(function* () {
      const preset = { id: "00000000-0000-4000-8000-000000000001", prompt: "Be concise." };
      for (const selected of [undefined, preset]) {
        const handle = {
          ...makeHandle([], () => false),
          updates: Stream.make({
            _tag: "Snapshot" as const,
            snapshot: { ...snapshot(false), preset: selected },
          }),
        };
        const updates = yield* Stream.runCollect(observe(handle));
        const update = updates[0]!;
        yield* Schema.encodeEffect(ConversationUpdate)(update);
        assert.equal(update._tag, "Snapshot");
        if (update._tag === "Snapshot") {
          assert.deepEqual(update.snapshot.preset, selected);
          assert.equal(Object.hasOwn(update.snapshot, "preset"), selected !== undefined);
        }
      }
    }),
  );
  it("keeps a stored file's input reference so the transcript can reopen the original", () => {
    const inputReference = {
      kind: "input" as const,
      id: "20000000-0000-4000-8000-000000000001",
      name: "Pasted text · 90 lines",
      mimeType: "text/plain",
      byteLength: 700,
    };
    expect(
      projectAttachments([
        { kind: "file", name: inputReference.name, path: "/inputs/input.txt", inputReference },
        { kind: "file", name: "plain.md", path: "/project/plain.md" },
      ]),
    ).toEqual([
      { kind: "file", name: inputReference.name, path: "/inputs/input.txt", inputReference },
      { kind: "file", name: "plain.md", path: "/project/plain.md" },
    ]);
  });

  it("maps Pi queue state into a detached Cake conversation value", () => {
    const piQueue = { steering: ["change direction"], followUp: ["do this next"] };

    const projected = projectQueuedMessages(piQueue);
    piQueue.steering.push("later");

    expect(projected).toEqual({
      steering: ["change direction"],
      followUp: ["do this next"],
    });
  });

  it.effect("acquires at use time and preserves each Pi delivery mode", () =>
    Effect.gen(function* () {
      const deliveries: string[] = [];
      let acquisitions = 0;
      const handle = makeHandle(deliveries, () => false);
      const acquire = () =>
        Effect.sync(() => {
          acquisitions += 1;
          return handle;
        });

      assert.equal(yield* deliver(acquire(), "prompt", "one", [], false), "prompt-turn");
      assert.equal(yield* deliver(acquire(), "steer", "two", [], false), "steer-turn");
      assert.equal(yield* deliver(acquire(), "follow-up", "three", [], false), "follow-up-turn");
      assert.equal(acquisitions, 3);
      assert.deepEqual(deliveries, ["prompt", "steer", "follow-up"]);
    }),
  );

  it.effect("queues busy automatic delivery as a follow-up", () =>
    Effect.gen(function* () {
      const deliveries: string[] = [];
      const handle = makeHandle(deliveries, () => true);

      const turnId = yield* deliverWhenAvailable(Effect.succeed(handle), "next", [], false);

      assert.equal(turnId, "follow-up-turn");
      assert.deepEqual(deliveries, ["follow-up"]);
    }),
  );

  it.effect.each(
    [false, true].flatMap((pendingReport) =>
      (["prompt", "follow-up", "steer"] as const).map((delivery) => ({ pendingReport, delivery })),
    ),
  )(
    "preserves $delivery during an active report response (pendingReport=$pendingReport)",
    ({ delivery, pendingReport }) => {
      const deliveries: string[] = [];
      const acceptedTurnId = "00000000-0000-4000-8000-000000000001";
      const accept = (lane: string) =>
        Effect.sync(() => {
          deliveries.push(lane);
          return acceptedTurnId;
        });
      const handle: CakeSessionHandle = {
        ...makeHandle(deliveries, () => true),
        profile: "CakeChatSession",
        prompt: () => accept("prompt"),
        steer: () => accept("steer"),
        followUp: () => accept("follow-up"),
        snapshot: () =>
          Effect.succeed({
            ...snapshot(true),
            sessionId: CAKE_CHAT_SESSION_ID,
            parts: [
              {
                id: "active-report",
                kind: "text",
                role: "user",
                text: "Worker result",
                status: "complete",
                crossSession: {
                  version: 1,
                  messageId: "active-report",
                  threadId: "active-report",
                  sequence: 1,
                  expectsResponse: false,
                  sender: { sessionId: "worker", title: "Worker", kind: "project-session" },
                },
              },
            ],
          }),
        abort: () =>
          Effect.sync(() => {
            deliveries.push("abort");
          }),
        submit: (input) =>
          Effect.sync(() => {
            deliveries.push(input.delivery);
            assert.equal(input.internal?._tag, "UserWithReminders");
            assert.match(input.text, /Next question/);
            return acceptedTurnId;
          }),
      };
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        if (pendingReport)
          yield* storage.deferReferenceNotice({
            id: "pending-report",
            recipientSessionId: CAKE_CHAT_SESSION_ID,
            text: "Another result",
          });
        const turnId = yield* sessionChats.deliver(
          {
            sessionId: CAKE_CHAT_SESSION_ID,
            text: "Next question",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          delivery,
        );
        assert.equal(turnId, acceptedTurnId);
        // Queued input reaches the ordinary follow-up lane; steering is never rewritten or aborted.
        assert.deepEqual(deliveries, [delivery]);
        assert.equal((yield* handle.snapshot()).streaming, true);
        const references = (yield* storage.state()).deferredReferences ?? [];
        assert.equal(references.length, pendingReport ? 1 : 0);
        if (pendingReport) assert.equal(references[0]?.admissions, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            familyStorageHarness().layer,
            Layer.mock(ApplicationState, { snapshot: () => defaultApplicationState() }),
            Layer.mock(TaskInputStorage, {}),
            Layer.mock(CakeSessionRuntimes, { acquireSession: () => Effect.succeed(handle) }),
          ),
        ),
      );
    },
  );

  it.effect("explicit Stop and send-now retain their ordinary runtime semantics", () => {
    const calls: unknown[] = [];
    const handle: CakeSessionHandle = {
      ...makeHandle([], () => true),
      profile: "CakeChatSession",
      abort: (stop) =>
        Effect.sync(() => {
          calls.push({ stop });
        }),
      sendQueuedMessageNow: (partId) =>
        Effect.sync(() => {
          calls.push({ sendNow: partId });
          return { steering: [], followUp: [] };
        }),
    };
    return Effect.gen(function* () {
      const target = { sessionId: CAKE_CHAT_SESSION_ID };
      yield* sessionChats.sendQueuedMessageNow(target, "queued-user-input");
      yield* sessionChats.abort({ ...target, stop: { by: "user" } });
      assert.deepEqual(calls, [{ sendNow: "queued-user-input" }, { stop: { by: "user" } }]);
      assert.deepEqual((yield* (yield* SessionFamilyStorage).state()).boardDeliveryPaused, [
        CAKE_CHAT_SESSION_ID,
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          Layer.mock(CakeSessionRuntimes, { acquireSession: () => Effect.succeed(handle) }),
        ),
      ),
    );
  });

  it.effect("binds each shared delivery to the renderer that most recently submitted it", () => {
    const bindings: Array<{ target: unknown; connectionId: number }> = [];
    const handle = makeHandle([], () => false);
    return Effect.gen(function* () {
      yield* sessionChats.bindRenderer("session-1", 11);
      yield* sessionChats.bindRenderer("session-1", 22);

      assert.deepEqual(bindings, [
        { target: { _tag: "ProjectSession", sessionId: "session-1" }, connectionId: 11 },
        { target: { _tag: "ProjectSession", sessionId: "session-1" }, connectionId: 22 },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CakeSessionRuntimes, { acquireSession: () => Effect.succeed(handle) }),
          Layer.mock(RendererRequestCoordinator, {
            bind: (target, connectionId) =>
              Effect.sync(() => bindings.push({ target, connectionId })),
          }),
        ),
      ),
    );
  });

  it.effect("binds Cake Chat delivery with its assembled runtime profile", () => {
    const bindings: Array<{ target: unknown; connectionId: number }> = [];
    const handle = { ...makeHandle([], () => false), profile: "CakeChatSession" as const };
    return sessionChats.bindRenderer("cake-chat-1", 31).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          assert.deepEqual(bindings, [
            {
              target: { _tag: "CakeChatSession", sessionId: "cake-chat-1" },
              connectionId: 31,
            },
          ]),
        ),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CakeSessionRuntimes, { acquireSession: () => Effect.succeed(handle) }),
          Layer.mock(RendererRequestCoordinator, {
            bind: (target, connectionId) =>
              Effect.sync(() => bindings.push({ target, connectionId })),
          }),
        ),
      ),
    );
  });
});
