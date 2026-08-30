import { Result, Schema } from "effect";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

const requestId = Schema.Union([Schema.String, Schema.Number]);
const headers = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

const request = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: requestId,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers,
  isNotification: Schema.optionalKey(Schema.Literal(true)),
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  sampled: Schema.optionalKey(Schema.Boolean),
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

const decodeRendererMessage = Schema.decodeUnknownResult(FromRendererRpcMessage);
const decodeMainMessage = Schema.decodeUnknownResult(FromMainRpcMessage);

export const parseRendererRpcMessage = (input: unknown) =>
  decodeRendererMessage(input).pipe(
    Result.map((message) => {
      // SAFETY: Effect's internal RpcMessage types do not export Schemas; the
      // mirror Schema above has validated every encoded client field.
      return message as FromClientEncoded;
    }),
  );

export const parseMainRpcMessage = (input: unknown) =>
  decodeMainMessage(input).pipe(
    Result.map((message) => {
      // SAFETY: Effect's internal RpcMessage types do not export Schemas; the
      // mirror Schema above has validated every encoded server field.
      return message as FromServerEncoded;
    }),
  );

export interface ElectronRpcTransport {
  readonly send: (message: FromClientEncoded) => void;
  readonly subscribe: (listener: (message: unknown) => void) => () => void;
}
