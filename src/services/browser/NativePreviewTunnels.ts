import { Context, Schema, type Effect } from "effect";

export class NativePreviewError extends Schema.TaggedError<NativePreviewError>()(
  "NativePreviewError",
  { message: Schema.String },
) {}

/** Portable native-bridge contract. The implementation is Electron/Node-only and
 * must never be imported by shared RPC protocol or renderer code. */
export class NativePreviewTunnels extends Context.Service<
  NativePreviewTunnels,
  {
    readonly open: (
      connectionId: number,
      sessionId: string,
      lease: { endpoint: string; secret: string },
    ) => Effect.Effect<string, NativePreviewError>;
  }
>()("cake/services/browser/NativePreviewTunnels") {}
