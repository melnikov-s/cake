import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  LocalMcpConfiguration,
  LocalMcpSnapshot,
  LocalMcpError,
} from "../../contracts/mcp/local-mcp";
import {
  McpSettingsRead,
  McpSettingsMutation,
  McpSettingsSnapshot,
  McpSettingsError,
} from "../../contracts/pi/mcp-settings-data";
export const McpSettingsRpc = RpcGroup.make(
  Rpc.make("mcpSettings.serverGet", {
    payload: Schema.Struct({}),
    success: LocalMcpSnapshot,
    error: LocalMcpError,
  }),
  Rpc.make("mcpSettings.serverConfigure", {
    payload: LocalMcpConfiguration,
    success: LocalMcpSnapshot,
    error: LocalMcpError,
  }),
  Rpc.make("mcpSettings.serverRotateToken", {
    payload: Schema.Struct({}),
    success: LocalMcpSnapshot,
    error: LocalMcpError,
  }),
  Rpc.make("mcpSettings.get", {
    payload: McpSettingsRead,
    success: McpSettingsSnapshot,
    error: McpSettingsError,
  }),
  Rpc.make("mcpSettings.mutate", {
    payload: McpSettingsMutation,
    success: McpSettingsSnapshot,
    error: McpSettingsError,
  }),
);
