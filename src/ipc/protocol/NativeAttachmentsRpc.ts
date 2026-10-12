import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { WorkspaceFileError } from "../../contracts/filesystem/workspace-files-errors";
import {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";

export const NativeAttachmentsRpc = RpcGroup.make(
  Rpc.make("filesystem.read-selected-file", {
    payload: cakeRpcPayloadSchemas["read-selected-file"],
    success: cakeRpcSuccessSchemas["read-selected-file"],
    error: WorkspaceFileError,
  }),
  Rpc.make("filesystem.choose-attachments", {
    payload: cakeRpcPayloadSchemas["choose-attachments"],
    success: cakeRpcSuccessSchemas["choose-attachments"],
    error: WorkspaceFileError,
  }),
);
