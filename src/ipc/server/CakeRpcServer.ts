import { dictationHandlers } from "./DictationHandlers";
import { speechOutputHandlers } from "./SpeechOutputHandlers";
import { desktopHostHandlers } from "./DesktopHostHandlers";
import { backendConnectionHandlers } from "./BackendConnectionHandlers";
import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { CakeRpc } from "../protocol/CakeRpc";
import { RendererConnectionMiddlewareLive } from "../protocol/RendererConnectionMiddleware";
import { applicationStateHandlers } from "./ApplicationStateHandlers";
import { artifactHandlers } from "./ArtifactHandlers";
import { interviewHandlers } from "./InterviewHandlers";
import { attachmentUploadHandlers } from "./AttachmentUploadHandlers";
import { browserHandlers } from "./BrowserHandlers";
import { browserResponseHandlers } from "./BrowserResponseHandlers";
import type { CakeChatRuntimeConfiguration } from "../../domain/cake-chats/cakeChatRuntime";
import { makeCakeChatHandlers } from "./CakeChatHandlers";
import { makeConversationHandlers } from "./ConversationHandlers";
import { discussionHandlers } from "./DiscussionHandlers";
import { desktopSharingHandlers } from "./DesktopSharingHandlers";
import { electronHandlers } from "./ElectronHandlers";
import { makeFoundationHandlers } from "./FoundationHandlers";
import { filesystemHandlers, nativeAttachmentsHandlers } from "./FilesystemHandlers";
import { windowStateHandlers } from "./WindowStateHandlers";
import { providerAuthHandlers } from "./ProviderAuthHandlers";
import { inlineWidgetHandlers } from "./InlineWidgetHandlers";
import {
  nativeWidgetCaptureHandlers,
  widgetCaptureResponseHandlers,
} from "./WidgetCaptureHandlers";
import { managedWorktreeHandlers } from "./ManagedWorktreeHandlers";
import { modelHandlers } from "./ModelHandlers";
import { mcpSettingsHandlers } from "./McpSettingsHandlers";
import { widgetPackageHandlers } from "./WidgetPackageHandlers";
import { piSettingsHandlers } from "./PiSettingsHandlers";
import { projectSessionHandlers } from "./ProjectSessionHandlers";
import { ProjectSessionRpc } from "../protocol/ProjectSessionRpc";
import { projectWorkflowHandlers } from "./ProjectWorkflowHandlers";
import { scheduledMessageHandlers } from "./ScheduledMessageHandlers";
import { savedDraftHandlers } from "./SavedDraftHandlers";
import { sessionChatHandlers } from "./SessionChatHandlers";
import { subagentHandlers } from "./SubagentHandlers";
import { dynamicWorkflowHandlers } from "./DynamicWorkflowHandlers";
import { DynamicWorkflowRpc } from "../protocol/DynamicWorkflowRpc";
import { RendererConnectionMiddleware } from "../protocol/RendererConnectionMiddleware";
import { terminalHandlers } from "./TerminalHandlers";
import { vscodeHandlers, vscodeViewHandlers } from "./VsCodeHandlers";
import { workspaceHandlers } from "./WorkspaceHandlers";
import { CakeChatRpc } from "../protocol/CakeChatRpc";

/**
 * One RPC endpoint over a host-supplied Protocol and already-acquired backend capabilities.
 * This Layer owns only handler/transport request fibers, never backend acquisition. Hosts may
 * build it in independent endpoint Scopes with the same backend Context; closing an endpoint
 * releases its requests and observations without closing that Context's owning Scope.
 */
export const makeCakeRpcServerLive = (
  homeDirectory: string,
  cakeChatConfiguration: CakeChatRuntimeConfiguration,
) => {
  // Register the existing groups separately to bound TypeScript's handler inference.
  const handlers = CakeRpc.omit(
    "projectSessions.observeCatalog",
    "projectSessions.inspect",
    "projectSessions.lookup",
    "projectSessions.start",
    "projectSessions.open",
    "projectSessions.getChangelog",
    "projectSessions.navigate",
    "projectSessions.dispatchExtensionCompanionAction",
    "projectSessions.callCakeOperation",
    "projectSessions.toolCompact",
    "projectSessions.rename",
    "projectSessions.fork",
    "projectSessions.resolve",
    "projectSessions.resolveWorkingDirectory",
    "projectSessions.restore",
    "projectSessions.respondControl",
    "cakeChats.requestInspection",
    "cakeChats.observeCatalog",
    "cakeChats.inspect",
    "cakeChats.open",
    "cakeChats.observeControls",
    "cakeChats.start",
    "cakeChats.observeSideChats",
    "cakeChats.startSideChat",
    "cakeChats.setUnread",
    "cakeChats.respondControl",
    "workflows.start",
    "workflows.list",
    "workflows.inspect",
    "workflows.observe",
    "workflows.observeRun",
    "workflows.pause",
    "workflows.resume",
    "workflows.stop",
    "workflows.relaunch",
    "workflows.stopWorker",
    "workflows.restartWorker",
    "workflows.inspectWorker",
    "workflows.saved",
    "workflows.save",
  ).toLayer({
    ...dictationHandlers,
    ...speechOutputHandlers,
    ...desktopHostHandlers,
    ...backendConnectionHandlers,
    ...applicationStateHandlers,
    ...artifactHandlers,
    ...interviewHandlers,
    ...attachmentUploadHandlers,
    ...browserHandlers,
    ...browserResponseHandlers,
    ...makeConversationHandlers(cakeChatConfiguration),
    ...discussionHandlers,
    ...electronHandlers,
    ...desktopSharingHandlers,
    ...makeFoundationHandlers(homeDirectory),
    ...filesystemHandlers,
    ...nativeAttachmentsHandlers,
    ...windowStateHandlers,
    ...providerAuthHandlers,
    ...inlineWidgetHandlers,
    ...nativeWidgetCaptureHandlers,
    ...widgetCaptureResponseHandlers,
    ...managedWorktreeHandlers,
    ...modelHandlers,
    ...piSettingsHandlers,
    ...mcpSettingsHandlers,
    ...widgetPackageHandlers,
    ...projectWorkflowHandlers,
    ...scheduledMessageHandlers,
    ...savedDraftHandlers,
    ...sessionChatHandlers,
    ...subagentHandlers,
    ...terminalHandlers,
    ...vscodeHandlers,
    ...vscodeViewHandlers,
    ...workspaceHandlers,
  });

  return RpcServer.layer(CakeRpc, {
    spanPrefix: "CakeRpcServer",
    // A defect in one request must remain correlated with that request. Sending
    // it as a connection-wide fatal defect tears down every renderer Stream.
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        handlers,
        ProjectSessionRpc.middleware(RendererConnectionMiddleware).toLayer(projectSessionHandlers),
        CakeChatRpc.toLayer(makeCakeChatHandlers(cakeChatConfiguration)),
        DynamicWorkflowRpc.middleware(RendererConnectionMiddleware).toLayer(
          dynamicWorkflowHandlers,
        ),
        RendererConnectionMiddlewareLive,
      ),
    ),
  );
};
