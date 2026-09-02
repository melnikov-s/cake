import { Duration, Effect, Stream } from "effect";
import * as projects from "../../domain/projects";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { WindowStateStorage } from "../../services/storage/WindowStateStorage";
import { FoundationFailure, FoundationRpc } from "../protocol/FoundationRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const makeFoundationHandlers = (homeDirectory: string) => {
  let activeDelays = 0;
  let activeStreams = 0;

  return FoundationRpc.of({
    "application.getHomeDirectory": () =>
      Effect.gen(function* () {
        yield* RendererConnection;
        const access = yield* ProjectAccess;
        yield* access.allow(homeDirectory);
        return homeDirectory;
      }),
    "windowState.load": () => Effect.flatMap(WindowStateStorage, (storage) => storage.load()),
    "windowState.save": ({ snapshot }) =>
      Effect.flatMap(WindowStateStorage, (storage) => storage.save(snapshot)),
    "projects.observeCatalog": () => Stream.unwrap(projects.observeCatalog()),
    "application.observeEvents": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* RendererConnection;
          return (yield* NativeEvents).application(connection.connectionId);
        }),
      ),
    "foundation.typedFailure": () =>
      Effect.fail(new FoundationFailure({ message: "Schema-decoded foundation failure" })),
    "foundation.stream": ({ count, intervalMs }) =>
      Stream.fromEffect(
        Effect.acquireRelease(
          Effect.sync(() => {
            activeStreams += 1;
          }),
          () =>
            Effect.sync(() => {
              activeStreams -= 1;
            }),
        ),
      ).pipe(
        Stream.scoped,
        Stream.flatMap(() =>
          Stream.fromIterable(Array.from({ length: count }, (_, index) => index + 1)).pipe(
            Stream.mapEffect((value) =>
              Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.as(value)),
            ),
          ),
        ),
      ),
    "foundation.delay": ({ durationMs }) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          activeDelays += 1;
        }),
        () => Effect.sleep(Duration.millis(durationMs)),
        () =>
          Effect.sync(() => {
            activeDelays -= 1;
          }),
      ),
    "foundation.activeRequests": () =>
      Effect.succeed({ delays: activeDelays, streams: activeStreams }),
  });
};
