import { Effect } from "effect";
import { WindowStateStorage } from "../../services/storage/WindowStateStorage";
import { WindowStateRpc } from "../protocol/WindowStateRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

export const windowStateHandlers = WindowStateRpc.of({
  "windowState.respondFlush": ({ requestId, error }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      yield* (yield* RendererRequestCoordinator)
        .respondWindowStateFlush(connectionId, requestId, error)
        .pipe(Effect.mapError((failure) => failure.message));
    }),
  "windowState.load": () => Effect.flatMap(WindowStateStorage, (storage) => storage.load()),
  "windowState.save": ({ snapshot }) =>
    Effect.flatMap(WindowStateStorage, (storage) => storage.save(snapshot)),
});
