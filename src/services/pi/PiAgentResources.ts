import { Context, Effect, Layer, Schema } from "effect";
import {
  PiAgentResourceContext,
  PiAgentResourcesError,
  PiAgentResourcesSnapshot,
  type PiAgentResourceContext as PiAgentResourceContextValue,
  type PiAgentResourcesSnapshot as PiAgentResourcesSnapshotValue,
} from "./agent-resource-data";

export interface PiAgentResourcesAdapter {
  readonly load: (
    context: PiAgentResourceContextValue,
    signal: AbortSignal,
  ) => Promise<PiAgentResourcesSnapshotValue>;
}

export class PiAgentResources extends Context.Service<
  PiAgentResources,
  {
    readonly load: (
      context: PiAgentResourceContextValue,
    ) => Effect.Effect<PiAgentResourcesSnapshotValue, PiAgentResourcesError>;
    readonly reload: (
      context: PiAgentResourceContextValue,
    ) => Effect.Effect<PiAgentResourcesSnapshotValue, PiAgentResourcesError>;
  }
>()("cake/services/pi/PiAgentResources") {}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makePiAgentResources = (
  adapter: PiAgentResourcesAdapter,
): PiAgentResources["Service"] => {
  const run = Effect.fn("PiAgentResources.run")(function* (
    operation: "load" | "reload",
    context: PiAgentResourceContextValue,
  ) {
    const decodedContext = yield* Schema.decodeUnknownEffect(PiAgentResourceContext)(context).pipe(
      Effect.mapError((cause) => new PiAgentResourcesError({ operation, message: cause.message })),
    );
    const snapshot = yield* Effect.tryPromise({
      try: (signal) => adapter.load(decodedContext, signal),
      catch: (cause) => new PiAgentResourcesError({ operation, message: messageOf(cause) }),
    });
    return yield* Schema.decodeUnknownEffect(PiAgentResourcesSnapshot)(snapshot).pipe(
      Effect.mapError((cause) => new PiAgentResourcesError({ operation, message: cause.message })),
    );
  });

  return PiAgentResources.of({
    load: (context) => run("load", context),
    reload: (context) => run("reload", context),
  });
};

export const makePiAgentResourcesLayer = (adapter: PiAgentResourcesAdapter) =>
  Layer.succeed(PiAgentResources)(makePiAgentResources(adapter));
