import { Schema } from "effect";
import {
  AgentSettingsInvocation,
  agentSettingsOperations,
} from "../../contracts/application/agent-settings-schema";
import {
  agentSettingsTool,
  isBackendAgentSetting,
} from "../../contracts/application/agent-settings-tools";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";
import type { RegisteredControl } from "./control-definition";

/** Only device/window execution belongs here; backend discovery is shared data. */
export const agentSettingsControls: RegisteredControl[] = agentSettingsOperations
  .filter((definition) => !isBackendAgentSetting(definition.command))
  .map((definition) => ({
    command: definition.command,
    scope: "global",
    tool: () => agentSettingsTool(definition),
    async invoke(untrustedInput, { host, source }) {
      const invocation = await Schema.decodeUnknownPromise(AgentSettingsInvocation)(
        untrustedInput,
        { onExcessProperty: "error" },
      );
      const value = await host.agentSettings.invoke(invocation, source);
      return {
        value: await Schema.decodeUnknownPromise(jsonValueSchema)(
          JSON.parse(JSON.stringify({ ok: true, command: invocation.name, value })),
        ),
      };
    },
  }));
