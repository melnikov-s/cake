import { Context, Schema, type Effect, type Stream } from "effect";
import type { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../../ipc/cake-rpc-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { SourceLocation } from "../../ipc/source-location";

type Payload<Type extends keyof typeof cakeRpcPayloadSchemas> =
  (typeof cakeRpcPayloadSchemas)[Type]["Type"];
type Success<Type extends keyof typeof cakeRpcSuccessSchemas> =
  (typeof cakeRpcSuccessSchemas)[Type]["Type"];

export class VsCodeServerError extends Schema.TaggedError<VsCodeServerError>()(
  "VsCodeServerError",
  { operation: Schema.String, message: Schema.String },
) {}

export type VscodeActionResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "mode-required" };

export interface VsCodeServerService {
  readonly state: () => Effect.Effect<Success<"get-embedded-editor-state">>;
  readonly stateChanges: () => Stream.Stream<Success<"get-embedded-editor-state">>;
  readonly refreshStatus: () => Effect.Effect<void, VsCodeServerError>;
  readonly install: (
    request: Payload<"install-embedded-editor">,
  ) => Effect.Effect<Success<"install-embedded-editor">, VsCodeServerError>;
  readonly open: (
    connectionId: number,
    request: Payload<"open-embedded-editor">,
  ) => Effect.Effect<Success<"open-embedded-editor">, VsCodeServerError>;
  readonly updateBounds: (
    connectionId: number,
    request: Payload<"update-embedded-editor-bounds">,
  ) => Effect.Effect<Success<"update-embedded-editor-bounds">, VsCodeServerError>;
  readonly reveal: (
    request: Payload<"reveal-in-embedded-editor">,
  ) => Effect.Effect<Success<"reveal-in-embedded-editor">, VsCodeServerError>;
  readonly openSourceControl: (
    request: Payload<"open-embedded-editor-source-control">,
  ) => Effect.Effect<Success<"open-embedded-editor-source-control">, VsCodeServerError>;
  readonly updateAnnotations: (
    request: Payload<"update-embedded-editor-annotations">,
  ) => Effect.Effect<Success<"update-embedded-editor-annotations">, VsCodeServerError>;
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
  readonly backToAgentForWindow: (ownerId: number) => Effect.Effect<boolean>;
  readonly updateTheme: () => Effect.Effect<void, VsCodeServerError>;
}

/** Owns openvscode-server processes, native editor views, and companion-extension traffic. */
export class VsCodeServer extends Context.Service<VsCodeServer, VsCodeServerService>()(
  "cake/services/vscode/VsCodeServer",
) {}
