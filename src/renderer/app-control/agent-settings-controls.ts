import { Schema } from "effect";
import {
  AgentSettingsInvocation,
  agentSettingsOperations,
  agentSettingsGuidance,
} from "../../contracts/application/agent-settings-schema";
import { CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";
import type { RegisteredControl } from "./control-definition";
/** Shared settings schemas/discovery stay data-only. Execution uses this window's host. */
export const agentSettingsControls: RegisteredControl[] = agentSettingsOperations.map(
  (definition) => ({
    command: definition.command,
    scope: "global",
    tool: () =>
      Schema.decodeUnknownSync(CakeControlTool)({
        command: definition.command,
        topic: "settings",
        summary: definition.summary,
        parameters: Schema.toStandardJSONSchemaV1(definition.input)["~standard"].jsonSchema.input({
          target: "draft-07",
        }),
        guidance: [...agentSettingsGuidance, ...definition.guidance],
        examples: [{ input: definition.example }],
        result: "The existing Settings service's result; credentials remain masked.",
      }),
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
  }),
);
