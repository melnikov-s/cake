import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe } from "vitest";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../../../src/services/session-catalogs/SessionCatalogChanges";

describe("SessionCatalogChanges", () => {
  it.effect("subscribes before consuming the initial metadata scan", () =>
    Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const change: SessionCatalogChange = {
        _tag: "CakeChatSessionChanged",
        sessionId: "session-1",
        resolved: false,
      };
      const initial = Stream.fromEffect(
        catalogs.publish(change).pipe(Effect.as("initial metadata" as const)),
      );

      const observed = Array.from(
        yield* catalogs.initialThenChanges(initial).pipe(Stream.take(2), Stream.runCollect),
      );

      assert.deepEqual(observed, ["initial metadata", change]);
    }).pipe(Effect.provide(SessionCatalogChanges.layer)),
  );
});
