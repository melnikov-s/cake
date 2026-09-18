import { Effect, Layer, Queue, Stream } from "effect";
import { collectGarbage } from "../../domain/artifacts/artifactGarbageCollection";
import { ArtifactGarbageCollector } from "./ArtifactGarbageCollector";

/** Owns one process-lifetime, serialized, coalescing artifact maintenance worker. */
export const ArtifactGarbageCollectorLive = Layer.effect(
  ArtifactGarbageCollector,
  Effect.gen(function* () {
    const requests = yield* Queue.dropping<void>(1);
    const runCollection = collectGarbage().pipe(
      Effect.tapError((error) => Effect.logWarning("Artifact garbage collection failed", error)),
      Effect.ignore,
    );
    yield* Stream.fromQueue(requests).pipe(
      Stream.runForEach(() => runCollection),
      Effect.forkScoped,
    );
    const request = Effect.fn("ArtifactGarbageCollector.request")(() =>
      Queue.offer(requests, undefined).pipe(Effect.asVoid),
    );
    // Startup maintenance uses the same serialized best-effort path as lifecycle requests.
    yield* request();
    return ArtifactGarbageCollector.of({ request });
  }),
);
