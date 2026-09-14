import { Schema } from "effect";
import { ThinkingLevel } from "../../services/pi/model-data";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
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
  view: Schema.optionalKey(Schema.Literals(["file", "message", "session"])),
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

export const sessionAssistantThreadPath = (parentSessionId: string) =>
  `session:${parentSessionId}/assistant`;

export const isSessionAssistantThread = (thread: {
  readonly parentSessionId: string;
  readonly anchor: { readonly view?: string; readonly path: string };
}) =>
  thread.anchor.view === "session" &&
  thread.anchor.path === sessionAssistantThreadPath(thread.parentSessionId);

/**
 * Whether a thread's conversation is authoritative from its own live sidecar
 * observation rather than from the parent's Discussion catalog rows.
 */
export const hasSidecarConversation = (thread: {
  readonly sidecarSessionId?: string | undefined;
}) => Boolean(thread.sidecarSessionId);

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
  /** The Cake control catalog a session assistant thread's sidecar exposes; other threads omit it. */
  tools: Schema.optionalKey(Schema.Array(CakeControlTool)),
});
export interface DiscussionSessionTarget extends Schema.Schema.Type<
  typeof DiscussionSessionTarget
> {}

/** Live sidecar conversation; the parent's Discussion catalog owns thread metadata. */
export const DiscussionSessionSnapshot = Schema.Struct({
  identity: CakeSessionIdentity,
  conversation: ConversationSnapshot,
});
export interface DiscussionSessionSnapshot extends Schema.Schema.Type<
  typeof DiscussionSessionSnapshot
> {}

export const DiscussionSessionUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, snapshot: DiscussionSessionSnapshot },
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
 * Ensures a Project Session's single assistant Discussion Session exists. Like
 * any side chat, its sidecar is created by delivering a first message, so the
 * pending message is supplied while the thread has no sidecar yet. A staged
 * parent has no transcript, so the renderer supplies its current messages for
 * the read-only projection.
 */
export const SessionAssistantEnsureInput = Schema.Struct({
  parentSessionId: boundedId,
  workingDirectory: Schema.String,
  tools: Schema.Array(CakeControlTool),
  staged: Schema.Boolean,
  stagedMessages: Schema.Array(
    Schema.Struct({ role: Schema.Literals(["user", "assistant"]), text: boundedText }),
  ).check(Schema.isMaxLength(500)),
  firstPrompt: Schema.optionalKey(
    Schema.Struct({
      text: boundedText,
      annotations: Schema.optionalKey(
        Schema.Array(DiscussionAnnotation).check(Schema.isMaxLength(100)),
      ),
    }),
  ),
});
export interface SessionAssistantEnsureInput extends Schema.Schema.Type<
  typeof SessionAssistantEnsureInput
> {}

/** The assistant thread, plus the turn `ensure` delivered when it created the sidecar. */
export const SessionAssistantEnsured = Schema.Struct({
  thread: DiscussionThread,
  turnId: Schema.optionalKey(TurnId),
});
export interface SessionAssistantEnsured extends Schema.Schema.Type<
  typeof SessionAssistantEnsured
> {}

export const DiscussionSessionAcceptedTurn = Schema.Struct({
  turnId: TurnId,
  thread: DiscussionThread,
});

export class DiscussionSessionError extends Schema.TaggedError<DiscussionSessionError>()(
  "DiscussionSessionError",
  { operation: Schema.String, message: Schema.String },
) {}
