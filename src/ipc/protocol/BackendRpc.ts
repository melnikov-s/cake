import { VsCodeRpc } from "./VsCodeRpc";
import { InlineWidgetRpc } from "./InlineWidgetRpc";
import { WidgetCaptureResponseRpc } from "./WidgetCaptureRpc";
import { BrowserResponseRpc } from "./BrowserRpc";
import { FilesystemRpc } from "./FilesystemRpc";
import { AttachmentUploadRpc } from "./AttachmentUploadRpc";
import { BackendConnectionRpc } from "./BackendConnectionRpc";
import { DrawRpc } from "./DrawRpc";
import { TerminalRpc } from "./TerminalRpc";
import { ManagedWorktreeRpc } from "./ManagedWorktreeRpc";
import { DiscussionRpc } from "./DiscussionRpc";
import { SubagentRpc } from "./SubagentRpc";
import { ApplicationRpc } from "./ApplicationRpc";
import { ArtifactRpc } from "./ArtifactRpc";
import { CakeChatRpc } from "./CakeChatRpc";
import { ConversationRpc } from "./ConversationRpc";
import { DrawControlRpc } from "./DrawControlRpc";
import { FoundationRpc } from "./FoundationRpc";
import { ModelRpc } from "./ModelRpc";
import { PiSettingsRpc } from "./PiSettingsRpc";
import { ProviderAuthRpc } from "./ProviderAuthRpc";
import { ProjectSessionRpc } from "./ProjectSessionRpc";
import { ProjectWorkflowRpc } from "./ProjectWorkflowRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { ScheduledMessageRpc } from "./ScheduledMessageRpc";
import { SavedDraftRpc } from "./SavedDraftRpc";
import { SessionChatRpc } from "./SessionChatRpc";
import { WorkspaceRpc } from "./WorkspaceRpc";

/** Headless chat/catalog surface. Desktop-local actions are deliberately not merged here. */
export const BackendRpc = ApplicationRpc.merge(
  BackendConnectionRpc,
  VsCodeRpc,
  InlineWidgetRpc,
  WidgetCaptureResponseRpc,
  BrowserResponseRpc,
  DrawRpc,
  FilesystemRpc,
  AttachmentUploadRpc,
  TerminalRpc,
  ManagedWorktreeRpc,
  DiscussionRpc,
  SubagentRpc,

  ArtifactRpc,
  CakeChatRpc,
  ConversationRpc,
  FoundationRpc,
  DrawControlRpc,
  ModelRpc,
  PiSettingsRpc,
  ProviderAuthRpc,
  ProjectSessionRpc,
  ProjectWorkflowRpc,
  ScheduledMessageRpc,
  SavedDraftRpc,
  SessionChatRpc,
  WorkspaceRpc,
).middleware(RendererConnectionMiddleware);
