import { DictationRpc } from "./DictationRpc";
import { SpeechOutputRpc } from "./SpeechOutputRpc";
import { DesktopHostRpc } from "./DesktopHostRpc";
import { BackendConnectionRpc } from "./BackendConnectionRpc";
import { ApplicationRpc } from "./ApplicationRpc";
import { AttachmentUploadRpc } from "./AttachmentUploadRpc";
import { ArtifactRpc } from "./ArtifactRpc";
import { InterviewRpc } from "./InterviewRpc";
import { BrowserRpc, BrowserResponseRpc } from "./BrowserRpc";
import { CakeChatRpc } from "./CakeChatRpc";
import { DiscussionRpc } from "./DiscussionRpc";
import { ConversationRpc } from "./ConversationRpc";
import { DesktopSharingRpc } from "./DesktopSharingRpc";
import { ElectronRpc } from "./ElectronRpc";
import { FoundationRpc } from "./FoundationRpc";
import { FilesystemRpc } from "./FilesystemRpc";
import { NativeAttachmentsRpc } from "./NativeAttachmentsRpc";
import { WindowStateRpc } from "./WindowStateRpc";
import { ProviderAuthRpc } from "./ProviderAuthRpc";
import { InlineWidgetRpc } from "./InlineWidgetRpc";
import { NativeWidgetCaptureRpc, WidgetCaptureResponseRpc } from "./WidgetCaptureRpc";
import { ManagedWorktreeRpc } from "./ManagedWorktreeRpc";
import { ModelRpc } from "./ModelRpc";
import { McpSettingsRpc } from "./McpSettingsRpc";
import { PiSettingsRpc } from "./PiSettingsRpc";
import { ProjectSessionRpc } from "./ProjectSessionRpc";
import { ProjectWorkflowRpc } from "./ProjectWorkflowRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { ScheduledMessageRpc } from "./ScheduledMessageRpc";
import { SavedDraftRpc } from "./SavedDraftRpc";
import { SessionChatRpc } from "./SessionChatRpc";
import { SubagentRpc } from "./SubagentRpc";
import { DynamicWorkflowRpc } from "./DynamicWorkflowRpc";
import { TerminalRpc } from "./TerminalRpc";
import { VsCodeRpc, VsCodeViewRpc } from "./VsCodeRpc";
import { WorkspaceRpc } from "./WorkspaceRpc";

export { FoundationFailure } from "./FoundationRpc";

export const CakeRpc = ApplicationRpc.merge(
  DictationRpc,
  SpeechOutputRpc,
  DesktopHostRpc,
  BackendConnectionRpc,
  ArtifactRpc,
  InterviewRpc,
  AttachmentUploadRpc,
  BrowserRpc,
  BrowserResponseRpc,
  CakeChatRpc,
  ConversationRpc,
  DiscussionRpc,
  ElectronRpc,
  DesktopSharingRpc,
  FoundationRpc,
  FilesystemRpc,
  NativeAttachmentsRpc,
  WindowStateRpc,
  ProviderAuthRpc,
  InlineWidgetRpc,
  NativeWidgetCaptureRpc,
  WidgetCaptureResponseRpc,
  ManagedWorktreeRpc,
  ModelRpc,
  PiSettingsRpc,
  McpSettingsRpc,
  ProjectSessionRpc,
  ProjectWorkflowRpc,
  ScheduledMessageRpc,
  SavedDraftRpc,
  SessionChatRpc,
  SubagentRpc,
  DynamicWorkflowRpc,
  TerminalRpc,
  VsCodeRpc,
  VsCodeViewRpc,
  WorkspaceRpc,
).middleware(RendererConnectionMiddleware);
