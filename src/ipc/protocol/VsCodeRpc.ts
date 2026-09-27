import { Schema } from "effect";
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

const EditorTheme = Schema.Literals(["light", "dark"]);
const leaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const workspacePath = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const endpoint = Schema.NonEmptyString.check(Schema.isMaxLength(8_192));
const requestId = Schema.String.check(Schema.isUUID());
export const EditorLease = Schema.Struct({
  id: leaseId,
  endpoint,
});
export interface EditorLease extends Schema.Schema.Type<typeof EditorLease> {}
export const AcquireEditor = Schema.Struct({
  requestId,
  workspacePath,
  theme: EditorTheme,
});
export const EditorEndpoint = Schema.Struct({
  workspacePath,
  url: endpoint,
  theme: EditorTheme,
});

const dimension = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }));
export const EditorBounds = Schema.Struct({
  requestId,
  visible: Schema.Boolean,
  x: Schema.Number,
  y: Schema.Number,
  width: dimension,
  height: dimension,
  projectSidebarWidth: dimension,
});

export const VsCodeViewRpc = RpcGroup.make(
  Rpc.make("vscodeViews.preferredTheme", { success: EditorTheme, error: VsCodeServerError }),
  Rpc.make("vscodeViews.open", { payload: EditorEndpoint, error: VsCodeServerError }),
  Rpc.make("vscodeViews.updateBounds", {
    payload: EditorBounds,
    error: VsCodeServerError,
  }),
  Rpc.make("vscodeViews.close", { error: VsCodeServerError }),
  Rpc.make("vscodeViews.focusCake", { error: VsCodeServerError }),
  Rpc.make("vscodeViews.observeThemes", { success: EditorTheme, stream: true }),
  Rpc.make("vscodeViews.observeEvents", { success: embeddedEditorEventSchema, stream: true }),
);

export const VsCodeRpc = RpcGroup.make(
  Rpc.make("vscode.acquire", {
    payload: AcquireEditor,
    success: EditorLease,
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.release", { payload: { leaseId } }),
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
