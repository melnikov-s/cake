import type { JsonValue } from "../../ipc/json-contract";
import type { AgentControlSource, AppControlHost, AppControlState } from "./app-control-data";
import { appControlRegistry } from "./app-control-registry";
import type { ControlContext } from "./control-definition";
import { getAppState } from "./control-projections";
import { agentActionReceipt } from "./control-receipts";
import { toJsonValue } from "./control-json";

export function listAppControlTools() {
  return appControlRegistry.listTools("global");
}

export function listSessionAssistantControlTools() {
  return appControlRegistry.listTools("session-assistant");
}

export class AppControlBridge {
  constructor(private readonly host: AppControlHost) {}

  listTools() {
    return listAppControlTools();
  }

  getAppState(source?: AgentControlSource): AppControlState {
    return getAppState(this.host, source);
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
