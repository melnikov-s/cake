import { Schema } from "effect";
import { ThinkingLevel } from "../pi/model-data";
import { attachmentSchema } from "../conversations/session-contract";
import {
  CakeSessionIdentity,
  ConversationEvent,
  ConversationSnapshot,
  TurnId,
} from "../conversations/conversation-data";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192));
const boundedText = Schema.String.check(Schema.isMaxLength(262_144));

const DiscussionPoint = Schema.Struct({
  diffLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  oldLine: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  newLine: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  column: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const DiscussionAnchor = Schema.Struct({
  path: boundedPath,
  view: Schema.optionalKey(Schema.Literals(["file", "message", "session", "artifact"])),
  start: DiscussionPoint,
  end: DiscussionPoint,
  selectedText: boundedText,
  contextBefore: boundedText,
  contextAfter: boundedText,
  diff: boundedText,
  messageId: Schema.optionalKey(boundedId),
  entryId: Schema.optionalKey(boundedId),
  startOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  endOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export interface DiscussionAnchor extends Schema.Schema.Type<typeof DiscussionAnchor> {}

/**
 * Whether a thread's conversation is authoritative from its own live sidecar
 * observation rather than from the parent's Discussion catalog rows.
 */
export const hasSidecarConversation = (thread: {
  readonly sidecarSessionId?: string | undefined;
}) => Boolean(thread.sidecarSessionId);

export const DiscussionThread = Schema.Struct({
  id: boundedId,
  title: Schema.optionalKey(boundedText),
  workingDirectory: Schema.String,
  parentSessionId: boundedId,
  sidecarSessionId: Schema.optionalKey(boundedId),
  anchor: DiscussionAnchor,
  parts: Schema.Array(Schema.Json),
  usage: Schema.optionalKey(Schema.Json),
  status: Schema.Literals(["open", "resolved"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  resolvedAt: Schema.optionalKey(Schema.String),
});
export interface DiscussionThread extends Schema.Schema.Type<typeof DiscussionThread> {}

/** Lightweight navigation catalog; titles come from saved metadata, never transcript reads. */
export const DiscussionThreadMetadata = Schema.Struct({
  id: DiscussionThread.fields.id,
  workingDirectory: DiscussionThread.fields.workingDirectory,
  parentSessionId: DiscussionThread.fields.parentSessionId,
  sidecarSessionId: DiscussionThread.fields.sidecarSessionId,
  title: boundedText,
  running: Schema.Boolean,
  status: DiscussionThread.fields.status,
  createdAt: DiscussionThread.fields.createdAt,
  updatedAt: DiscussionThread.fields.updatedAt,
});
export interface DiscussionThreadMetadata extends Schema.Schema.Type<
  typeof DiscussionThreadMetadata
> {}

export const DiscussionSessionTarget = Schema.Struct({
  parentSessionId: boundedId,
  workingDirectory: Schema.String,
  threadId: boundedId,
});
export interface DiscussionSessionTarget extends Schema.Schema.Type<
  typeof DiscussionSessionTarget
> {}

/** Saved owner route; a task fork's execution directory can differ from its parent's. */
export const DiscussionSessionReference = Schema.Struct({
  ...DiscussionSessionTarget.fields,
  sessionId: boundedId,
  executionDirectory: Schema.String,
  projectPath: Schema.optionalKey(Schema.String),
  resolved: Schema.Boolean,
});
export interface DiscussionSessionReference extends Schema.Schema.Type<
  typeof DiscussionSessionReference
> {}

/** Live sidecar conversation; the parent's Discussion catalog owns thread metadata. */
export const DiscussionSessionProjection = Schema.Struct({
  identity: CakeSessionIdentity,
  conversation: ConversationSnapshot,
});
export interface DiscussionSessionProjection extends Schema.Schema.Type<
  typeof DiscussionSessionProjection
> {}

export const DiscussionSessionUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, snapshot: DiscussionSessionProjection },
  Event: { revision: Schema.Int, sessionId: boundedId, event: ConversationEvent },
});
export type DiscussionSessionUpdate = Schema.Schema.Type<typeof DiscussionSessionUpdate>;

const DiscussionAnnotation = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  messageId: boundedId,
  entryId: Schema.optionalKey(boundedId),
  selectedText: boundedText.check(Schema.isMinLength(1)),
  startOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contextBefore: boundedText,
  contextAfter: boundedText,
  comment: Schema.optionalKey(boundedText),
}).check(
  Schema.makeFilter((annotation) =>
    annotation.endOffset > annotation.startOffset
      ? undefined
      : "Annotation end offset must follow its start offset",
  ),
);

/**
 * Creates a Discussion Session and delivers its first prompt. Every later
 * conversation operation addresses the sidecar through the shared Session Chat
 * operations by its Pi Session ID.
 */
export const DiscussionSessionStartInput = Schema.Struct({
  parentSessionId: boundedId,
  workingDirectory: Schema.String,
  anchor: DiscussionAnchor,
  text: boundedText,
  attachments: Schema.optionalKey(Schema.Array(attachmentSchema)),
  annotations: Schema.optionalKey(
    Schema.Array(DiscussionAnnotation).check(Schema.isMaxLength(100)),
  ),
  model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export interface DiscussionSessionStartInput extends Schema.Schema.Type<
  typeof DiscussionSessionStartInput
> {}

/**
 * Branches a native Durable side chat from a message or the main conversation's
 * latest settled exchange (a session anchor). Side-chat origins resolve to their
 * main conversation. The backend owns the permanent chat's location.
 */
export const CakeChatSideChatStartInput = Schema.Struct({
  parentSessionId: Schema.optionalKey(Schema.String),
  anchor: DiscussionAnchor,
  text: DiscussionSessionStartInput.fields.text,
  attachments: DiscussionSessionStartInput.fields.attachments,
  annotations: DiscussionSessionStartInput.fields.annotations,
  model: DiscussionSessionStartInput.fields.model,
  thinkingLevel: DiscussionSessionStartInput.fields.thinkingLevel,
});
export interface CakeChatSideChatStartInput extends Schema.Schema.Type<
  typeof CakeChatSideChatStartInput
> {}

export const DiscussionSessionAcceptedTurn = Schema.Struct({
  turnId: TurnId,
  thread: DiscussionThread,
});

/** A historical import never starts a turn or resolves the source thread. */
export const DiscussionSessionMergeResult = Schema.Struct({
  importedMessages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export interface DiscussionSessionMergeResult extends Schema.Schema.Type<
  typeof DiscussionSessionMergeResult
> {}

export class DiscussionSessionError extends Schema.TaggedError<DiscussionSessionError>()(
  "DiscussionSessionError",
  { operation: Schema.String, message: Schema.String },
) {}
