import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";

export class FoundationFailure extends Schema.TaggedError<FoundationFailure>()(
  "FoundationFailure",
  {
    message: Schema.String,
  },
) {}

export const CakeRpc = RpcGroup.make(
  Rpc.make("application.getHomeDirectory", {
    success: Schema.String,
  }),
  Rpc.make("foundation.typedFailure", {
    error: FoundationFailure,
  }),
  Rpc.make("foundation.stream", {
    payload: {
      count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    },
    success: Schema.Int,
    stream: true,
  }),
  Rpc.make("foundation.delay", {
    payload: {
      durationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
    },
  }),
  Rpc.make("foundation.activeRequests", {
    success: Schema.Struct({
      delays: Schema.Int,
      streams: Schema.Int,
    }),
  }),
).middleware(RendererConnectionMiddleware);
