import { loadMcpSettings, mutateMcpSettings } from "../../domain/mcp/mcp-settings";
import { McpSettingsRpc } from "../protocol/McpSettingsRpc";
import * as localMcp from "../../domain/mcp/localMcp";
export const mcpSettingsHandlers = McpSettingsRpc.of({
  "mcpSettings.serverGet": localMcp.get,
  "mcpSettings.serverConfigure": localMcp.configure,
  "mcpSettings.serverRotateToken": localMcp.rotateToken,
  "mcpSettings.get": loadMcpSettings,
  "mcpSettings.mutate": mutateMcpSettings,
});
