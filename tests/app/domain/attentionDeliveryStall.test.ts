import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as projectTodoAttention from "../../../src/domain/projects/projectTodoAttention";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { DELIVERY_RUNTIME_TIMEOUT } from "../../../src/domain/conversations/deliveryDeadlines";
import { heldAttentionHarness, producer } from "../helpers/heldAttentionHarness";

// Recurrence: clicking a "Needs attention" item while Pi admission stalled held the single
// app-wide delivery lock, so every later send in every chat waited forever ("Churning").
describe("attention admission that never answers", () => {
  it.effect("cannot block another chat's send, and fails the click with a clear error", () => {
    const f = heldAttentionHarness();
    return Effect.gen(function* () {
      const item = yield* todos.create("/project", {
        title: "Release review",
        description: "Waiting on a decision",
        needsAttention: true,
        attentionReason: "Choose the release target",
        associations: [{ kind: "session", sessionId: producer, title: "Release review" }],
      });
      const entered = yield* Deferred.make<void>();
      f.state.beforeSubmit = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      const click = yield* projectTodoAttention
        .activate("/project", item.id, item.revision)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      f.state.beforeSubmit = undefined;

      const send = yield* sessionChats
        .deliver(
          {
            sessionId: CAKE_CHAT_SESSION_ID,
            text: "Unrelated question",
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          "prompt",
        )
        .pipe(Effect.scoped, Effect.forkChild);
      for (let turn = 0; turn < 200 && f.submissions.length === 0; turn++) yield* Effect.yieldNow;
      expect(f.submissions.map((input) => input.text)).toEqual([
        expect.stringContaining("Unrelated question"),
      ]);
      yield* Fiber.join(send);

      yield* TestClock.adjust(DELIVERY_RUNTIME_TIMEOUT);
      const failure = yield* Fiber.join(click);
      expect(failure.message).toBe(
        "The conversation did not accept this attention request in time. Try again.",
      );
      // Nothing was handed off, so the item still needs attention and can be clicked again.
      expect((yield* todos.read("/project", item.id)).needsAttention).toBe(true);
    }).pipe(Effect.provide(f.layer));
  });
});
