import { Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import {
  CakeSessionIdentity,
  ConversationEvent,
  ConversationSnapshot,
  SessionChatConfiguration,
  SessionChatPromptInput,
} from "../conversations/conversation-data";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const CakeControlTool = Schema.Struct({
  command: Schema.String,
  topic: Schema.String,
  summary: Schema.String,
  guidance: Schema.optionalKey(Schema.Array(Schema.String)),
  parameters: Schema.Record(Schema.String, Schema.Json),
  examples: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
        description: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  result: Schema.optionalKey(Schema.String),
  limitations: Schema.optionalKey(Schema.Array(Schema.String)),
});
export interface CakeControlTool extends Schema.Schema.Type<typeof CakeControlTool> {}

export const CakeChatSummary = Schema.Struct({
  sessionId: boundedId,
  title: Schema.String.check(Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH)),
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  messageCount: Schema.Int,
  parentSessionId: Schema.optionalKey(boundedId),
  resolved: Schema.Boolean,
});
export interface CakeChatSummary extends Schema.Schema.Type<typeof CakeChatSummary> {}

export const CakeChatCatalogQuery = Schema.Union([
  Schema.Struct({ resolved: Schema.Literal(false) }),
  Schema.Struct({
    resolved: Schema.Literal(true),
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type CakeChatCatalogQuery = Schema.Schema.Type<typeof CakeChatCatalogQuery>;

export const CakeChatPreview = Schema.Struct({
  sessionId: boundedId,
  sessionFile: Schema.String,
  parts: Schema.Array(Schema.Json),
  resolved: Schema.Boolean,
});
export interface CakeChatPreview extends Schema.Schema.Type<typeof CakeChatPreview> {}

export const CakeChatSnapshot = Schema.Struct({
  identity: CakeSessionIdentity,
  resolved: Schema.Boolean,
  conversation: ConversationSnapshot,
});
export interface CakeChatSnapshot extends Schema.Schema.Type<typeof CakeChatSnapshot> {}

export const CakeChatControlRequest = Schema.TaggedStruct("ControlRequested", {
  sessionId: boundedId,
  controlRequestId: Schema.String.check(Schema.isUUID(4)),
  invocation: Schema.Struct({
    name: Schema.String,
    arguments: Schema.Json,
  }),
});
export interface CakeChatControlRequest extends Schema.Schema.Type<typeof CakeChatControlRequest> {}

export const CakeChatEvent = Schema.Union([ConversationEvent, CakeChatControlRequest]);
export type CakeChatEvent = Schema.Schema.Type<typeof CakeChatEvent>;

export const CakeChatUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, snapshot: CakeChatSnapshot },
  Event: { revision: Schema.Int, sessionId: boundedId, event: CakeChatEvent },
});
export type CakeChatUpdate = Schema.Schema.Type<typeof CakeChatUpdate>;

export const CakeChatTarget = Schema.Struct({
  sessionId: boundedId,
  tools: Schema.Array(CakeControlTool),
});
export interface CakeChatTarget extends Schema.Schema.Type<typeof CakeChatTarget> {}

export const CakeChatStartInput = Schema.Struct({
  ...SessionChatPromptInput.fields,
  tools: Schema.Array(CakeControlTool),
  newSession: Schema.Struct({
    configuration: Schema.optionalKey(SessionChatConfiguration),
    name: Schema.optionalKey(Schema.String),
  }),
});
export interface CakeChatStartInput extends Schema.Schema.Type<typeof CakeChatStartInput> {}

export class CakeChatError extends Schema.TaggedError<CakeChatError>()("CakeChatError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
