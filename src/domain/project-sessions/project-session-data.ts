import { Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { ThinkingLevel } from "../../services/pi/model-data";
import { ArtifactLink } from "../artifacts/artifact-lineage";
import { SubagentHandleId, SubagentStatus } from "../subagents/subagent-data";
import { ManagedWorktreeContext } from "../worktrees/managed-worktree-data";
import {
  CakeSessionIdentity,
  ConversationReference,
  SessionChatConfiguration,
  SessionChatPromptInput,
} from "../conversations/conversation-data";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const boundedText = Schema.String.check(Schema.isMaxLength(262_144));

export const ProjectSessionLocation = Schema.Struct({
  projectPath: boundedPath,
  projectName: Schema.String,
  workingDirectory: boundedPath,
  sessionDirectory: boundedPath,
  resolvedSessionDirectory: boundedPath,
  managedWorktree: Schema.optionalKey(ManagedWorktreeContext),
  worktreeName: Schema.optionalKey(Schema.String),
});
export interface ProjectSessionLocation extends Schema.Schema.Type<typeof ProjectSessionLocation> {}

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
  familyId: Schema.optionalKey(boundedId),
  familyParentSessionId: Schema.optionalKey(boundedId),
  familyChildSessionIds: Schema.optionalKey(Schema.Array(boundedId)),
  familyChildOrder: Schema.optionalKey(Schema.Int),
  familyDepth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
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

const ProjectReference = Schema.Struct({
  path: boundedPath,
  name: Schema.String,
});

export const WorkingDirectoryReference = Schema.Struct({
  path: boundedPath,
  worktreeName: Schema.optionalKey(Schema.String),
  managedWorktree: Schema.optionalKey(ManagedWorktreeContext),
});
export interface WorkingDirectoryReference extends Schema.Schema.Type<
  typeof WorkingDirectoryReference
> {}

const ProjectSessionLifecycleProjection = Schema.Struct({
  resolved: Schema.Boolean,
  unread: Schema.Boolean,
});

const DiscussionSessionReference = Schema.Struct({
  threadId: boundedId,
  sessionId: boundedId,
  status: Schema.Literals(["open", "resolved"]),
  anchor: Schema.Literals(["file", "message", "session"]),
});

const ReviewThreadReference = Schema.Struct({
  threadId: boundedId,
  status: Schema.Literals(["open", "resolved"]),
  anchor: Schema.Literals(["file", "message", "session"]),
  updatedAt: Schema.String,
});

const SubagentSessionReference = Schema.Struct({
  handleId: SubagentHandleId,
  status: SubagentStatus,
  task: boundedText,
});

export const SessionFamilyReference = Schema.Struct({
  familyId: boundedId,
  rootProjectSessionId: boundedId,
  parentProjectSessionId: Schema.optionalKey(boundedId),
  childProjectSessionIds: Schema.Array(boundedId),
  depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export interface SessionFamilyReference extends Schema.Schema.Type<typeof SessionFamilyReference> {}

/**
 * Main-owned aggregate read projection for one Project Session. It joins bounded
 * references from focused authorities without embedding transcripts or payloads.
 */
export const ProjectSessionProjection = Schema.Struct({
  identity: CakeSessionIdentity.cases.ProjectSession,
  project: ProjectReference,
  workingDirectory: WorkingDirectoryReference,
  lifecycle: ProjectSessionLifecycleProjection,
  primaryConversation: ConversationReference,
  discussionSessions: Schema.Array(DiscussionSessionReference),
  subagentSessions: Schema.Array(SubagentSessionReference),
  reviewThreads: Schema.Array(ReviewThreadReference),
  artifactLinks: Schema.Array(ArtifactLink),
  family: Schema.optionalKey(SessionFamilyReference),
});
export interface ProjectSessionProjection extends Schema.Schema.Type<
  typeof ProjectSessionProjection
> {}

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
    familyDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    workingDirectory: boundedPath,
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

export const ProjectSessionCompanionActionInput = Schema.Struct({
  ...ProjectSessionTarget.fields,
  companionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  action: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  value: Schema.Json,
});
export interface ProjectSessionCompanionActionInput extends Schema.Schema.Type<
  typeof ProjectSessionCompanionActionInput
> {}

export const ProjectSessionPromptInput = Schema.Struct({
  ...SessionChatPromptInput.fields,
  workingDirectory: Schema.optionalKey(boundedPath),
});
export interface ProjectSessionPromptInput extends Schema.Schema.Type<
  typeof ProjectSessionPromptInput
> {}

export const ProjectSessionStartInput = Schema.Struct({
  sessionId: boundedId,
  projectPath: Schema.optionalKey(boundedPath),
  workingDirectory: boundedPath,
  configuration: Schema.optionalKey(SessionChatConfiguration),
  name: Schema.optionalKey(Schema.String),
  labelIds: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isUUID(4))).check(
      Schema.isMaxLength(100),
      Schema.isUnique(),
    ),
  ),
  text: SessionChatPromptInput.fields.text,
  attachments: SessionChatPromptInput.fields.attachments,
  renderUserMessageAsMarkdown: SessionChatPromptInput.fields.renderUserMessageAsMarkdown,
  presentationMode: SessionChatPromptInput.fields.presentationMode,
});
export interface ProjectSessionStartInput extends Schema.Schema.Type<
  typeof ProjectSessionStartInput
> {}

export const WorkingDirectoryResolutionFailure = Schema.Struct({
  sessionIds: Schema.Array(boundedId).check(Schema.isMaxLength(10_000)),
  message: Schema.String,
});
export interface WorkingDirectoryResolutionFailure extends Schema.Schema.Type<
  typeof WorkingDirectoryResolutionFailure
> {}

export const WorkingDirectoryResolutionResult = Schema.Struct({
  projectPath: boundedPath,
  workingDirectory: boundedPath,
  resolvedSessionIds: Schema.Array(boundedId).check(Schema.isMaxLength(10_000)),
  failures: Schema.Array(WorkingDirectoryResolutionFailure).check(Schema.isMaxLength(10_000)),
});
export interface WorkingDirectoryResolutionResult extends Schema.Schema.Type<
  typeof WorkingDirectoryResolutionResult
> {}

export class ProjectSessionError extends Schema.TaggedError<ProjectSessionError>()(
  "ProjectSessionError",
  { operation: Schema.String, message: Schema.String },
) {}
