import {
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { createCakeSessionRuntimeTurnController } from "../../../src/services/pi/runtime/cake-session-runtime-turn-controller";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import type { CakeSessionHandle } from "../../../src/services/pi/CakeSessionRuntimes";
import { durableModel } from "../../fixtures/durable-chat";
import { queuedPrompts } from "../../../src/renderer/lib/queued-prompts";
import { heldAttentionHarness } from "../helpers/heldAttentionHarness";
import { snapshot } from "../helpers/piRuntimeFixture";
import { addArtifactPresentationReminder } from "../../../src/contracts/artifacts/artifact-presentation-context";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";

const worker = "5c8a1e3b-7f2d-4b6e-9c0a-3d1f5e7b9a21";
const clientId = "0f4a7d2e-3b1c-4e5f-8a9b-1c2d3e4f5a6b";
const typed = "ok pause for a sec here, give me the lay of the land";

/** One finished worker result waiting in this chat's quiet session-updates inbox. */
const pendingDigest = Effect.fn("QueuedUserMessageIdentityTest.pendingDigest")(function* () {
  const storage = yield* SessionFamilyStorage;
  yield* storage.recordTurn({
    sessionId: worker,
    senderSessionId: CAKE_CHAT_SESSION_ID,
    turnId: "turn-1",
    requestMessageId: worker,
    threadId: worker,
    reported: false,
    outcome: "complete",
    resultDelivery: "notification",
  });
  yield* storage.digestNotice("turn-1", {
    id: "turn-1",
    // The harness runtime reports this session id; the digest belongs to it.
    coordinatorSessionId: snapshot.sessionId,
    sessionId: worker,
    title: "Get main fully green",
    status: "completed",
    summary: "All checks passed",
    reportedAt: "2026-01-01T00:00:00.000Z",
  });
});

const send = (text = typed) =>
  sessionChats
    .deliver(
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        text,
        attachments: [],
        renderUserMessageAsMarkdown: false,
        clientId,
      },
      "prompt",
    )
    .pipe(Effect.scoped);

/** Pi's real queue projection for a streaming session, fed the exact admitted input. */
function streamingQueue() {
  const followUp: string[] = [];
  const session = {
    model: durableModel,
    settingsManager: SettingsManager.inMemory(),
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    prompt: vi.fn(async (content: string) => {
      followUp.push(content);
    }),
    steer: vi.fn(async () => "queued" as const),
    followUp: vi.fn(async (content: string) => {
      followUp.push(content);
      return "queued" as const;
    }),
    abort: vi.fn(async () => undefined),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => followUp,
    clearQueue: () => ({ steering: [], followUp: followUp.splice(0) }),
    sessionManager: SessionManager.inMemory("/project"),
  } as unknown as AgentSession;
  return {
    followUp,
    controller: createCakeSessionRuntimeTurnController({
      session,
      isDisposed: () => false,
      allowInputCommands: true,
      beforeIdleTurn: async () => undefined,
      withResponseRetries: (operation) => operation(),
      cancelResponseRetries: vi.fn(),
      recovery: { onUserInput: vi.fn(), onAbort: vi.fn() },
      deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
      syncQueuedParts: vi.fn(),
      emitPart: vi.fn(),
      emitSnapshot: async () => undefined,
      emitSnapshotInBackground: vi.fn(),
      onAbortSettled: vi.fn(),
    }),
  };
}

const enqueue = async (
  queue: ReturnType<typeof streamingQueue>,
  input: Parameters<CakeSessionHandle["submit"]>[0],
) => {
  // The turn only settles when Pi runs it; admission is what puts it in the queue.
  void queue.controller
    .prompt(
      input.text,
      "follow-up",
      [],
      input.markdown,
      input.turnId,
      undefined,
      undefined,
      input.internal,
    )
    .catch(() => undefined);
  for (let turn = 0; turn < 20 && queue.followUp.length === 0; turn++) await Promise.resolve();
};

// Recurrence: in a busy Project Session the user's queued message reappeared as a second,
// editable row starting with "<system-reminder> Cake session updates…" while the original
// row stayed "Queueing…" forever, because the digest was prepended to the user's own entry.
describe("a person's queued message keeps its identity", () => {
  it.effect(
    "a pending session-updates digest leaves one queue row with the exact text and no reminder",
    () => {
      const f = heldAttentionHarness();
      f.state.streaming = true;
      return Effect.gen(function* () {
        yield* pendingDigest();
        const turnId = yield* send();
        expect(turnId).toBe(clientId);
        expect(f.submissions).toHaveLength(1);
        const [input] = f.submissions;
        // The model still gets the digest, as hidden context of the same input.
        expect(input!.text).toContain("Cake session updates");
        expect(input!.turnId).toBe(clientId);
        expect(input!.internal).toMatchObject({ _tag: "UserWithReminders", userText: typed });

        const queue = streamingQueue();
        yield* Effect.promise(() => enqueue(queue, input!));
        const parts = queue.controller.queuedParts();
        // The composer's queue: exactly one editable item with the person's exact words.
        const items = queuedPrompts(parts);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ text: typed, turnId: clientId, editable: true });
        expect(JSON.stringify(items)).not.toContain("system-reminder");
        expect(JSON.stringify(items)).not.toContain("Cake session updates");
        // The admitted digest is a separate, read-only context part, never a queue item.
        expect(parts.filter((part) => part.kind !== "context")).toHaveLength(1);
        const rows = parts.filter((part) => part.kind === "text");
        expect((yield* Effect.promise(() => queue.controller.pendingMessages())).items).toEqual([
          expect.objectContaining({ text: typed }),
        ]);

        // Editing changes only the person's words; the hidden digest still rides along.
        yield* Effect.promise(() =>
          queue.controller.updateQueuedMessage(rows[0]!.id, "actually, status first"),
        );
        expect(queuedPrompts(queue.controller.queuedParts())).toEqual([
          expect.objectContaining({ text: "actually, status first", turnId: clientId }),
        ]);
        expect(queue.followUp).toHaveLength(1);
        expect(queue.followUp[0]).toContain("Cake session updates");
        expect(queue.followUp[0]!.endsWith("actually, status first")).toBe(true);
        expect(queue.followUp[0]).not.toContain(typed);
      }).pipe(Effect.provide(f.layer));
    },
  );

  // Recurrence: after 1f83488d every composer send is UserWithReminders, and the application
  // view reminder follows the person's words. Editing that queued message failed with
  // "That queued message cannot be edited" because the edit assumed context only precedes them.
  it("edits a queued message whose application-view context follows the person's words", async () => {
    const text = addArtifactPresentationReminder(typed, null);
    const queue = streamingQueue();
    await enqueue(queue, {
      turnId: TurnId.make(clientId),
      delivery: "follow-up",
      text,
      attachments: [],
      markdown: false,
      internal: {
        _tag: "UserWithReminders",
        text,
        notices: [],
        reportNotices: [],
        updates: [],
        userText: typed,
      },
    });
    const rows = queue.controller.queuedParts().filter((part) => part.kind === "text");
    await queue.controller.updateQueuedMessage(rows[0]!.id, "actually, status first");
    expect(queuedPrompts(queue.controller.queuedParts())).toEqual([
      expect.objectContaining({ text: "actually, status first", turnId: clientId }),
    ]);
    // Pi's queue holds the person's words; the application view stays hidden model context.
    expect(queue.followUp).toEqual(["actually, status first"]);
  });

  it.effect("enqueue completes while another delivery holds this chat's delivery lock", () => {
    const f = heldAttentionHarness();
    f.state.streaming = true;
    return Effect.gen(function* () {
      yield* pendingDigest();
      const storage = yield* SessionFamilyStorage;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // A worker-result admission to the same chat that never finishes.
      const holder = yield* storage
        .withNoticeDelivery(
          CAKE_CHAT_SESSION_ID,
          "test.stuck-delivery",
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);

      const sending = yield* send().pipe(Effect.forkChild);
      for (let turn = 0; turn < 200 && f.submissions.length === 0; turn++) yield* Effect.yieldNow;
      expect(f.submissions).toHaveLength(1);
      expect(yield* Fiber.join(sending)).toBe(clientId);
      const [input] = f.submissions;
      // Admitted alone: exact words, and the digest stays pending for the next message.
      expect(input!.text).toBe(typed);
      expect(input!.turnId).toBe(clientId);
      expect((yield* storage.state()).coordinatorDigest).toHaveLength(1);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
    }).pipe(Effect.provide(f.layer));
  });
});
