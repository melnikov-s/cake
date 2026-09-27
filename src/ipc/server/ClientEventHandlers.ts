import { Effect, Stream } from "effect";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const nativeTerminalEvents = () =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      return (yield* ClientEvents).terminals(connectionId);
    }),
  );
