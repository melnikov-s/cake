import { loadMcpSettings, mutateMcpSettings } from "../../domain/mcp/mcp-settings";
import { McpSettingsRpc } from "../protocol/McpSettingsRpc";
export const mcpSettingsHandlers = McpSettingsRpc.of({
  "mcpSettings.get": loadMcpSettings,
  "mcpSettings.mutate": mutateMcpSettings,
});
