import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

declare const __CAKE_BUILD_ID__: string;
export const cakeBuildId =
  typeof __CAKE_BUILD_ID__ === "string" ? __CAKE_BUILD_ID__ : "development";
export class BackendConnectionError extends Schema.TaggedError<BackendConnectionError>()(
  "BackendConnectionError",
  { message: Schema.String },
) {}
export const BackendConnectionRpc = RpcGroup.make(
  Rpc.make("backendConnection.connect", {
    payload: { buildId: Schema.String },
    success: Schema.Struct({ buildId: Schema.String }),
    error: BackendConnectionError,
  }),
);
