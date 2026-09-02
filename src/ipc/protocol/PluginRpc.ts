import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { customizationStateSchema } from "../../plugin/plugin-contract";
import { PluginRuntimeError } from "../../services/plugins/PluginRuntime";
import {
  pluginEventSchema,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../cake-rpc-contract";

type PluginOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
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
  | "customization-runtime-failed"
>;

const pluginRpc = <Type extends PluginOperation>(type: Type) =>
  Rpc.make(`plugins.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: PluginRuntimeError,
  });

export const PluginRpc = RpcGroup.make(
  pluginRpc("get-customization-state"),
  Rpc.make("plugins.observeCustomization", {
    success: customizationStateSchema,
    stream: true,
  }),
  pluginRpc("get-plugin-authoring-reference"),
  pluginRpc("list-plugin-files"),
  pluginRpc("create-plugin"),
  pluginRpc("read-plugin-file"),
  pluginRpc("write-plugin-file"),
  pluginRpc("validate-customization"),
  pluginRpc("activate-customization"),
  pluginRpc("rollback-customization"),
  pluginRpc("use-factory-customization"),
  pluginRpc("list-plugins"),
  pluginRpc("set-plugin-enabled"),
  pluginRpc("set-active-scene"),
  pluginRpc("delete-plugin"),
  pluginRpc("compile-inline-widget"),
  pluginRpc("repair-inline-widget"),
  pluginRpc("open-plugin-agent"),
  pluginRpc("prompt-plugin-agent"),
  pluginRpc("abort-plugin-agent"),
  pluginRpc("detach-plugin-agent"),
  pluginRpc("run-plugin-completion"),
  pluginRpc("cancel-plugin-completion"),
  pluginRpc("load-plugin-state"),
  pluginRpc("save-plugin-state"),
  pluginRpc("call-plugin-backend"),
  pluginRpc("cancel-plugin-backend-call"),
  pluginRpc("customization-rendered"),
  pluginRpc("customization-runtime-failed"),
  Rpc.make("plugins.observeEvents", { success: pluginEventSchema, stream: true }),
);
