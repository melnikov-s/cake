import { Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import { CakeRpc } from "../protocol/CakeRpc";
import { RendererConnectionMiddlewareLive } from "../protocol/RendererConnectionMiddleware";
import { ElectronRpcServerProtocolLive } from "../transport/ElectronRpcServerProtocol";
import { applicationStateHandlers } from "./ApplicationStateHandlers";
import { artifactHandlers } from "./ArtifactHandlers";
import { cakeChatHandlers } from "./CakeChatHandlers";
import { discussionHandlers } from "./DiscussionHandlers";
import { electronHandlers } from "./ElectronHandlers";
import { makeFoundationHandlers } from "./FoundationHandlers";
import { managedWorktreeHandlers } from "./ManagedWorktreeHandlers";
import { modelHandlers } from "./ModelHandlers";
import { pluginHandlers } from "./PluginHandlers";
import { projectSessionHandlers } from "./ProjectSessionHandlers";
import { subagentHandlers } from "./SubagentHandlers";
import { terminalHandlers } from "./TerminalHandlers";
import { vscodeHandlers } from "./VsCodeHandlers";
import { workspaceHandlers } from "./WorkspaceHandlers";

export const makeCakeIpcServerLive = (homeDirectory: string) => {
  const handlers = CakeRpc.toLayer({
    ...applicationStateHandlers,
    ...artifactHandlers,
    ...cakeChatHandlers,
    ...discussionHandlers,
    ...electronHandlers,
    ...makeFoundationHandlers(homeDirectory),
    ...managedWorktreeHandlers,
    ...modelHandlers,
    ...pluginHandlers,
    ...projectSessionHandlers,
    ...subagentHandlers,
    ...terminalHandlers,
    ...vscodeHandlers,
    ...workspaceHandlers,
  });

  return RpcServer.layer(CakeRpc, { spanPrefix: "CakeIpcServer" }).pipe(
    Layer.provide(
      Layer.mergeAll(handlers, RendererConnectionMiddlewareLive, ElectronRpcServerProtocolLive),
    ),
  );
};
