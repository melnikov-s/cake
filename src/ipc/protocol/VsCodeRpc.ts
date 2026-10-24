import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { VsCodeServerError } from "../../contracts/vscode/vs-code-server-errors";
import {
  AcquireEditor,
  EditorBounds,
  EditorEndpoint,
  EditorLease,
  EditorLeaseId,
  EditorTheme,
} from "../../contracts/vscode/editor-endpoint";
import {
  embeddedEditorEventSchema,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";

type VsCodeOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  | "get-embedded-editor-state"
  | "set-vscode-server-path"
  | "install-embedded-editor"
  | "reveal-in-embedded-editor"
  | "open-embedded-editor-source-control"
  | "perform-embedded-editor-action"
  | "update-embedded-editor-annotations"
  | "update-embedded-editor-selection-highlights"
>;

const vscodeRpc = <Type extends VsCodeOperation>(type: Type) =>
  Rpc.make(`vscode.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: VsCodeServerError,
  });

export const VsCodeViewRpc = RpcGroup.make(
  Rpc.make("vscodeViews.open", { payload: EditorEndpoint, error: VsCodeServerError }),
  Rpc.make("vscodeViews.updateBounds", {
    payload: EditorBounds,
    error: VsCodeServerError,
  }),
  Rpc.make("vscodeViews.close", { error: VsCodeServerError }),
  Rpc.make("vscodeViews.focusCake", { error: VsCodeServerError }),
  Rpc.make("vscodeViews.observeEvents", { success: embeddedEditorEventSchema, stream: true }),
);

export const VsCodeRpc = RpcGroup.make(
  Rpc.make("vscode.acquire", {
    payload: AcquireEditor,
    success: EditorLease,
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.release", { payload: { leaseId: EditorLeaseId } }),
  Rpc.make("vscode.setVisible", { payload: { visible: Schema.Boolean } }),
  Rpc.make("vscode.setTheme", { payload: { theme: EditorTheme }, error: VsCodeServerError }),
  vscodeRpc("get-embedded-editor-state"),
  Rpc.make("vscode.observeState", {
    success: cakeRpcSuccessSchemas["get-embedded-editor-state"],
    stream: true,
  }),
  vscodeRpc("set-vscode-server-path"),
  vscodeRpc("install-embedded-editor"),
  vscodeRpc("reveal-in-embedded-editor"),
  vscodeRpc("open-embedded-editor-source-control"),
  vscodeRpc("perform-embedded-editor-action"),
  vscodeRpc("update-embedded-editor-annotations"),
  vscodeRpc("update-embedded-editor-selection-highlights"),
  Rpc.make("vscode.observeEvents", { success: embeddedEditorEventSchema, stream: true }),
);
