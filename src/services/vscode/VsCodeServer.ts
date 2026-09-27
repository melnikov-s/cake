import { Context, Schema, type Effect, type Stream } from "effect";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type { EditorLocation } from "../../ipc/editor-location";
import type { EditorSelectionHighlights, EditorSelectionReveal } from "../../ipc/editor-selection";
import type { JsonValue } from "../../ipc/json-contract";
import type { VscodeEditorAction } from "../../ipc/vscode-editor-action";
import type { VsCodeLease } from "./VsCodeServerRuntime";

interface EmbeddedEditorState {
  readonly status: "missing" | "downloading" | "starting" | "ready" | "failed";
  readonly message?: string;
  readonly customPath?: string;
}
interface RequestIdentity {
  readonly requestId: string;
}
interface WorkspaceRequest extends RequestIdentity {
  readonly workspacePath: string;
}

export class VsCodeServerError extends Schema.TaggedError<VsCodeServerError>()(
  "VsCodeServerError",
  { operation: Schema.String, message: Schema.String },
) {}
export type VscodeActionResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "mode-required" };

/** Backend-owned process, install, companion and exclusive desktop lease authority. */
export class VsCodeServer extends Context.Service<
  VsCodeServer,
  {
    readonly state: () => Effect.Effect<EmbeddedEditorState>;
    readonly stateChanges: () => Stream.Stream<EmbeddedEditorState>;
    readonly refreshStatus: () => Effect.Effect<void, VsCodeServerError>;
    readonly install: (
      request: RequestIdentity,
    ) => Effect.Effect<RequestIdentity, VsCodeServerError>;
    readonly acquire: (
      connectionId: number,
      request: WorkspaceRequest & { readonly theme: "light" | "dark" },
    ) => Effect.Effect<VsCodeLease, VsCodeServerError>;
    readonly leaseFor: (connectionId: number) => VsCodeLease | undefined;
    readonly releaseConnection: (connectionId: number) => Effect.Effect<void>;
    readonly releaseLease: (connectionId: number, leaseId: string) => Effect.Effect<void>;
    readonly setVisible: (connectionId: number, visible: boolean) => Effect.Effect<void>;
    readonly setTheme: (
      connectionId: number,
      theme: "light" | "dark",
    ) => Effect.Effect<void, VsCodeServerError>;
    readonly reveal: (
      connectionId: number,
      request: WorkspaceRequest & { readonly location: EditorLocation },
    ) => Effect.Effect<
      RequestIdentity & { readonly reveal: EditorSelectionReveal },
      VsCodeServerError
    >;
    readonly updateSelectionHighlights: (
      connectionId: number,
      request: WorkspaceRequest & { readonly highlights: EditorSelectionHighlights },
    ) => Effect.Effect<RequestIdentity, VsCodeServerError>;
    readonly openSourceControl: (
      connectionId: number,
      request: WorkspaceRequest,
    ) => Effect.Effect<RequestIdentity, VsCodeServerError>;
    readonly performEditorAction: (
      connectionId: number,
      request: WorkspaceRequest & { readonly action: VscodeEditorAction },
    ) => Effect.Effect<RequestIdentity & { readonly result: JsonValue }, VsCodeServerError>;
    readonly updateAnnotations: (
      connectionId: number,
      request: WorkspaceRequest & { readonly snapshot: EditorAnnotationSnapshot },
    ) => Effect.Effect<RequestIdentity, VsCodeServerError>;
    readonly runProjectScript: (
      workingDirectory: string,
      source: string,
      input: JsonValue,
    ) => Effect.Effect<VscodeActionResult<JsonValue>, VsCodeServerError>;
  }
>()("cake/services/vscode/VsCodeServer") {}
