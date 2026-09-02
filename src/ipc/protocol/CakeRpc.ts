import { ApplicationRpc } from "./ApplicationRpc";
import { ArtifactRpc } from "./ArtifactRpc";
import { CakeChatRpc } from "./CakeChatRpc";
import { DiscussionRpc } from "./DiscussionRpc";
import { ElectronRpc } from "./ElectronRpc";
import { FoundationRpc } from "./FoundationRpc";
import { ManagedWorktreeRpc } from "./ManagedWorktreeRpc";
import { ModelRpc } from "./ModelRpc";
import { PluginRpc } from "./PluginRpc";
import { ProjectSessionRpc } from "./ProjectSessionRpc";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";
import { SubagentRpc } from "./SubagentRpc";
import { TerminalRpc } from "./TerminalRpc";
import { VsCodeRpc } from "./VsCodeRpc";
import { WorkspaceRpc } from "./WorkspaceRpc";

export { FoundationFailure } from "./FoundationRpc";

export const CakeRpc = ApplicationRpc.merge(
  ArtifactRpc,
  CakeChatRpc,
  DiscussionRpc,
  ElectronRpc,
  FoundationRpc,
  ManagedWorktreeRpc,
  ModelRpc,
  PluginRpc,
  ProjectSessionRpc,
  SubagentRpc,
  TerminalRpc,
  VsCodeRpc,
  WorkspaceRpc,
).middleware(RendererConnectionMiddleware);
