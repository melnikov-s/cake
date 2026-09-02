import { Context, Effect, Layer, Schema } from "effect";
import {
  PiAgentResourceContext,
  PiAgentResourcesError,
  PiAgentPromptResourcesSnapshot,
  PiAgentResourcesSnapshot,
  type PiAgentPromptResourcesSnapshot as PiAgentPromptResourcesSnapshotValue,
  type PiAgentResourceContext as PiAgentResourceContextValue,
  type PiAgentResourcesSnapshot as PiAgentResourcesSnapshotValue,
} from "./agent-resource-data";

export interface PiAgentResourcesAdapter {
  readonly load: (context: PiAgentResourceContextValue) => Effect.Effect<unknown, unknown>;
  readonly loadPromptResources: (
    context: PiAgentResourceContextValue,
  ) => Effect.Effect<unknown, unknown>;
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
    readonly loadPromptResources: (
      context: PiAgentResourceContextValue,
    ) => Effect.Effect<PiAgentPromptResourcesSnapshotValue, PiAgentResourcesError>;
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
    const snapshot = yield* adapter
      .load(decodedContext)
      .pipe(
        Effect.mapError(
          (cause) => new PiAgentResourcesError({ operation, message: messageOf(cause) }),
        ),
      );
    return yield* Schema.decodeUnknownEffect(PiAgentResourcesSnapshot)(snapshot).pipe(
      Effect.mapError((cause) => new PiAgentResourcesError({ operation, message: cause.message })),
    );
  });

  return PiAgentResources.of({
    load: (context) => run("load", context),
    reload: (context) => run("reload", context),
    loadPromptResources: Effect.fn("PiAgentResources.loadPromptResources")(function* (context) {
      const operation = "loadPromptResources" as const;
      const decodedContext = yield* Schema.decodeUnknownEffect(PiAgentResourceContext)(
        context,
      ).pipe(
        Effect.mapError(
          (cause) => new PiAgentResourcesError({ operation, message: cause.message }),
        ),
      );
      const snapshot = yield* adapter
        .loadPromptResources(decodedContext)
        .pipe(
          Effect.mapError(
            (cause) => new PiAgentResourcesError({ operation, message: messageOf(cause) }),
          ),
        );
      return yield* Schema.decodeUnknownEffect(PiAgentPromptResourcesSnapshot)(snapshot).pipe(
        Effect.mapError(
          (cause) => new PiAgentResourcesError({ operation, message: cause.message }),
        ),
      );
    }),
  });
};

export const makePiAgentResourcesLayer = (adapter: PiAgentResourcesAdapter) =>
  Layer.succeed(PiAgentResources)(makePiAgentResources(adapter));
