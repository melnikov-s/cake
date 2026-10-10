import { Effect, Option, Schema } from "effect";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { jsonObjectSchema, type JsonValue } from "../../ipc/json-contract";
import type { AttachmentUploadError } from "../../contracts/filesystem/attachment-uploads-errors";

const ForwardArguments = Schema.Struct({
  inputRefs: inputRefsSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  sessionId: Schema.optionalKey(Schema.String),
});
const SessionPointer = Schema.Struct({ sessionId: Schema.String.check(Schema.isUUID(4)) });
const SafeSessionMetadata = Schema.Struct({
  ...SessionPointer.fields,
  ok: Schema.optionalKey(Schema.Boolean),
  command: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(
    Schema.Literals(["started", "accepted", "queued", "stopping", "renamed", "resolved"]),
  ),
  workspacePath: Schema.optionalKey(Schema.String),
  resolved: Schema.optionalKey(Schema.Boolean),
});

/** The global model sees IDs. Only this trusted boundary can mint recipient grants. */
export const forwardTaskInputControl = Effect.fn("CakeChats.forwardTaskInputControl")(function* (
  ownerSessionId: string,
  invocation: { readonly name: string; readonly arguments: JsonValue },
) {
  if (invocation.name !== "sessions.create" && invocation.name !== "sessions.send")
    return invocation;
  const args = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(invocation.arguments);
  const selection = yield* Schema.decodeUnknownEffect(ForwardArguments)(args);
  const inputs = yield* TaskInputStorage;
  const inputRefs = yield* inputs.authorizeForward(
    ownerSessionId,
    selection.inputRefs,
    invocation.name === "sessions.send" ? selection.sessionId : undefined,
  );
  return { ...invocation, arguments: { ...args, inputRefs: [...inputRefs] } };
});

/** Drop content-bearing projections and generated names before tool results enter Pi. */
export const safeCoordinatorProjection = Effect.fn("CakeChats.safeCoordinatorProjection")(
  function* (
    value: JsonValue,
  ): Effect.fn.Return<JsonValue, AttachmentUploadError, TaskInputStorage> {
    if (Array.isArray(value))
      return yield* Effect.forEach(value, (item) => safeCoordinatorProjection(item));
    if (!Schema.is(jsonObjectSchema)(value)) return value;
    const inputs = yield* TaskInputStorage;
    const pointer = Schema.decodeUnknownOption(SessionPointer)(value);
    if (Option.isSome(pointer) && (yield* inputs.isRecipient(pointer.value.sessionId))) {
      const metadata = Schema.decodeUnknownOption(SafeSessionMetadata)(value);
      return {
        ...(Option.isSome(metadata) ? metadata.value : pointer.value),
        title: "Task session",
      };
    }
    let fields = Object.entries(value);
    const target = Schema.decodeUnknownOption(SessionPointer)(value.target);
    if (Option.isSome(target) && (yield* inputs.isRecipient(target.value.sessionId)))
      fields = fields.filter(([key]) => key !== "targetTitle");
    const entries = yield* Effect.forEach(fields, ([key, item]) =>
      safeCoordinatorProjection(item).pipe(Effect.map((safe) => [key, safe] as const)),
    );
    return Object.fromEntries(entries);
  },
);
