import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { VsCodeServerError } from "../../services/vscode/VsCodeServer";
import {
  embeddedEditorEventSchema,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../cake-rpc-contract";

type VsCodeOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  | "get-embedded-editor-state"
  | "set-vscode-server-path"
  | "install-embedded-editor"
  | "open-embedded-editor"
  | "update-embedded-editor-bounds"
  | "reveal-in-embedded-editor"
  | "open-embedded-editor-source-control"
  | "update-embedded-editor-annotations"
>;

const vscodeRpc = <Type extends VsCodeOperation>(type: Type) =>
  Rpc.make(`vscode.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: VsCodeServerError,
  });

export const VsCodeRpc = RpcGroup.make(
  vscodeRpc("get-embedded-editor-state"),
  Rpc.make("vscode.observeState", {
    success: cakeRpcSuccessSchemas["get-embedded-editor-state"],
    stream: true,
  }),
  vscodeRpc("set-vscode-server-path"),
  vscodeRpc("install-embedded-editor"),
  vscodeRpc("open-embedded-editor"),
  vscodeRpc("update-embedded-editor-bounds"),
  vscodeRpc("reveal-in-embedded-editor"),
  vscodeRpc("open-embedded-editor-source-control"),
  vscodeRpc("update-embedded-editor-annotations"),
  Rpc.make("vscode.observeEvents", { success: embeddedEditorEventSchema, stream: true }),
);
