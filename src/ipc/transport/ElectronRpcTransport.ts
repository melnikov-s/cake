import { Schema } from "effect";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

const requestId = Schema.Union([Schema.String, Schema.Number]);
const headers = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

const request = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: requestId,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers,
  isNotification: Schema.optional(Schema.Literal(true)),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean),
});

const FromRendererRpcMessage = Schema.Union([
  request,
  Schema.Struct({ _tag: Schema.Literal("Ack"), requestId }),
  Schema.Struct({ _tag: Schema.Literal("Interrupt"), requestId }),
  Schema.Struct({ _tag: Schema.Literal("Eof") }),
  Schema.Struct({ _tag: Schema.Literal("Ping") }),
]);

const FromMainRpcMessage = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Chunk"),
    requestId,
    values: Schema.NonEmptyArray(Schema.Unknown),
  }),
  Schema.Struct({ _tag: Schema.Literal("Exit"), requestId, exit: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.Literal("Defect"), defect: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.Literal("Pong") }),
]);

const decodeRendererMessage = Schema.decodeUnknownSync(FromRendererRpcMessage);
const decodeMainMessage = Schema.decodeUnknownSync(FromMainRpcMessage);

export const parseRendererRpcMessage = (input: unknown): FromClientEncoded => {
  // SAFETY: the shared Effect Schema decodes every field in the RPC transport envelope.
  return decodeRendererMessage(input) as FromClientEncoded;
};

export const parseMainRpcMessage = (input: unknown): FromServerEncoded => {
  // SAFETY: the shared Effect Schema decodes every field in the RPC transport envelope.
  return decodeMainMessage(input) as FromServerEncoded;
};

export interface ElectronRpcTransport {
  readonly send: (message: FromClientEncoded) => void;
  readonly subscribe: (listener: (message: FromServerEncoded) => void) => () => void;
}
