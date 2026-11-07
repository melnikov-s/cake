import { backendAgentSettingsTools } from "../../contracts/application/agent-settings-tools";
import { backendAgentTools } from "../../contracts/application/backend-agent-tools";
import type { CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { AgentControlSource, AppControlHost } from "./app-control-data";
import { appControlRegistry } from "./app-control-registry";
import type { ControlContext } from "./control-definition";
import { agentActionReceipt } from "./control-receipts";
import { toJsonValue } from "./control-json";

// Discovery definitions are immutable for this renderer process. Compile their schemas once.
let globalTools: CakeControlTool[] | undefined;
let assistantTools: CakeControlTool[] | undefined;

export function listAppControlTools() {
  return (globalTools ??= [
    ...backendAgentTools(),
    ...backendAgentSettingsTools(),
    ...appControlRegistry.listTools("global"),
  ]);
}

export function listSessionAssistantControlTools() {
  return (assistantTools ??= [
    ...backendAgentTools(),
    ...backendAgentSettingsTools(),
    ...appControlRegistry.listTools("session-assistant"),
  ]);
}

export class AppControlBridge {
  constructor(private readonly host: AppControlHost) {}

  listTools() {
    return listAppControlTools();
  }

  supports(command: string): boolean {
    return appControlRegistry.has(command);
  }

  async invoke(untrustedInput: unknown, source?: AgentControlSource): Promise<JsonValue> {
    const context: ControlContext = { host: this.host };
    if (source) context.source = source;
    const execution = await appControlRegistry.invoke(untrustedInput, context);
    if ("value" in execution) return execution.value;
    const { result } = execution;
    if (source && result.ok && result.command !== "notifications.send") {
      const receipt = agentActionReceipt(this.host, result, source);
      if (receipt) this.host.presentation.showAgentAction({ source, ...receipt });
    }
    return toJsonValue(result);
  }
}
