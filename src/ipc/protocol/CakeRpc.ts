import { DictationRpc } from "./DictationRpc";
import { DesktopHostRpc } from "./DesktopHostRpc";
import { BackendConnectionRpc } from "./BackendConnectionRpc";
import { ApplicationRpc } from "./ApplicationRpc";
import { AttachmentUploadRpc } from "./AttachmentUploadRpc";
import { ArtifactRpc } from "./ArtifactRpc";
import { BrowserRpc, BrowserResponseRpc } from "./BrowserRpc";
import { CakeChatRpc } from "./CakeChatRpc";
import { DiscussionRpc } from "./DiscussionRpc";
import { ConversationRpc } from "./ConversationRpc";
import { DrawRpc } from "./DrawRpc";
import { DrawControlRpc } from "./DrawControlRpc";
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
import { PiSettingsRpc } from "./PiSettingsRpc";
import { ProjectSessionRpc } from "./ProjectSessionRpc";
import { ProjectWorkflowRpc } from "./ProjectWorkflowRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { ScheduledMessageRpc } from "./ScheduledMessageRpc";
import { SavedDraftRpc } from "./SavedDraftRpc";
import { SessionChatRpc } from "./SessionChatRpc";
import { SubagentRpc } from "./SubagentRpc";
import { TerminalRpc } from "./TerminalRpc";
import { VsCodeRpc, VsCodeViewRpc } from "./VsCodeRpc";
import { WorkspaceRpc } from "./WorkspaceRpc";

export { FoundationFailure } from "./FoundationRpc";

export const CakeRpc = ApplicationRpc.merge(
  DictationRpc,
  DesktopHostRpc,
  BackendConnectionRpc,
  ArtifactRpc,
  AttachmentUploadRpc,
  BrowserRpc,
  BrowserResponseRpc,
  CakeChatRpc,
  ConversationRpc,
  DiscussionRpc,
  DrawRpc,
  DrawControlRpc,
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
  ProjectSessionRpc,
  ProjectWorkflowRpc,
  ScheduledMessageRpc,
  SavedDraftRpc,
  SessionChatRpc,
  SubagentRpc,
  TerminalRpc,
  VsCodeRpc,
  VsCodeViewRpc,
  WorkspaceRpc,
).middleware(RendererConnectionMiddleware);
