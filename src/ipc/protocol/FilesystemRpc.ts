import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { WorkspaceFileError } from "../../services/filesystem/WorkspaceFiles";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

/** Workspace presentation executes only on the backend with ProjectAccess. */
export const FilesystemRpc = RpcGroup.make(
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
  Rpc.make("filesystem.read-workspace-image", {
    payload: cakeRpcPayloadSchemas["read-workspace-image"],
    success: cakeRpcSuccessSchemas["read-workspace-image"],
    error: WorkspaceFileError,
  }),
);
