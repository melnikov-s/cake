import { dictationHandlers } from "./DictationHandlers";
import { desktopHostHandlers } from "./DesktopHostHandlers";
import { backendConnectionHandlers } from "./BackendConnectionHandlers";
import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { CakeRpc } from "../protocol/CakeRpc";
import { RendererConnectionMiddlewareLive } from "../protocol/RendererConnectionMiddleware";
import { applicationStateHandlers } from "./ApplicationStateHandlers";
import { artifactHandlers } from "./ArtifactHandlers";
import { attachmentUploadHandlers } from "./AttachmentUploadHandlers";
import { browserHandlers } from "./BrowserHandlers";
import { browserResponseHandlers } from "./BrowserResponseHandlers";
import type { CakeChatRuntimeConfiguration } from "../../domain/cake-chats/cakeChatRuntime";
import { makeCakeChatHandlers } from "./CakeChatHandlers";
import { makeConversationHandlers } from "./ConversationHandlers";
import { discussionHandlers } from "./DiscussionHandlers";
import { drawHandlers } from "./DrawHandlers";
import { drawControlHandlers } from "./DrawControlHandlers";
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
import { piSettingsHandlers } from "./PiSettingsHandlers";
import { projectSessionHandlers } from "./ProjectSessionHandlers";
import { projectWorkflowHandlers } from "./ProjectWorkflowHandlers";
import { scheduledMessageHandlers } from "./ScheduledMessageHandlers";
import { savedDraftHandlers } from "./SavedDraftHandlers";
import { sessionChatHandlers } from "./SessionChatHandlers";
import { subagentHandlers } from "./SubagentHandlers";
import { terminalHandlers } from "./TerminalHandlers";
import { vscodeHandlers, vscodeViewHandlers } from "./VsCodeHandlers";
import { workspaceHandlers } from "./WorkspaceHandlers";

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
  const handlers = CakeRpc.toLayer({
    ...dictationHandlers,
    ...desktopHostHandlers,
    ...backendConnectionHandlers,
    ...applicationStateHandlers,
    ...artifactHandlers,
    ...attachmentUploadHandlers,
    ...browserHandlers,
    ...browserResponseHandlers,
    ...makeCakeChatHandlers(cakeChatConfiguration),
    ...makeConversationHandlers(cakeChatConfiguration),
    ...discussionHandlers,
    ...drawHandlers,
    ...drawControlHandlers,
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
    ...projectSessionHandlers,
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
  }).pipe(Layer.provide(Layer.merge(handlers, RendererConnectionMiddlewareLive)));
};
