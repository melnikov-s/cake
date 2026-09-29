import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ProjectError } from "../../domain/projects/project-error";
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
  workspaceRpc("workspaces.reword-composer-selection", "reword-composer-selection"),
  workspaceRpc("workspaces.generate-session-title", "generate-session-title"),
  workspaceRpc("workspaces.set-utility-model", "set-utility-model"),
  workspaceRpc("workspaces.set-cake-prompts", "set-cake-prompts"),
  workspaceRpc("workspaces.set-global-custom-instructions", "set-global-custom-instructions"),
  workspaceRpc("workspaces.load-staged-slash-commands", "load-staged-slash-commands"),
  workspaceRpc("workspaces.register-project", "register-project"),
  workspaceRpc("workspaces.rename-project", "rename-project"),
  workspaceRpc("workspaces.set-project-settings", "set-project-settings"),
  workspaceRpc("workspaces.remove-project", "remove-project"),
  workspaceRpc("workspaces.delete-session", "delete-session"),
  workspaceRpc("workspaces.set-session-unread", "set-session-unread"),
  workspaceRpc("workspaces.restart-pi", "restart-pi"),
  workspaceRpc("workspaces.inspect-workspace", "inspect-workspace"),
  workspaceRpc("workspaces.respond-workspace-trust", "respond-workspace-trust"),
);
