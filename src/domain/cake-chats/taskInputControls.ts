import { Effect, Option, Schema } from "effect";
import { AppWorkspaceView } from "../../contracts/application/app-workspace-view";
import { messageRefsSchema } from "../../contracts/conversations/message-reference";
import { appendMessageReferences } from "../../contracts/conversations/message-reference-forwarding";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { SessionMessageDeliveryOptions } from "../../contracts/conversations/session-message-delivery";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { jsonObjectSchema, type JsonValue } from "../../contracts/serialization/json-contract";
import type { AttachmentUploadError } from "../../contracts/filesystem/attachment-uploads-errors";

const ForwardArguments = Schema.Struct({
  messageRefs: messageRefsSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  inputRefs: inputRefsSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  sessionId: Schema.optionalKey(Schema.String),
});
const SessionPointer = Schema.Struct({ sessionId: Schema.String.check(Schema.isUUID(4)) });
const SafeSessionMetadata = Schema.Struct({
  ...SessionPointer.fields,
  ok: Schema.optionalKey(Schema.Boolean),
  command: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(
    Schema.Literals([
      "started",
      "accepted",
      "queued",
      "stopping",
      "renamed",
      "resolved",
      "running",
      "idle",
      "stopped",
      "done",
      "failed",
      "interrupted",
      "needs-you",
      "unread",
      "draft",
    ]),
  ),
  workspacePath: Schema.optionalKey(Schema.String),
  resolved: Schema.optionalKey(Schema.Boolean),
  deepLink: Schema.optionalKey(Schema.String),
  lifecycle: Schema.optionalKey(Schema.Literals(["active", "resolved", "draft"])),
  outcome: Schema.optionalKey(
    Schema.Literals([
      "complete",
      "completed",
      "failed",
      "aborted",
      "done",
      "stopped",
      "blocked",
      "interrupted",
      "ready",
      "investigation",
    ]),
  ),
  draft: Schema.optionalKey(Schema.Boolean),
  familyId: Schema.optionalKey(Schema.String),
  familyParentSessionId: Schema.optionalKey(Schema.String),
  familyRootSessionId: Schema.optionalKey(Schema.String),
});

/** The global model sees IDs. Only this trusted boundary can mint recipient grants. */
export const forwardTaskInputControl = Effect.fn("CakeChats.forwardTaskInputControl")(function* (
  ownerSessionId: string,
  invocation: { readonly name: string; readonly arguments: JsonValue },
) {
  if (invocation.name === "sessions.send" || invocation.name === "sessions.reply")
    yield* Schema.decodeUnknownEffect(SessionMessageDeliveryOptions)(invocation.arguments);
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
  const field = invocation.name === "sessions.create" ? "initialPrompt" : "text";
  const text = args[field];
  const argumentsValue = { ...args, inputRefs: [...inputRefs] };
  if (selection.messageRefs.length) {
    const original = yield* Schema.decodeUnknownEffect(Schema.String)(text);
    return {
      ...invocation,
      arguments: {
        ...argumentsValue,
        [field]: appendMessageReferences(original, selection.messageRefs),
      },
    };
  }
  return { ...invocation, arguments: argumentsValue };
});

/** Drop content-bearing projections and generated names before tool results enter Pi. */
export const safeCoordinatorProjection = Effect.fn("CakeChats.safeCoordinatorProjection")(
  function* (
    value: JsonValue,
  ): Effect.fn.Return<JsonValue, AttachmentUploadError, TaskInputStorage> {
    if (Array.isArray(value))
      return yield* Effect.forEach(value, (item) => safeCoordinatorProjection(item));
    if (!Schema.is(jsonObjectSchema)(value)) return value;
    // Explicit window orientation is visible UI metadata, not task transcript content.
    // Preserve only its closed metadata contract while applying existing protection to
    // selection/layout and all other fields. Never exempt arbitrary session records.
    if (
      value.ok === true &&
      value.command === "app.state" &&
      Schema.is(jsonObjectSchema)(value.state)
    ) {
      const { workspaceView, ...state } = Schema.decodeUnknownSync(jsonObjectSchema)(value.state);
      const safe = yield* safeCoordinatorProjection(state);
      const view = Schema.decodeUnknownOption(AppWorkspaceView)(workspaceView);
      return {
        ok: true,
        command: "app.state",
        state: {
          ...Schema.decodeUnknownSync(jsonObjectSchema)(safe),
          ...(Option.isSome(view) ? { workspaceView: view.value } : null),
        },
      };
    }
    const inputs = yield* TaskInputStorage;
    const pointer = Schema.decodeUnknownOption(SessionPointer)(value);
    if (Option.isSome(pointer) && (yield* inputs.isRecipient(pointer.value.sessionId))) {
      // Validate each allowed metadata field independently: one content-derived/invalid
      // field must not discard an otherwise valid identity, deep link or lifecycle.
      const metadata = Object.fromEntries(
        Object.entries(SafeSessionMetadata.fields).flatMap(([key, schema]) => {
          const field = value[key];
          return field !== undefined && Schema.is(schema)(field) ? [[key, field]] : [];
        }),
      );
      return { ...metadata, title: "Task session" };
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
