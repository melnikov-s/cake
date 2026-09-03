import { Schema } from "effect";
import { ThinkingLevel } from "../services/pi/model-data";
import { CakeSessionIdentity, ConversationEvent, ConversationSnapshot } from "./conversation-data";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedText = Schema.String.check(Schema.isMaxLength(262_144));

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
  title: Schema.String,
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  messageCount: Schema.Int,
  parentSessionId: Schema.optionalKey(boundedId),
  resolved: Schema.Boolean,
});
export interface CakeChatSummary extends Schema.Schema.Type<typeof CakeChatSummary> {}

export const CakeChatCatalogQuery = Schema.Struct({ resolved: Schema.Boolean });
export interface CakeChatCatalogQuery extends Schema.Schema.Type<typeof CakeChatCatalogQuery> {}

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

export const CakeChatConfiguration = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: ThinkingLevel,
  fastMode: Schema.Boolean,
});
export interface CakeChatConfiguration extends Schema.Schema.Type<typeof CakeChatConfiguration> {}

const Attachment = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), name: Schema.String, path: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    name: Schema.String,
    mimeType: Schema.String,
    data: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("source"),
    name: Schema.String,
    location: Schema.Struct({
      path: Schema.String,
      range: Schema.Struct({
        start: Schema.Struct({ line: Schema.Int }),
        end: Schema.Struct({ line: Schema.Int }),
      }),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("annotation"),
    annotations: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        messageId: Schema.String,
        entryId: Schema.optionalKey(Schema.String),
        selectedText: Schema.String,
        startOffset: Schema.Int,
        endOffset: Schema.Int,
        contextBefore: Schema.String,
        contextAfter: Schema.String,
        comment: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
]);

export const CakeChatPromptInput = Schema.Struct({
  sessionId: boundedId,
  text: boundedText,
  attachments: Schema.Array(Attachment).check(Schema.isMaxLength(20)),
  renderUserMessageAsMarkdown: Schema.Boolean,
  newSession: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.Array(CakeControlTool),
      configuration: Schema.optionalKey(CakeChatConfiguration),
      name: Schema.optionalKey(Schema.String),
    }),
  ),
});
export interface CakeChatPromptInput extends Schema.Schema.Type<typeof CakeChatPromptInput> {}

export class CakeChatError extends Schema.TaggedError<CakeChatError>()("CakeChatError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
