import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { NativePreviewError } from "../../services/browser/NativePreviewTunnels";

/** Trusted desktop registration only; never exposed by the backend or preview origin. */
export const NativePreviewInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  endpoint: Schema.String.check(Schema.isPattern(/^\/preview\/[a-f0-9]{64}\/$/)),
  secret: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export interface NativePreviewInput extends Schema.Schema.Type<typeof NativePreviewInput> {}

export const NativePreviewTunnelRpc = RpcGroup.make(
  Rpc.make("browser.open-native-preview", {
    payload: NativePreviewInput,
    success: Schema.Struct({
      endpoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    }),
    error: NativePreviewError,
  }),
);
