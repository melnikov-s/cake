import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { AttachmentUploadError } from "../../contracts/filesystem/attachment-uploads-errors";
import {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";

export const AttachmentUploadRpc = RpcGroup.make(
  Rpc.make("attachmentUploads.open", {
    payload: cakeRpcPayloadSchemas["upload-open"],
    success: cakeRpcSuccessSchemas["upload-open"],
    error: AttachmentUploadError,
  }),
  Rpc.make("attachmentUploads.chunk", {
    payload: cakeRpcPayloadSchemas["upload-chunk"],
    success: cakeRpcSuccessSchemas["upload-chunk"],
    error: AttachmentUploadError,
  }),
  Rpc.make("attachmentUploads.finish", {
    payload: cakeRpcPayloadSchemas["upload-finish"],
    success: cakeRpcSuccessSchemas["upload-finish"],
    error: AttachmentUploadError,
  }),
  Rpc.make("attachmentUploads.discard", {
    payload: cakeRpcPayloadSchemas["upload-discard"],
    success: cakeRpcSuccessSchemas["upload-discard"],
    error: AttachmentUploadError,
  }),
);
