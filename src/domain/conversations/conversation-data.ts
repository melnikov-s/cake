import { Schema } from "effect";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedText = Schema.String.check(Schema.isMaxLength(262_144));

/** Cake projection of the transient messages waiting in a conversation runtime. */
export const QueuedConversationMessages = Schema.Struct({
  steering: Schema.Array(boundedText),
  followUp: Schema.Array(boundedText),
});
export interface QueuedConversationMessages extends Schema.Schema.Type<
  typeof QueuedConversationMessages
> {}

export const TurnId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("TurnId"));
export type TurnId = Schema.Schema.Type<typeof TurnId>;

export const CakeSessionIdentity = Schema.TaggedUnion({
  ProjectSession: {
    sessionId: boundedId,
    projectPath: Schema.String,
    workingDirectory: Schema.String,
  },
  CakeChatSession: { sessionId: boundedId },
  DiscussionSession: { sessionId: boundedId, parentSessionId: boundedId },
  SubagentSession: { handleId: boundedId, parentSessionId: boundedId },
});
export type CakeSessionIdentity = Schema.Schema.Type<typeof CakeSessionIdentity>;

export const ConversationSnapshot = Schema.Struct({
  workingDirectory: Schema.String,
  sessionId: boundedId,
  sessionFile: Schema.String,
  sessionListed: Schema.optionalKey(Schema.Boolean),
  parts: Schema.Array(Schema.Json),
  model: Schema.optionalKey(Schema.Json),
  fastMode: Schema.optionalKey(Schema.Boolean),
  fastModeAvailable: Schema.optionalKey(Schema.Boolean),
  models: Schema.Array(Schema.Json),
  thinkingLevel: Schema.String,
  availableThinkingLevels: Schema.Array(Schema.String),
  piSettings: Schema.optionalKey(Schema.Json),
  streaming: Schema.Boolean,
  diagnostics: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.Json),
  usage: Schema.optionalKey(Schema.Json),
  compatibility: Schema.Json,
  extensionUi: Schema.Json,
  tree: Schema.Array(Schema.Json),
  artifacts: Schema.optionalKey(Schema.Array(Schema.Json)),
});
export interface ConversationSnapshot extends Schema.Schema.Type<typeof ConversationSnapshot> {}

export const ConversationEvent = Schema.TaggedUnion({
  SnapshotUpdated: { snapshot: ConversationSnapshot },
  PartUpdated: { sessionId: boundedId, part: Schema.Json },
  PartRemoved: { sessionId: boundedId, partId: boundedId },
  StreamingChanged: { sessionId: boundedId, streaming: Schema.Boolean },
  UsageUpdated: { sessionId: boundedId, usage: Schema.Json },
  ExtensionUi: { sessionId: boundedId, event: Schema.Json },
  TurnAccepted: { sessionId: boundedId, turnId: TurnId, delivery: Schema.String },
  TurnSettled: {
    sessionId: boundedId,
    turnId: TurnId,
    outcome: Schema.Literals(["complete", "failed", "aborted"]),
    message: Schema.optionalKey(Schema.String),
  },
});
export type ConversationEvent = Schema.Schema.Type<typeof ConversationEvent>;

export const ConversationUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, snapshot: ConversationSnapshot },
  Event: { revision: Schema.Int, event: ConversationEvent },
});
export type ConversationUpdate = Schema.Schema.Type<typeof ConversationUpdate>;
