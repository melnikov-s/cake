import { Context, Effect, Layer, Schema } from "effect";
import { slashCommandSchema, type SessionSnapshot } from "../../ipc/session-contract";
import {
  PiAgentResourceContext,
  type PiAgentResourceContext as PiAgentResourceContextValue,
} from "./agent-resource-data";

export class PiCommandCatalogError extends Schema.TaggedError<PiCommandCatalogError>()(
  "PiCommandCatalogError",
  {
    message: Schema.String,
  },
) {}

export interface PiCommandCatalogAdapter {
  readonly load: (context: PiAgentResourceContextValue) => Effect.Effect<unknown, unknown>;
}

export class PiCommandCatalog extends Context.Service<
  PiCommandCatalog,
  {
    readonly load: (
      context: PiAgentResourceContextValue,
    ) => Effect.Effect<SessionSnapshot["commands"], PiCommandCatalogError>;
  }
>()("cake/services/pi/PiCommandCatalog") {}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makePiCommandCatalog = (
  adapter: PiCommandCatalogAdapter,
): PiCommandCatalog["Service"] =>
  PiCommandCatalog.of({
    load: Effect.fn("PiCommandCatalog.load")(function* (context) {
      const decodedContext = yield* Schema.decodeUnknownEffect(PiAgentResourceContext)(
        context,
      ).pipe(Effect.mapError((cause) => new PiCommandCatalogError({ message: cause.message })));
      const commands = yield* adapter
        .load(decodedContext)
        .pipe(Effect.mapError((cause) => new PiCommandCatalogError({ message: messageOf(cause) })));
      return yield* Schema.decodeUnknownEffect(Schema.Array(slashCommandSchema))(commands).pipe(
        Effect.mapError((cause) => new PiCommandCatalogError({ message: cause.message })),
      );
    }),
  });

export const makePiCommandCatalogLayer = (adapter: PiCommandCatalogAdapter) =>
  Layer.succeed(PiCommandCatalog)(makePiCommandCatalog(adapter));
