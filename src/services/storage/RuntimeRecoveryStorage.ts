import { Context, Effect, Layer, Path, Schema } from "effect";
import { InternalInput } from "../../contracts/conversations/internal-input";
import { attachmentSchema } from "../../contracts/conversations/session-contract";
import { ConversationResponseMode } from "../../contracts/conversations/response-mode-reminders";
import { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { makeRecoveryRecordFiles } from "./internal/recoveryRecordFiles";

/** Durable handoff intent for an unconsumed or active input, not transcript history. */
export const RuntimeRecoveryInput = Schema.Struct({
  turnId: Schema.String,
  text: Schema.String,
  delivery: Schema.Literals(["prompt", "steer", "follow-up"]),
  attachments: Schema.Array(attachmentSchema),
  markdown: Schema.Boolean,
  internal: Schema.optionalKey(InternalInput),
  presentationMode: Schema.optionalKey(ProjectSessionPresentationMode),
  responseMode: Schema.optionalKey(ConversationResponseMode),
  automaticTitle: Schema.optionalKey(Schema.Boolean),
});
export interface RuntimeRecoveryInput extends Schema.Schema.Type<typeof RuntimeRecoveryInput> {}

export const RuntimeRecoveryRecord = Schema.Struct({
  sessionId: Schema.String,
  workingDirectory: Schema.String,
  sessionDirectory: Schema.String,
  profile: Schema.Literals(["ProjectSession", "CakeChatSession", "SubagentSession"]),
  transcriptPersisted: Schema.Boolean,
  inputs: Schema.Array(RuntimeRecoveryInput),
  state: Schema.Literals(["active", "blocked", "complete", "failed", "stopped"]),
  issue: Schema.optionalKey(Schema.String),
  deliveredDigestIds: Schema.optionalKey(Schema.Array(Schema.String)),
  canceledInputIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export interface RuntimeRecoveryRecord extends Schema.Schema.Type<typeof RuntimeRecoveryRecord> {}

export class RuntimeRecoveryStorageError extends Schema.TaggedError<RuntimeRecoveryStorageError>()(
  "RuntimeRecoveryStorageError",
  { operation: Schema.String, message: Schema.String },
) {}

export class RuntimeRecoveryStorage extends Context.Service<
  RuntimeRecoveryStorage,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<RuntimeRecoveryRecord>,
      RuntimeRecoveryStorageError
    >;
    readonly get: (
      sessionId: string,
    ) => Effect.Effect<RuntimeRecoveryRecord | undefined, RuntimeRecoveryStorageError>;
    readonly update: (
      record: RuntimeRecoveryRecord,
    ) => Effect.Effect<void, RuntimeRecoveryStorageError>;
    readonly remove: (sessionId: string) => Effect.Effect<void, RuntimeRecoveryStorageError>;
  }
>()("cake/services/storage/RuntimeRecoveryStorage") {}

const Document = Schema.Struct({ version: Schema.Literal(1), data: RuntimeRecoveryRecord });
const JsonDocument = Schema.fromJsonString(Document);

/** Pi remains transcript authority. One session's admission never rewrites another's journal. */
export const makeRuntimeRecoveryStorageLive = (stateDirectory: string) =>
  Layer.effect(
    RuntimeRecoveryStorage,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const records = yield* makeRecoveryRecordFiles({
        directory: path.join(stateDirectory, "recovery-intents"),
        idOf: (record: RuntimeRecoveryRecord) => record.sessionId,
        decode: (content) =>
          Schema.decodeUnknownEffect(JsonDocument)(content).pipe(
            Effect.map((document) => document.data),
          ),
        encode: (record) => Schema.encodeEffect(JsonDocument)({ version: 1, data: record }),
        onError: (operation, file, cause) =>
          new RuntimeRecoveryStorageError({
            operation,
            message: `Cannot ${operation} recovery metadata at ${file}: ${String(cause)}. Restore this file and retry; the saved Pi transcript has not been replaced.`,
          }),
      });
      return RuntimeRecoveryStorage.of(records);
    }),
  );
