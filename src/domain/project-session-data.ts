import { Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../ipc/session-contract";
import { ThinkingLevel } from "../services/pi/model-data";
import { ManagedWorktreeContext } from "../services/project-sessions/ProjectSessionEnvironment";
import { CakeSessionIdentity, ConversationEvent, ConversationSnapshot } from "./conversation-data";
import { CrossSessionMessageMetadata } from "./cross-session-coordination";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const boundedText = Schema.String.check(Schema.isMaxLength(262_144));

export const ProjectSessionSummary = Schema.Struct({
  sessionId: boundedId,
  title: Schema.String.check(Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH)),
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  messageCount: Schema.Int,
  parentSessionId: Schema.optionalKey(boundedId),
  resolved: Schema.Boolean,
  unread: Schema.Boolean,
  projectPath: boundedPath,
  projectName: Schema.String,
  workingDirectory: boundedPath,
  worktreeName: Schema.optionalKey(Schema.String),
  managedWorktree: Schema.optionalKey(ManagedWorktreeContext),
  familyId: Schema.optionalKey(boundedId),
  familyParentSessionId: Schema.optionalKey(boundedId),
  familyChildSessionIds: Schema.optionalKey(Schema.Array(boundedId)),
  familyChildOrder: Schema.optionalKey(Schema.Int),
});
export interface ProjectSessionSummary extends Schema.Schema.Type<typeof ProjectSessionSummary> {}

export const ProjectSessionCatalogQuery = Schema.Struct({
  projectPath: boundedPath,
  resolved: Schema.Boolean,
});
export type ProjectSessionCatalogQuery = Schema.Schema.Type<typeof ProjectSessionCatalogQuery>;

export const ProjectSessionPreview = Schema.Struct({
  sessionId: boundedId,
  projectPath: boundedPath,
  workingDirectory: boundedPath,
  sessionFile: boundedPath,
  parts: Schema.Array(Schema.Json),
  firstUserMessage: Schema.optionalKey(boundedText),
  resolved: Schema.Boolean,
  model: Schema.optionalKey(
    Schema.Struct({
      provider: boundedId,
      modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    }),
  ),
  worktreeName: Schema.optionalKey(Schema.String),
  managedWorktree: Schema.optionalKey(ManagedWorktreeContext),
});
export interface ProjectSessionPreview extends Schema.Schema.Type<typeof ProjectSessionPreview> {}

export const ProjectSessionSnapshot = Schema.Struct({
  identity: CakeSessionIdentity,
  projectName: Schema.String,
  resolved: Schema.Boolean,
  unread: Schema.Boolean,
  worktreeName: Schema.optionalKey(Schema.String),
  managedWorktree: Schema.optionalKey(ManagedWorktreeContext),
  conversation: ConversationSnapshot,
});
export interface ProjectSessionSnapshot extends Schema.Schema.Type<typeof ProjectSessionSnapshot> {}

export const ProjectSessionUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, snapshot: ProjectSessionSnapshot },
  Event: { revision: Schema.Int, sessionId: boundedId, event: ConversationEvent },
});
export type ProjectSessionUpdate = Schema.Schema.Type<typeof ProjectSessionUpdate>;

export const ProjectSessionControlInvocation = Schema.TaggedUnion({
  InvokeAppControl: {
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    input: Schema.Record(Schema.String, Schema.Json),
  },
  CreateSession: {
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    initialPrompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
    worktreeName: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
    ),
    model: Schema.Struct({
      provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      thinkingLevel: ThinkingLevel,
      fastMode: Schema.Boolean,
    }),
  },
  CreateDraft: {
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    initialPrompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
    model: Schema.optionalKey(
      Schema.Struct({
        provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
        thinkingLevel: ThinkingLevel,
        fastMode: Schema.Boolean,
      }),
    ),
  },
  ForkSession: {
    entryId: boundedId,
    prompt: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
    ),
    title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
    resolveSource: Schema.Boolean,
    placement: Schema.Literals(["none", "right", "down"]),
    destinationWorkingDirectory: Schema.optionalKey(boundedPath),
  },
  ProjectChildSession: {
    childSessionId: boundedId,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    familyId: boundedId,
    familyChildOrder: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    placement: Schema.Literals(["none", "right", "down"]),
  },
});
export type ProjectSessionControlInvocation = Schema.Schema.Type<
  typeof ProjectSessionControlInvocation
>;

export const ProjectSessionControlRequest = Schema.Struct({
  sessionId: boundedId,
  controlRequestId: Schema.String.check(Schema.isUUID(4)),
  invocation: ProjectSessionControlInvocation,
});
export interface ProjectSessionControlRequest extends Schema.Schema.Type<
  typeof ProjectSessionControlRequest
> {}

export const ProjectSessionTarget = Schema.Struct({
  sessionId: boundedId,
  workingDirectory: Schema.optionalKey(boundedPath),
});
export interface ProjectSessionTarget extends Schema.Schema.Type<typeof ProjectSessionTarget> {}

const ChatConfiguration = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: ThinkingLevel,
  fastMode: Schema.Boolean,
});

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

export const QueuedProjectSessionMessages = Schema.Struct({
  steering: Schema.Array(boundedText),
  followUp: Schema.Array(boundedText),
});
export interface QueuedProjectSessionMessages extends Schema.Schema.Type<
  typeof QueuedProjectSessionMessages
> {}

export const ProjectSessionPromptInput = Schema.Struct({
  sessionId: boundedId,
  workingDirectory: Schema.optionalKey(boundedPath),
  text: boundedText,
  attachments: Schema.Array(Attachment).check(Schema.isMaxLength(20)),
  renderUserMessageAsMarkdown: Schema.Boolean,
  crossSession: Schema.optionalKey(CrossSessionMessageMetadata),
});
export interface ProjectSessionPromptInput extends Schema.Schema.Type<
  typeof ProjectSessionPromptInput
> {}

export const ProjectSessionStartInput = Schema.Struct({
  sessionId: boundedId,
  projectPath: Schema.optionalKey(boundedPath),
  workingDirectory: boundedPath,
  configuration: Schema.optionalKey(ChatConfiguration),
  name: Schema.optionalKey(Schema.String),
  text: boundedText,
  attachments: Schema.Array(Attachment).check(Schema.isMaxLength(20)),
  renderUserMessageAsMarkdown: Schema.Boolean,
});
export interface ProjectSessionStartInput extends Schema.Schema.Type<
  typeof ProjectSessionStartInput
> {}

export class ProjectSessionError extends Schema.TaggedError<ProjectSessionError>()(
  "ProjectSessionError",
  { operation: Schema.String, message: Schema.String },
) {}
