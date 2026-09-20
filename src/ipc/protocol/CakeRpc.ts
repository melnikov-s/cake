import { ApplicationRpc } from "./ApplicationRpc";
import { ArtifactRpc } from "./ArtifactRpc";
import { BrowserRpc } from "./BrowserRpc";
import { CakeChatRpc } from "./CakeChatRpc";
import { DiscussionRpc } from "./DiscussionRpc";
import { ConversationRpc } from "./ConversationRpc";
import { DrawRpc } from "./DrawRpc";
import { DrawControlRpc } from "./DrawControlRpc";
import { ElectronRpc } from "./ElectronRpc";
import { FoundationRpc } from "./FoundationRpc";
import { InlineWidgetRpc } from "./InlineWidgetRpc";
import { ManagedWorktreeRpc } from "./ManagedWorktreeRpc";
import { ModelRpc } from "./ModelRpc";
import { PiSettingsRpc } from "./PiSettingsRpc";
import { ProjectSessionRpc } from "./ProjectSessionRpc";
import { ProjectWorkflowRpc } from "./ProjectWorkflowRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { ScheduledMessageRpc } from "./ScheduledMessageRpc";
import { SessionChatRpc } from "./SessionChatRpc";
import { SubagentRpc } from "./SubagentRpc";
import { TerminalRpc } from "./TerminalRpc";
import { VsCodeRpc } from "./VsCodeRpc";
import { WorkspaceRpc } from "./WorkspaceRpc";

export { FoundationFailure } from "./FoundationRpc";

export const CakeRpc = ApplicationRpc.merge(
  ArtifactRpc,
  BrowserRpc,
  CakeChatRpc,
  ConversationRpc,
  DiscussionRpc,
  DrawRpc,
  DrawControlRpc,
  ElectronRpc,
  FoundationRpc,
  InlineWidgetRpc,
  ManagedWorktreeRpc,
  ModelRpc,
  PiSettingsRpc,
  ProjectSessionRpc,
  ProjectWorkflowRpc,
  ScheduledMessageRpc,
  SessionChatRpc,
  SubagentRpc,
  TerminalRpc,
  VsCodeRpc,
  WorkspaceRpc,
).middleware(RendererConnectionMiddleware);
