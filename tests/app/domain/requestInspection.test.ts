import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { inspect } from "../../../src/domain/cake-chats/requestInspection";
import { CakeChatDurable } from "../../../src/services/pi-durable/CakeChatDurable";
import { CAKE_CHAT_SESSION_ID } from "../../../src/ipc/cake-chat-data";
import { createRequestInspectionHistory } from "../../../src/services/pi-durable/request-inspection";

it.effect(
  "reads/clears the global identity without acquiring a runtime, and rejects project identities",
  () =>
    Effect.gen(function* () {
      const history = createRequestInspectionHistory();
      history
        .begin(CAKE_CHAT_SESSION_ID, { provider: "fixture", id: "fixture", api: "fixture" })
        .payload({ messages: [{ role: "system", content: "exact provider object" }] });
      const layer = Layer.mock(CakeChatDurable, {
        requestHistory: () => Effect.sync(history.list),
        requestPayload: (id) => Effect.sync(() => history.get(id)!),
        clearRequestHistory: () => Effect.sync(history.clear),
      }); // Any unexpected createRuntime/catalog/inspect call fails.
      const result = yield* inspect({ sessionId: CAKE_CHAT_SESSION_ID, action: "history" }).pipe(
        Effect.provide(layer),
      );
      expect(result.history.entries).toHaveLength(1);
      const payload = yield* inspect({
        sessionId: CAKE_CHAT_SESSION_ID,
        action: "payload",
        id: result.history.entries[0]!.id,
      }).pipe(Effect.provide(layer));
      expect(payload.payload?.raw).toContain("exact provider object");
      const project = yield* inspect({ sessionId: "project-session", action: "history" }).pipe(
        Effect.provide(layer),
        Effect.result,
      );
      expect(project._tag).toBe("Failure");
      const cleared = yield* inspect({ sessionId: CAKE_CHAT_SESSION_ID, action: "clear" }).pipe(
        Effect.provide(layer),
      );
      expect(cleared.history.entries).toEqual([]);
    }),
);
