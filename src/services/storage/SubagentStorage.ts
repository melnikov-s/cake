import { Context, Effect, Layer, Path, Schema } from "effect";
import { ParentContinuation } from "../../contracts/conversations/parent-continuation";
import {
  ResolvedAgentModel,
  SubagentError,
  SubagentHandleId,
  SubagentStatus,
} from "../../contracts/subagents/subagent-data";
import { TaskInputReference } from "../../contracts/conversations/task-input";
import { RuntimeRecoveryInput } from "./RuntimeRecoveryStorage";
import { makeRecoveryRecordFiles } from "./internal/recoveryRecordFiles";

/** Worker identity, admission and delivery facts only. Pi owns all transcript content. */
export const SubagentRecord = Schema.Struct({
  handleId: SubagentHandleId,
  privateSessionId: Schema.String,
  /** Older recovery records use the configured worker root. */
  privateSessionDirectory: Schema.optionalKey(Schema.String),
  parentSessionId: Schema.String,
  parentProfile: Schema.Literals(["ProjectSession", "CakeChatSession"]),
  parentWorkingDirectory: Schema.String,
  parentSessionDirectory: Schema.String,
  anchorPartId: Schema.String,
  workingDirectory: Schema.String,
  projectPath: Schema.optionalKey(Schema.String),
  task: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
  allowMutations: Schema.Boolean,
  resolvedModel: ResolvedAgentModel,
  fastMode: Schema.Boolean,
  tools: Schema.Array(Schema.String),
  inputReferences: Schema.Array(TaskInputReference),
  messageReferences: Schema.Array(Schema.String),
  /** Absent in pre-intent recovery records. New admissions always persist the choice. */
  continuation: Schema.optionalKey(ParentContinuation),
  notifyOnCompletion: Schema.Boolean,
  completionId: Schema.String,
  completionDisposition: Schema.Literals(["pending", "waited", "notifying", "notified"]),
  status: SubagentStatus,
  error: Schema.optionalKey(Schema.String),
  failurePhase: Schema.optionalKey(Schema.Literal("start")),
  pendingInputs: Schema.Array(RuntimeRecoveryInput),
});
export interface SubagentRecord extends Schema.Schema.Type<typeof SubagentRecord> {}

/** Released identity/ownership only: no transcript, execution intent or capability grants. */
export const SubagentHistory = Schema.Struct({
  handleId: SubagentHandleId,
  privateSessionId: Schema.String,
  parentSessionId: Schema.String,
  parentWorkingDirectory: Schema.String,
  anchorPartId: Schema.String,
  workingDirectory: Schema.String,
  sessionDirectory: Schema.String,
  projectPath: Schema.optionalKey(Schema.String),
  task: Schema.String,
  status: SubagentStatus,
  resolvedModel: ResolvedAgentModel,
  fastMode: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  failurePhase: Schema.optionalKey(Schema.Literal("start")),
});
export interface SubagentHistory extends Schema.Schema.Type<typeof SubagentHistory> {}

interface HistoryRecords {
  readonly list: () => Effect.Effect<readonly SubagentHistory[], SubagentError>;
  readonly get: (
    handleId: SubagentHandleId,
  ) => Effect.Effect<SubagentHistory | undefined, SubagentError>;
  readonly update: (record: SubagentHistory) => Effect.Effect<void, SubagentError>;
  readonly remove: (handleId: SubagentHandleId) => Effect.Effect<void, SubagentError>;
}

export class SubagentStorage extends Context.Service<
  SubagentStorage,
  {
    readonly history: HistoryRecords;
    readonly list: () => Effect.Effect<readonly SubagentRecord[], SubagentError>;
    readonly get: (
      handleId: SubagentHandleId,
    ) => Effect.Effect<SubagentRecord | undefined, SubagentError>;
    readonly update: (record: SubagentRecord) => Effect.Effect<void, SubagentError>;
    readonly remove: (handleId: SubagentHandleId) => Effect.Effect<void, SubagentError>;
  }
>()("cake/services/storage/SubagentStorage") {}

const Document = Schema.Struct({ version: Schema.Literal(1), data: SubagentRecord });
const JsonDocument = Schema.fromJsonString(Document);

export const makeSubagentStorageLive = (stateDirectory: string) =>
  Layer.effect(
    SubagentStorage,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const records = yield* makeRecoveryRecordFiles({
        directory: path.join(stateDirectory, "private-workers"),
        idOf: (record: SubagentRecord) => record.handleId,
        decode: (content) =>
          Schema.decodeUnknownEffect(JsonDocument)(content).pipe(
            Effect.map((document) => document.data),
          ),
        encode: (record) => Schema.encodeEffect(JsonDocument)({ version: 1, data: record }),
        onError: (operation, file, cause) =>
          new SubagentError({
            operation: `storage.${operation}`,
            message: `Cannot ${operation} private-worker metadata at ${file}: ${String(cause)}. Restore this file and restart to recover the worker; its Pi transcript has not been replaced.`,
          }),
      });
      const HistoryDocument = Schema.fromJsonString(
        Schema.Struct({ version: Schema.Literal(1), data: SubagentHistory }),
      );
      const history = yield* makeRecoveryRecordFiles({
        directory: path.join(stateDirectory, "private-worker-history"),
        idOf: (record: SubagentHistory) => record.handleId,
        decode: (content) =>
          Schema.decodeUnknownEffect(HistoryDocument)(content).pipe(
            Effect.map((document) => document.data),
          ),
        encode: (record) => Schema.encodeEffect(HistoryDocument)({ version: 1, data: record }),
        onError: (operation, file, cause) =>
          new SubagentError({
            operation: `history.${operation}`,
            message: `Cannot ${operation} private-worker ownership at ${file}: ${String(cause)}. Restore this metadata to access or delete the owned Pi transcript.`,
          }),
      });
      return SubagentStorage.of({
        history,
        list: records.list,
        get: records.get,
        update: records.update,
        remove: records.remove,
      });
    }),
  );
