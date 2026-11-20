import { it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import { events } from "../../../src/domain/widgets/widgetUpdates";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { changeFeedResync } from "../../../src/services/change-feeds/ChangeFeed";
import type { WidgetEvent } from "../../../src/contracts/widgets/widget-updates";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import { fakeClientEvents } from "../../helpers/fakes/clientEvents";

it.effect(
  "subscribes before ready, filters session invalidations, and never copies transcript contents",
  () =>
    Effect.gen(function* () {
      const received = yield* Queue.unbounded<WidgetEvent>();
      yield* events({ topic: "session.transcript.changed", filter: { sessionId: "one" } }, 7).pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(received)).toEqual({
        kind: "ready",
        topic: "session.transcript.changed",
      });
      const changes = yield* SessionCatalogChanges;
      yield* changes.publish({
        _tag: "CakeChatSessionChanged",
        sessionId: "other",
        resolved: false,
      });
      yield* changes.publish({
        _tag: "CakeChatSessionStatusChanged",
        sessionId: "one",
        resolved: false,
      });
      yield* changes.publish({ _tag: "CakeChatSessionChanged", sessionId: "one", resolved: false });
      expect(yield* Queue.take(received)).toEqual({
        kind: "change",
        topic: "session.transcript.changed",
        sessionId: "one",
        reason: "CakeChatSessionChanged",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SessionCatalogChanges.layer,
          fakeClientEvents({ sendTo: () => false, broadcast: () => {} }),
        ),
      ),
    ),
);

it.effect("exposes typed execution invalidations and a reconnect-ready signal", () =>
  Effect.gen(function* () {
    const id = decodeArtifactLineageId("job-widget");
    const result = yield* events(
      { topic: "artifact.execution.changed", filter: { lineageId: id } },
      7,
    ).pipe(Stream.runCollect);
    expect(result).toEqual([
      { kind: "ready", topic: "artifact.execution.changed" },
      { kind: "change", topic: "artifact.execution.changed", lineageId: id },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SessionCatalogChanges.layer,
        fakeClientEvents({
          sendTo: () => false,
          broadcast: () => {},
          artifacts: () =>
            Stream.make(
              { type: "renderer-events-ready" as const, channel: "artifacts" as const },
              {
                type: "artifact-execution-invalidated" as const,
                lineageId: decodeArtifactLineageId("other"),
              },
              {
                type: "artifact-execution-invalidated" as const,
                lineageId: decodeArtifactLineageId("job-widget"),
              },
            ),
        }),
      ),
    ),
  ),
);

it.effect("asks widgets to re-read current data after the catalog dropped their changes", () =>
  Effect.gen(function* () {
    const result = yield* events({ topic: "session.changed", filter: {} }, 7).pipe(
      Stream.runCollect,
    );
    expect(result).toEqual([
      { kind: "ready", topic: "session.changed" },
      { kind: "ready", topic: "session.changed" },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(SessionCatalogChanges, {
          initialThenChanges: (initial) =>
            initial.pipe(Stream.concat(Stream.make(changeFeedResync))),
        }),
        fakeClientEvents({ sendTo: () => false, broadcast: () => {} }),
      ),
    ),
  ),
);
