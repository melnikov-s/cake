import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  McpSettingsRead,
  McpSettingsMutation,
  McpSettingsSnapshot,
  McpSettingsError,
} from "../../contracts/pi/mcp-settings-data";
export const McpSettingsRpc = RpcGroup.make(
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
