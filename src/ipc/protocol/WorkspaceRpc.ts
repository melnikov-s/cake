import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ProjectError } from "../../domain/project-error";
import { WorkspaceFileError } from "../../services/filesystem/WorkspaceFiles";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

const workspaceRpc = <Type extends keyof typeof cakeRpcPayloadSchemas>(
  tag: `workspaces.${Type}`,
  type: Type,
) =>
  Rpc.make(tag, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: ProjectError,
  });

export const WorkspaceRpc = RpcGroup.make(
  Rpc.make("filesystem.choose-attachments", {
    payload: cakeRpcPayloadSchemas["choose-attachments"],
    success: cakeRpcSuccessSchemas["choose-attachments"],
    error: WorkspaceFileError,
  }),
  Rpc.make("filesystem.suggest-files", {
    payload: cakeRpcPayloadSchemas["suggest-files"],
    success: cakeRpcSuccessSchemas["suggest-files"],
    error: WorkspaceFileError,
  }),
  Rpc.make("filesystem.read-workspace-file", {
    payload: cakeRpcPayloadSchemas["read-workspace-file"],
    success: cakeRpcSuccessSchemas["read-workspace-file"],
    error: WorkspaceFileError,
  }),
  workspaceRpc("workspaces.reword-composer-selection", "reword-composer-selection"),
  workspaceRpc("workspaces.generate-session-title", "generate-session-title"),
  workspaceRpc("workspaces.set-utility-model", "set-utility-model"),
  workspaceRpc("workspaces.register-project", "register-project"),
  workspaceRpc("workspaces.rename-project", "rename-project"),
  workspaceRpc("workspaces.remove-project", "remove-project"),
  workspaceRpc("workspaces.delete-session", "delete-session"),
  workspaceRpc("workspaces.set-session-unread", "set-session-unread"),
  workspaceRpc("workspaces.restart-pi", "restart-pi"),
  workspaceRpc("workspaces.inspect-workspace", "inspect-workspace"),
  workspaceRpc("workspaces.respond-workspace-trust", "respond-workspace-trust"),
);
