import { Schema } from "effect";
import { ThinkingLevel } from "../services/pi/model-data";
import {
  CakeSessionIdentity,
  ConversationEvent,
  ConversationSnapshot,
  TurnId,
} from "./conversation-data";

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
  view: Schema.optionalKey(Schema.Literals(["file", "message"])),
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

export const DiscussionThread = Schema.Struct({
  id: boundedId,
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

export const DiscussionSessionTarget = Schema.Struct({
  parentSessionId: boundedId,
  workingDirectory: Schema.String,
  threadId: boundedId,
});
export interface DiscussionSessionTarget extends Schema.Schema.Type<
  typeof DiscussionSessionTarget
> {}

export const DiscussionSessionSnapshot = Schema.Struct({
  identity: CakeSessionIdentity,
  thread: DiscussionThread,
  conversation: ConversationSnapshot,
});
export interface DiscussionSessionSnapshot extends Schema.Schema.Type<
  typeof DiscussionSessionSnapshot
> {}

export const DiscussionSessionUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, snapshot: DiscussionSessionSnapshot },
  Event: { revision: Schema.Int, threadId: boundedId, event: ConversationEvent },
});
export type DiscussionSessionUpdate = Schema.Schema.Type<typeof DiscussionSessionUpdate>;

export const DiscussionSessionCreateInput = Schema.Struct({
  parentSessionId: boundedId,
  workingDirectory: Schema.String,
  anchor: DiscussionAnchor,
});
export interface DiscussionSessionCreateInput extends Schema.Schema.Type<
  typeof DiscussionSessionCreateInput
> {}

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

export const DiscussionSessionPromptInput = Schema.Struct({
  ...DiscussionSessionTarget.fields,
  text: boundedText,
  annotations: Schema.optionalKey(
    Schema.Array(DiscussionAnnotation).check(Schema.isMaxLength(100)),
  ),
  model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, id: Schema.String })),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
});
export interface DiscussionSessionPromptInput extends Schema.Schema.Type<
  typeof DiscussionSessionPromptInput
> {}

export const DiscussionSessionAcceptedTurn = Schema.Struct({
  turnId: TurnId,
  thread: DiscussionThread,
});

export class DiscussionSessionError extends Schema.TaggedError<DiscussionSessionError>()(
  "DiscussionSessionError",
  { operation: Schema.String, message: Schema.String },
) {}
