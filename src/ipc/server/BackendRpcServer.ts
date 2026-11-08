import { vscodeHandlers } from "./VsCodeHandlers";
import { automationHandlers } from "./AutomationHandlers";
import { inlineWidgetHandlers } from "./InlineWidgetHandlers";
import { widgetCaptureResponseHandlers } from "./WidgetCaptureHandlers";
import { browserResponseHandlers } from "./BrowserResponseHandlers";
import { subagentHandlers } from "./SubagentHandlers";
import { discussionHandlers } from "./DiscussionHandlers";
import { managedWorktreeHandlers } from "./ManagedWorktreeHandlers";
import { terminalHandlers } from "./TerminalHandlers";
import { backendConnectionHandlers } from "./BackendConnectionHandlers";
import { Layer } from "effect";
import { RpcServer } from "effect/rpc";
import type { CakeChatRuntimeConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { BackendRpc } from "../protocol/BackendRpc";
import {
  RendererConnectionMiddleware,
  RendererConnectionMiddlewareLive,
} from "../protocol/RendererConnectionMiddleware";
import { SubagentRpc } from "../protocol/SubagentRpc";
import { DiscussionRpc } from "../protocol/DiscussionRpc";
import { CakeChatRpc } from "../protocol/CakeChatRpc";
import { applicationStateHandlers } from "./ApplicationStateHandlers";
import { artifactHandlers } from "./ArtifactHandlers";
import { interviewHandlers } from "./InterviewHandlers";
import { makeCakeChatHandlers } from "./CakeChatHandlers";
import { makeConversationHandlers } from "./ConversationHandlers";
import { makeFoundationHandlers } from "./FoundationHandlers";
import { modelHandlers } from "./ModelHandlers";
import { mcpSettingsHandlers } from "./McpSettingsHandlers";
import { widgetPackageHandlers } from "./WidgetPackageHandlers";
import { piSettingsHandlers } from "./PiSettingsHandlers";
import { providerAuthHandlers } from "./ProviderAuthHandlers";
import { projectSessionHandlers } from "./ProjectSessionHandlers";
import { projectTodoHandlers } from "./ProjectTodoHandlers";
import { projectWorkflowHandlers } from "./ProjectWorkflowHandlers";
import { scheduledMessageHandlers } from "./ScheduledMessageHandlers";
import { savedDraftHandlers } from "./SavedDraftHandlers";
import { sessionChatHandlers } from "./SessionChatHandlers";
import { workspaceHandlers } from "./WorkspaceHandlers";
import { filesystemHandlers } from "./FilesystemHandlers";
import { attachmentUploadHandlers } from "./AttachmentUploadHandlers";

/** Shared backend handler coverage, independent of the host transport and backend acquisition. */
export const makeBackendRpcHandlersLive = (
  homeDirectory: string,
  cakeChatConfiguration: CakeChatRuntimeConfiguration,
) => {
  // Existing feature groups bound handler inference while preserving BackendRpc's middleware contract.
  const conversationGroups = SubagentRpc.merge(DiscussionRpc, CakeChatRpc);
  const conversationTags = [...conversationGroups.requests.values()].map((rpc) => rpc._tag);
  const handlers = BackendRpc.omit(...conversationTags).toLayer({
    ...automationHandlers,
    ...backendConnectionHandlers,
    ...vscodeHandlers,
    ...inlineWidgetHandlers,
    ...widgetCaptureResponseHandlers,
    ...browserResponseHandlers,
    ...filesystemHandlers,
    ...attachmentUploadHandlers,
    ...terminalHandlers,
    ...managedWorktreeHandlers,
    ...applicationStateHandlers,
    ...artifactHandlers,
    ...interviewHandlers,
    ...makeConversationHandlers(cakeChatConfiguration),
    ...makeFoundationHandlers(homeDirectory),
    ...modelHandlers,
    ...piSettingsHandlers,
    ...mcpSettingsHandlers,
    ...widgetPackageHandlers,
    ...providerAuthHandlers,
    ...projectSessionHandlers,
    ...projectWorkflowHandlers,
    ...projectTodoHandlers,
    ...scheduledMessageHandlers,
    ...savedDraftHandlers,
    ...sessionChatHandlers,
    ...workspaceHandlers,
  });
  return Layer.mergeAll(
    handlers,
    SubagentRpc.middleware(RendererConnectionMiddleware).toLayer(subagentHandlers),
    DiscussionRpc.middleware(RendererConnectionMiddleware).toLayer(discussionHandlers),
    CakeChatRpc.middleware(RendererConnectionMiddleware).toLayer(
      makeCakeChatHandlers(cakeChatConfiguration),
    ),
  );
};

/** Acquires only the endpoint: the host supplies an already acquired backend and Protocol. */
export const makeBackendRpcServerLive = (
  homeDirectory: string,
  cakeChatConfiguration: CakeChatRuntimeConfiguration,
) => {
  const handlers = makeBackendRpcHandlersLive(homeDirectory, cakeChatConfiguration);
  return RpcServer.layer(BackendRpc, {
    spanPrefix: "BackendRpcServer",
    disableFatalDefects: true,
  }).pipe(Layer.provide(Layer.merge(handlers, RendererConnectionMiddlewareLive)));
};
