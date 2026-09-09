import { Context, Schema, type Effect, type Stream } from "effect";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type { JsonValue } from "../../ipc/json-contract";
import type { SourceLocation } from "../../ipc/source-location";

interface EmbeddedEditorState {
  readonly status: "missing" | "downloading" | "starting" | "ready" | "failed";
  readonly message?: string;
  readonly customPath?: string;
}

interface EmbeddedEditorRequestIdentity {
  readonly requestId: string;
}

interface OpenEmbeddedEditorInput extends EmbeddedEditorRequestIdentity {
  readonly workspacePath: string;
}

interface UpdateEmbeddedEditorBoundsInput extends EmbeddedEditorRequestIdentity {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly projectSidebarWidth: number;
}

interface RevealInEmbeddedEditorInput extends OpenEmbeddedEditorInput {
  readonly location: SourceLocation;
}

interface UpdateEmbeddedEditorAnnotationsInput extends OpenEmbeddedEditorInput {
  readonly snapshot: EditorAnnotationSnapshot;
}

export class VsCodeServerError extends Schema.TaggedError<VsCodeServerError>()(
  "VsCodeServerError",
  { operation: Schema.String, message: Schema.String },
) {}

export type VscodeActionResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "mode-required" };

export interface VsCodeServerService {
  readonly state: () => Effect.Effect<EmbeddedEditorState>;
  readonly stateChanges: () => Stream.Stream<EmbeddedEditorState>;
  readonly refreshStatus: () => Effect.Effect<void, VsCodeServerError>;
  readonly install: (
    request: EmbeddedEditorRequestIdentity,
  ) => Effect.Effect<EmbeddedEditorRequestIdentity, VsCodeServerError>;
  readonly open: (
    connectionId: number,
    request: OpenEmbeddedEditorInput,
  ) => Effect.Effect<EmbeddedEditorRequestIdentity, VsCodeServerError>;
  readonly updateBounds: (
    connectionId: number,
    request: UpdateEmbeddedEditorBoundsInput,
  ) => Effect.Effect<EmbeddedEditorRequestIdentity, VsCodeServerError>;
  readonly reveal: (
    request: RevealInEmbeddedEditorInput,
  ) => Effect.Effect<EmbeddedEditorRequestIdentity, VsCodeServerError>;
  readonly openSourceControl: (
    request: OpenEmbeddedEditorInput,
  ) => Effect.Effect<EmbeddedEditorRequestIdentity, VsCodeServerError>;
  readonly updateAnnotations: (
    request: UpdateEmbeddedEditorAnnotationsInput,
  ) => Effect.Effect<EmbeddedEditorRequestIdentity, VsCodeServerError>;
  readonly enterProjectEditor: (workingDirectory: string) => Effect.Effect<void, VsCodeServerError>;
  readonly openProjectLocation: (
    workingDirectory: string,
    location: SourceLocation,
  ) => Effect.Effect<VscodeActionResult<SourceLocation>, VsCodeServerError>;
  readonly runProjectScript: (
    workingDirectory: string,
    source: string,
    input: JsonValue,
  ) => Effect.Effect<VscodeActionResult<JsonValue>, VsCodeServerError>;
  readonly closeForWindow: (ownerId: number) => Effect.Effect<void>;
  /** Immediate native close-veto callback; Electron requires the boolean synchronously. */
  readonly backToAgentForWindow: (ownerId: number) => boolean;
  readonly updateTheme: () => Effect.Effect<void, VsCodeServerError>;
}

/** Owns openvscode-server processes, native editor views, and companion-extension traffic. */
export class VsCodeServer extends Context.Service<VsCodeServer, VsCodeServerService>()(
  "cake/services/vscode/VsCodeServer",
) {}
