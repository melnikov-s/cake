import { vscodeHandlers } from "./VsCodeHandlers";
import { inlineWidgetHandlers } from "./InlineWidgetHandlers";
import { widgetCaptureResponseHandlers } from "./WidgetCaptureHandlers";
import { browserResponseHandlers } from "./BrowserResponseHandlers";
import { makeInlineWidgetsLive } from "../../services/widgets/InlineWidgetsLive";
import { publishInlineWidget } from "../../services/widgets/inline-widget-document-registry";
import { subagentHandlers } from "./SubagentHandlers";
import { discussionHandlers } from "./DiscussionHandlers";
import { managedWorktreeHandlers } from "./ManagedWorktreeHandlers";
import { terminalHandlers } from "./TerminalHandlers";
import { drawHandlers } from "./DrawHandlers";
import { backendConnectionHandlers } from "./BackendConnectionHandlers";
import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import type { CakeChatRuntimeConfiguration } from "../../domain/cake-chats/cakeChatRuntime";
import { BackendRpc } from "../protocol/BackendRpc";
import { RendererConnectionMiddlewareLive } from "../protocol/RendererConnectionMiddleware";
import { applicationStateHandlers } from "./ApplicationStateHandlers";
import { drawControlHandlers } from "./DrawControlHandlers";
import { artifactHandlers } from "./ArtifactHandlers";
import { makeCakeChatHandlers } from "./CakeChatHandlers";
import { makeConversationHandlers } from "./ConversationHandlers";
import { makeFoundationHandlers } from "./FoundationHandlers";
import { modelHandlers } from "./ModelHandlers";
import { piSettingsHandlers } from "./PiSettingsHandlers";
import { providerAuthHandlers } from "./ProviderAuthHandlers";
import { projectSessionHandlers } from "./ProjectSessionHandlers";
import { projectWorkflowHandlers } from "./ProjectWorkflowHandlers";
import { scheduledMessageHandlers } from "./ScheduledMessageHandlers";
import { savedDraftHandlers } from "./SavedDraftHandlers";
import { sessionChatHandlers } from "./SessionChatHandlers";
import { workspaceHandlers } from "./WorkspaceHandlers";
import { filesystemHandlers } from "./FilesystemHandlers";
import { attachmentUploadHandlers } from "./AttachmentUploadHandlers";

/** Acquires only the endpoint: the host supplies an already acquired backend and Protocol. */
export const makeBackendRpcServerLive = (
  homeDirectory: string,
  cakeChatConfiguration: CakeChatRuntimeConfiguration,
) => {
  const handlers = BackendRpc.toLayer({
    ...backendConnectionHandlers,
    ...vscodeHandlers,
    ...inlineWidgetHandlers,
    ...widgetCaptureResponseHandlers,
    ...browserResponseHandlers,
    ...drawHandlers,
    ...filesystemHandlers,
    ...attachmentUploadHandlers,
    ...terminalHandlers,
    ...managedWorktreeHandlers,
    ...discussionHandlers,
    ...subagentHandlers,

    ...applicationStateHandlers,
    ...artifactHandlers,
    ...drawControlHandlers,
    ...makeCakeChatHandlers(cakeChatConfiguration),
    ...makeConversationHandlers(cakeChatConfiguration),
    ...makeFoundationHandlers(homeDirectory),
    ...modelHandlers,
    ...piSettingsHandlers,
    ...providerAuthHandlers,
    ...projectSessionHandlers,
    ...projectWorkflowHandlers,
    ...scheduledMessageHandlers,
    ...savedDraftHandlers,
    ...sessionChatHandlers,
    ...workspaceHandlers,
  });
  return RpcServer.layer(BackendRpc, {
    spanPrefix: "BackendRpcServer",
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Layer.merge(
        handlers.pipe(Layer.provide(makeInlineWidgetsLive({ publish: publishInlineWidget }))),
        RendererConnectionMiddlewareLive,
      ),
    ),
  );
};
