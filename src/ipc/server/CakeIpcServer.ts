import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { CakeRpc } from "../protocol/CakeRpc";
import { RendererConnectionMiddlewareLive } from "../protocol/RendererConnectionMiddleware";
import { ElectronRpcServerProtocolLive } from "../transport/ElectronRpcServerProtocol";
import { applicationStateHandlers } from "./ApplicationStateHandlers";
import { artifactHandlers } from "./ArtifactHandlers";
import type { CakeChatRuntimeConfiguration } from "../../domain/cakeChatRuntime";
import { makeCakeChatHandlers } from "./CakeChatHandlers";
import { discussionHandlers } from "./DiscussionHandlers";
import { electronHandlers } from "./ElectronHandlers";
import { makeFoundationHandlers } from "./FoundationHandlers";
import { inlineWidgetHandlers } from "./InlineWidgetHandlers";
import { managedWorktreeHandlers } from "./ManagedWorktreeHandlers";
import { modelHandlers } from "./ModelHandlers";
import { projectSessionHandlers } from "./ProjectSessionHandlers";
import { projectWorkflowHandlers } from "./ProjectWorkflowHandlers";
import { scheduledMessageHandlers } from "./ScheduledMessageHandlers";
import { subagentHandlers } from "./SubagentHandlers";
import { terminalHandlers } from "./TerminalHandlers";
import { vscodeHandlers } from "./VsCodeHandlers";
import { workspaceHandlers } from "./WorkspaceHandlers";

export const makeCakeIpcServerLive = (
  homeDirectory: string,
  cakeChatConfiguration: CakeChatRuntimeConfiguration,
) => {
  const handlers = CakeRpc.toLayer({
    ...applicationStateHandlers,
    ...artifactHandlers,
    ...makeCakeChatHandlers(cakeChatConfiguration),
    ...discussionHandlers,
    ...electronHandlers,
    ...makeFoundationHandlers(homeDirectory),
    ...inlineWidgetHandlers,
    ...managedWorktreeHandlers,
    ...modelHandlers,
    ...projectSessionHandlers,
    ...projectWorkflowHandlers,
    ...scheduledMessageHandlers,
    ...subagentHandlers,
    ...terminalHandlers,
    ...vscodeHandlers,
    ...workspaceHandlers,
  });

  return RpcServer.layer(CakeRpc, {
    spanPrefix: "CakeIpcServer",
    // A defect in one request must remain correlated with that request. Sending
    // it as a connection-wide fatal defect tears down every renderer Stream.
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(handlers, RendererConnectionMiddlewareLive, ElectronRpcServerProtocolLive),
    ),
  );
};
