import { Context, Schema, type Effect } from "effect";
import type { StartupRenderer } from "./plugin-activation-service";
import type { PluginAgentResources } from "./PluginHost";
import type {
  nativeOperationPayloadSchemas,
  nativeOperationSuccessSchemas,
} from "../../ipc/native-protocol";

type PluginOperation =
  | "get-customization-state"
  | "get-plugin-authoring-reference"
  | "list-plugin-files"
  | "create-plugin"
  | "read-plugin-file"
  | "write-plugin-file"
  | "validate-customization"
  | "activate-customization"
  | "rollback-customization"
  | "use-factory-customization"
  | "list-plugins"
  | "set-plugin-enabled"
  | "set-active-scene"
  | "delete-plugin"
  | "compile-inline-widget"
  | "repair-inline-widget"
  | "open-plugin-agent"
  | "prompt-plugin-agent"
  | "abort-plugin-agent"
  | "detach-plugin-agent"
  | "run-plugin-completion"
  | "cancel-plugin-completion"
  | "load-plugin-state"
  | "save-plugin-state"
  | "call-plugin-backend"
  | "cancel-plugin-backend-call"
  | "customization-rendered"
  | "customization-runtime-failed";

type PluginPayload<Type extends PluginOperation> =
  (typeof nativeOperationPayloadSchemas)[Type]["Type"];
type PluginSuccess<Type extends PluginOperation> =
  (typeof nativeOperationSuccessSchemas)[Type]["Type"];

export type PluginPromiseOperations = {
  readonly [Type in PluginOperation]: (
    connectionId: number,
    payload: PluginPayload<Type>,
  ) => Promise<PluginSuccess<Type>>;
};

export class PluginRuntimeError extends Schema.TaggedError<PluginRuntimeError>()(
  "PluginRuntimeError",
  { message: Schema.String },
) {}

export type PluginRuntimeOperations = {
  readonly [Type in PluginOperation]: (
    connectionId: number,
    payload: PluginPayload<Type>,
  ) => Effect.Effect<PluginSuccess<Type>, PluginRuntimeError>;
} & {
  readonly start: () => Effect.Effect<void, PluginRuntimeError>;
  readonly startupRenderer: () => StartupRenderer;
  readonly trackRenderer: (ownerId: number, renderer: StartupRenderer) => void;
  readonly rendererProcessGone: (ownerId: number, reason: string) => void;
  readonly disposeOwner: (ownerId: number) => void;
  readonly recoveryContext: () => string | undefined;
  readonly agentResources: () => PluginAgentResources;
};

export class PluginRuntime extends Context.Service<PluginRuntime, PluginRuntimeOperations>()(
  "cake/services/plugins/PluginRuntime",
) {}
