import { VsCodeRpc } from "./VsCodeRpc";
import { InlineWidgetRpc } from "./InlineWidgetRpc";
import { WidgetCaptureResponseRpc } from "./WidgetCaptureRpc";
import { BrowserResponseRpc } from "./BrowserRpc";
import { FilesystemRpc } from "./FilesystemRpc";
import { AttachmentUploadRpc } from "./AttachmentUploadRpc";
import { BackendConnectionRpc } from "./BackendConnectionRpc";
import { TerminalRpc } from "./TerminalRpc";
import { ManagedWorktreeRpc } from "./ManagedWorktreeRpc";
import { DiscussionRpc } from "./DiscussionRpc";
import { SubagentRpc } from "./SubagentRpc";
import { DynamicWorkflowRpc } from "./DynamicWorkflowRpc";
import { ApplicationRpc } from "./ApplicationRpc";
import { ArtifactRpc } from "./ArtifactRpc";
import { InterviewRpc } from "./InterviewRpc";
import { CakeChatRpc } from "./CakeChatRpc";
import { ConversationRpc } from "./ConversationRpc";
import { FoundationRpc } from "./FoundationRpc";
import { ModelRpc } from "./ModelRpc";
import { McpSettingsRpc } from "./McpSettingsRpc";
import { WidgetPackageRpc } from "./WidgetPackageRpc";
import { PiSettingsRpc } from "./PiSettingsRpc";
import { ProviderAuthRpc } from "./ProviderAuthRpc";
import { ProjectSessionRpc } from "./ProjectSessionRpc";
import { ProjectTodoRpc } from "./ProjectTodoRpc";
import { ProjectWorkflowRpc } from "./ProjectWorkflowRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { ScheduledMessageRpc } from "./ScheduledMessageRpc";
import { SavedDraftRpc } from "./SavedDraftRpc";
import { SessionChatRpc } from "./SessionChatRpc";
import { WorkspaceRpc } from "./WorkspaceRpc";

/** Shared backend membership for local and network endpoints, excluding desktop-only actions. */
export const BackendRpc = ApplicationRpc.merge(
  BackendConnectionRpc,
  VsCodeRpc,
  InlineWidgetRpc,
  WidgetCaptureResponseRpc,
  BrowserResponseRpc,
  FilesystemRpc,
  AttachmentUploadRpc,
  TerminalRpc,
  ManagedWorktreeRpc,
  DiscussionRpc,
  SubagentRpc,
  DynamicWorkflowRpc,
  ArtifactRpc,
  InterviewRpc,
  CakeChatRpc,
  ConversationRpc,
  FoundationRpc,
  ModelRpc,
  PiSettingsRpc,
  McpSettingsRpc,
  WidgetPackageRpc,
  ProviderAuthRpc,
  ProjectSessionRpc,
  ProjectWorkflowRpc,
  ProjectTodoRpc,
  ScheduledMessageRpc,
  SavedDraftRpc,
  SessionChatRpc,
  WorkspaceRpc,
).middleware(RendererConnectionMiddleware);
