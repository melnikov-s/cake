import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { DELIVERY_RUNTIME_TIMEOUT } from "../../../src/domain/conversations/deliveryDeadlines";
import { heldAttentionHarness } from "../helpers/heldAttentionHarness";

const clientId = "0f4a7d2e-3b1c-4e5f-8a9b-1c2d3e4f5a6b";
const send = sessionChats
  .deliver(
    {
      sessionId: CAKE_CHAT_SESSION_ID,
      text: "Ship the fix",
      attachments: [],
      renderUserMessageAsMarkdown: false,
      clientId,
    },
    "prompt",
  )
  .pipe(Effect.scoped);

// Pi saves an input and starts its run together, so the deadline alone cannot tell a stuck
// admission from a slow one. The durable receipt decides what the person is told.
describe("a send that passes its delivery deadline", () => {
  it.effect("succeeds when Pi had already saved the input", () => {
    const f = heldAttentionHarness();
    return Effect.gen(function* () {
      f.state.beforeSubmit = Effect.sync(() => f.receipts.set(clientId, "pending")).pipe(
        Effect.andThen(Effect.never),
      );
      const delivery = yield* send.pipe(Effect.forkChild);
      yield* TestClock.adjust(DELIVERY_RUNTIME_TIMEOUT);
      expect(yield* Fiber.join(delivery)).toBe(clientId);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("fails naming the step, session and turn when nothing was saved", () => {
    const f = heldAttentionHarness();
    return Effect.gen(function* () {
      f.state.beforeSubmit = Effect.never;
      const delivery = yield* send.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(DELIVERY_RUNTIME_TIMEOUT);
      const failure = yield* Fiber.join(delivery);
      expect(failure.message).toContain("Cake could not hand this message to the agent");
      expect(failure.message).toContain("Pi admission did not answer within 30 seconds");
      expect(failure.message).toContain(`session ${CAKE_CHAT_SESSION_ID}`);
      expect(failure.message).toContain(`turn ${clientId}`);
    }).pipe(Effect.provide(f.layer));
  });
});
